import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

const b64url = (buf: Buffer) => buf.toString('base64url');

// Minimal CBOR: only the shapes WebAuthn needs (ints, text, bytes, maps).
function cbor(
  value: number | string | Buffer | Map<number | string, unknown>,
): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([head(2, value.length), value]);
  }
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v as any));
  return Buffer.concat(parts);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface AuthenticatorOptions {
  rpID: string;
  origin: string;
  userHandle: string;
  userVerified?: boolean;
  backedUp?: boolean;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;

  constructor(private readonly opts: AuthenticatorOptions) {}

  get id() {
    return b64url(this.credentialId);
  }

  private flags(attested: boolean) {
    let f = FLAG_UP;
    if (this.opts.userVerified !== false) f |= FLAG_UV;
    if (this.opts.backedUp) f |= FLAG_BE | FLAG_BS;
    if (attested) f |= FLAG_AT;
    return f;
  }

  private rpIdHash() {
    return createHash('sha256').update(this.opts.rpID).digest();
  }

  private header(attested: boolean) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([
      this.rpIdHash(),
      Buffer.from([this.flags(attested)]),
      counter,
    ]);
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.opts.origin,
        crossOrigin: false,
      }),
    );
  }

  private cosePublicKey() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  createRegistrationResponse(challenge: string) {
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.header(true),
      Buffer.alloc(16),
      credIdLen,
      this.credentialId,
      this.cosePublicKey(),
    ]);
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  createAssertion(challenge: string) {
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const authData = this.header(false);
    const signature = createSign('SHA256')
      .update(
        Buffer.concat([
          authData,
          createHash('sha256').update(clientDataJSON).digest(),
        ]),
      )
      .sign(this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from(this.opts.userHandle)),
      },
      clientExtensionResults: {},
    };
  }

  // The public key as the server stores it (COSE bytes).
  get storedPublicKey() {
    return this.cosePublicKey();
  }
}
