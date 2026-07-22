import crypto from 'node:crypto';

export const MUSHAF_JWT_AUD = 'alhelmi-mushaf';
export const MUSHAF_JWT_ISS = 'app.alhelmi.com';

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify HS256 JWT. Returns claims or null (OWASP A07 — fail closed).
 */
export function verifyHs256Jwt(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  if (!timingSafeEqualStr(signature, expected)) return null;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now >= payload.exp) return null;
    if (typeof payload.nbf === 'number' && now < payload.nbf) return null;
    return payload;
  } catch {
    return null;
  }
}

export function resolveMushafJwtSecret() {
  return (process.env.MUSHAF_JWT_SECRET || process.env.MUSHAF_SYNC_SECRET || '').trim();
}

export function assertMushafClaims(claims) {
  if (!claims || typeof claims !== 'object') return null;
  if (claims.aud !== MUSHAF_JWT_AUD) return null;
  if (claims.iss !== MUSHAF_JWT_ISS) return null;
  const room = String(claims.room || '').trim();
  const role = claims.role === 'teacher' ? 'teacher' : 'student';
  const sub = String(claims.sub || '').trim();
  if (!room || !sub) return null;
  return {
    room,
    role,
    userId: sub,
    name: String(claims.name || '').trim(),
    courseId: Number(claims.course_id) || null,
  };
}
