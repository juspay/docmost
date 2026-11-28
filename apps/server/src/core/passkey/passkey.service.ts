import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import PasskeyAddedEmail from '@docmost/transactional/emails/passkey-added-email';
import { User, UserPasskey, Workspace } from '@docmost/db/types/entity.types';
import { UserPasskeyRepo } from '@docmost/db/repos/passkey/user-passkey.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { SessionService } from '../session/session.service';
import { MailService } from '../../integrations/mail/mail.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { isAdminActingOnOwner } from '../workspace/workspace.util';
import { comparePasswordHash, isUserDisabled } from '../../common/helpers';
import {
  throwIfEmailNotVerified,
  validateSsoEnforcement,
} from '../auth/auth.util';

export const CHALLENGE_TTL_SECONDS = 300;
export const RECENT_SESSION_MS = 10 * 60 * 1000;
export const LOGIN_FAILED_MESSAGE = 'Passkey sign-in failed';

const RP_NAME = 'Docmost';

const regKey = (id: string) => `passkey:reg:${id}`;
const loginKey = (id: string) => `passkey:login:${id}`;

@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);

  constructor(
    private readonly passkeyRepo: UserPasskeyRepo,
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
    private readonly mailService: MailService,
    private readonly environmentService: EnvironmentService,
    private readonly redisService: RedisService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  relyingParty(): { rpID: string; origin: string; rpName: string } {
    const url = new URL(this.environmentService.getAppUrl());
    return { rpID: url.hostname, origin: url.origin, rpName: RP_NAME };
  }

  async registrationOptions(
    user: User,
    sessionCreatedAt: Date,
    currentPassword?: string,
  ) {
    await this.assertOwnerProof(user, sessionCreatedAt, currentPassword);

    const { rpID, rpName } = this.relyingParty();
    const existing = await this.passkeyRepo.findByUser(
      user.id,
      user.workspaceId,
    );

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    const challengeId = randomUUID();
    await this.redis().set(
      regKey(challengeId),
      JSON.stringify({ challenge: options.challenge, userId: user.id }),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return { challengeId, options };
  }

  async verifyRegistration(
    user: User,
    challengeId: string,
    response: unknown,
    name: string,
  ) {
    this.assertName(name);
    const stored = await this.takeChallenge(regKey(challengeId));
    if (!stored || stored.userId !== user.id) {
      throw new BadRequestException('The passkey request expired, try again');
    }

    const { rpID, origin } = this.relyingParty();
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err: any) {
      this.logger.debug(`passkey registration rejected: ${err?.message}`);
      throw new BadRequestException('The passkey could not be verified');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('The passkey could not be verified');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    let saved: UserPasskey;
    try {
      saved = await this.passkeyRepo.insert({
        userId: user.id,
        workspaceId: user.workspaceId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: (credential.transports ?? []) as string[],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: name.trim(),
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new BadRequestException('This passkey is already registered');
      }
      throw err;
    }

    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'A passkey was added to your account',
      template: PasskeyAddedEmail({
        username: user.name,
        passkeyName: saved.name,
        addedAt: new Date(saved.createdAt).toUTCString(),
      }),
    });
    this.logger.log(`passkey-added email queued for user ${user.id}`);

    this.auditService.log({
      event: AuditEvent.PASSKEY_ADDED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { passkeyId: saved.id, name: saved.name },
    });

    return { id: saved.id, name: saved.name, createdAt: saved.createdAt };
  }

  async loginOptions(workspaceId: string) {
    const { rpID } = this.relyingParty();
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
    });
    const challengeId = randomUUID();
    await this.redis().set(
      loginKey(challengeId),
      JSON.stringify({ challenge: options.challenge, workspaceId }),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return { challengeId, options };
  }

  // Every failure is the same 401 so the response never says which step refused.
  async verifyLogin(
    workspace: Workspace,
    challengeId: string,
    response: unknown,
  ): Promise<string> {
    const fail = () => new UnauthorizedException(LOGIN_FAILED_MESSAGE);
    try {
      const stored = await this.takeChallenge(loginKey(challengeId));
      if (!stored || stored.workspaceId !== workspace.id) throw fail();

      const credentialId = (response as AuthenticationResponseJSON)?.id;
      if (typeof credentialId !== 'string') throw fail();

      const passkey = await this.passkeyRepo.findByCredentialId(
        credentialId,
        workspace.id,
      );
      if (!passkey) throw fail();

      const user = await this.userRepo.findById(passkey.userId, workspace.id);
      if (!user) throw fail();

      const { rpID, origin } = this.relyingParty();
      const verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
      });
      if (!verification.verified) throw fail();

      // Ownership comes from passkey.userId; the user handle is an extra guard when present.
      const userHandle = (response as AuthenticationResponseJSON).response
        ?.userHandle;
      if (
        userHandle &&
        Buffer.from(userHandle, 'base64url').toString('utf8') !== user.id
      ) {
        throw fail();
      }

      validateSsoEnforcement(workspace);
      if (isUserDisabled(user)) throw fail();
      throwIfEmailNotVerified({
        isCloud: this.environmentService.isCloud(),
        emailVerifiedAt: user.emailVerifiedAt,
        email: user.email,
        workspaceId: workspace.id,
        appSecret: this.environmentService.getAppSecret(),
      });

      // Only reached after a valid assertion, so naming the cause leaks nothing.
      if (await this.secondFactorRequired(user, workspace)) {
        throw new UnauthorizedException('Sign in with your password');
      }

      await this.passkeyRepo.recordUse(
        passkey.id,
        verification.authenticationInfo.newCounter,
      );
      user.lastLoginAt = new Date();
      await this.userRepo.updateLastLogin(user.id, workspace.id);

      this.auditService.log({
        event: AuditEvent.USER_LOGIN,
        resourceType: AuditResource.USER,
        resourceId: user.id,
        metadata: { source: 'passkey' },
      });

      return await this.sessionService.createSessionAndToken(user);
    } catch (err: any) {
      if (
        err instanceof UnauthorizedException &&
        err.message === 'Sign in with your password'
      ) {
        throw err;
      }
      if (!(err instanceof UnauthorizedException)) {
        this.logger.debug(`passkey sign-in refused: ${err?.message}`);
      }
      throw fail();
    }
  }

  async list(user: User) {
    const rows = await this.passkeyRepo.findByUser(user.id, user.workspaceId);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      deviceType: p.deviceType,
      backedUp: p.backedUp,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
    }));
  }

  async rename(user: User, id: string, name: string) {
    this.assertName(name);
    const ok = await this.passkeyRepo.rename(
      id,
      user.id,
      user.workspaceId,
      name.trim(),
    );
    if (!ok) throw new NotFoundException('Passkey not found');
  }

  async remove(user: User, id: string) {
    const ok = await this.passkeyRepo.delete(id, user.id, user.workspaceId);
    if (!ok) throw new NotFoundException('Passkey not found');
    this.auditService.log({
      event: AuditEvent.PASSKEY_REMOVED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { passkeyId: id },
    });
  }

  async adminRemoveAll(admin: User, userId: string, workspaceId: string) {
    const target = await this.userRepo.findById(userId, workspaceId);
    if (!target) throw new NotFoundException('User not found');
    if (isAdminActingOnOwner(admin.role, target.role)) {
      throw new ForbiddenException(
        'You cannot remove the passkeys of a user with owner role',
      );
    }
    const removed = await this.passkeyRepo.deleteAllForUser(
      userId,
      workspaceId,
    );
    this.auditService.log({
      event: AuditEvent.PASSKEY_REMOVED,
      resourceType: AuditResource.USER,
      resourceId: userId,
      metadata: { removedBy: admin.id, count: removed },
    });
    return removed;
  }

  async deleteAllForUser(userId: string, workspaceId: string) {
    return this.passkeyRepo.deleteAllForUser(userId, workspaceId);
  }

  private async assertOwnerProof(
    user: User,
    sessionCreatedAt: Date,
    currentPassword?: string,
  ) {
    const withPassword = await this.userRepo.findById(
      user.id,
      user.workspaceId,
      { includePassword: true },
    );
    const hasUsablePassword =
      !!withPassword?.password && !withPassword.hasGeneratedPassword;

    if (!hasUsablePassword) {
      const age = Date.now() - new Date(sessionCreatedAt).getTime();
      if (age > RECENT_SESSION_MS) {
        throw new ForbiddenException('Sign in again to add a passkey');
      }
      return;
    }

    if (
      !currentPassword ||
      !(await comparePasswordHash(currentPassword, withPassword.password))
    ) {
      throw new BadRequestException('Current password is incorrect');
    }
  }

  private assertName(name: string) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new BadRequestException('Name is required');
    }
  }

  private async takeChallenge(
    key: string,
  ): Promise<Record<string, string> | null> {
    const raw = await this.redis().getdel(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private redis() {
    return this.redisService.getOrThrow();
  }

  // Decided from the workspace flag and the user's MFA row, so a passkey never
  // stands in for a second factor. Fails closed.
  private async secondFactorRequired(
    user: User,
    workspace: Workspace,
  ): Promise<boolean> {
    if (workspace.enforceMfa) return true;
    try {
      const withMfa = (await this.userRepo.findById(user.id, workspace.id, {
        includeUserMfa: true,
      })) as User & { mfa?: { isEnabled?: boolean | null } | null };
      return !withMfa || !!withMfa.mfa?.isEnabled;
    } catch (err: any) {
      this.logger.warn(`second factor lookup failed: ${err?.message}`);
      return true;
    }
  }
}
