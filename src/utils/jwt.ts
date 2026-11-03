import crypto from 'crypto';
import { config } from '../config';

/**
 * Minimal HS256 JWT, written against node:crypto rather than pulling in `jsonwebtoken`.
 *
 * The library's extra surface (asymmetric algorithms, `none`, key resolution callbacks) is
 * precisely where its historical CVEs live, and none of it is used here: one algorithm, one
 * symmetric secret, one issuer. The algorithm is checked against a constant before the
 * signature is verified, so an attacker cannot downgrade a token to `alg: none`.
 */

const ALG = 'HS256';

export interface SessionClaims {
  /** User document id. */
  sub: string;
  /** Telegram id, carried so common checks don't need a second lookup. */
  tg: number;
  /** Session id — lets a single session be traced through the audit log. */
  sid: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

export function signSession(claims: Omit<SessionClaims, 'iat' | 'exp'>, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(body));
  return `${head}.${payload}.${sign(`${head}.${payload}`)}`;
}

/** Returns the claims, or null for anything that is not a currently-valid token of ours. */
export function verifySession(token: string): SessionClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [head, payload, signature] = parts;

  let header: any;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // Checked before the signature so a forged `alg` never reaches the verification path.
  if (header?.alg !== ALG || header?.typ !== 'JWT') return null;

  const expected = sign(`${head}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) return null;
  if (!claims.sub || !claims.sid) return null;

  return claims;
}
