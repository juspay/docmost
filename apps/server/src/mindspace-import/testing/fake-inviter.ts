import { InviteEmailError, type Inviter } from '../invites';

/** Remembers invitations instead of sending them. */
export class FakeInviter implements Inviter {
  readonly sent: string[][] = [];

  /** invitations that exist but have expired */
  readonly expired = new Set<string>();

  constructor(
    readonly live = new Set<string>(),
    /** addresses whose email cannot be queued */
    readonly failing = new Set<string>(),
    /** addresses that could never accept, with docmost's reason */
    readonly blocked: Record<string, string> = {},
  ) {}

  acceptBlocker(email: string) {
    return this.blocked[email.toLowerCase()] ?? null;
  }

  async invitedEver(emails: string[]) {
    return new Set(
      emails.filter(
        (e) =>
          this.live.has(e.toLowerCase()) || this.expired.has(e.toLowerCase()),
      ),
    );
  }

  async pending(emails: string[]) {
    return new Set(emails.filter((e) => this.live.has(e.toLowerCase())));
  }

  async invite(emails: string[]) {
    this.sent.push([...emails]);
    for (const e of emails) this.live.add(e.toLowerCase());
    const failed = emails.filter((e) => this.failing.has(e));
    if (failed.length)
      throw new InviteEmailError(failed, new Error('Redis is down'));
  }
}
