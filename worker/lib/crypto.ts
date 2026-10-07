// Small WebCrypto helpers. No secret ever leaves this file in plain text except to
// the caller that needs it to talk to a vendor.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Signed job messages (Worker ⇄ GitHub Actions), section 13: shared secret, time-limited.
 * Signature = HMAC(secret, `${timestamp}.${body}`), valid for 10 minutes.
 */
export async function signJobMessage(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return { timestamp, signature: await hmacHex(secret, `${timestamp}.${body}`) };
}

export async function verifyJobMessage(
  secret: string,
  body: string,
  timestamp: string | null,
  signature: string | null,
  maxAgeS = 600,
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > maxAgeS) return false;
  const expected = await hmacHex(secret, `${ts}.${body}`);
  return timingSafeEqual(expected, signature);
}

// --- AES-GCM for connection keys at rest (section 4b: "stored encrypted in her Cloudflare account")

async function aesKey(secretB64: string): Promise<CryptoKey> {
  const raw = unb64(secretB64);
  if (raw.byteLength !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secretB64: string, plain: string): Promise<string> {
  const key = await aesKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(secretB64: string, packed: string): Promise<string> {
  const [ivB64, ctB64] = packed.split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed ciphertext");
  const key = await aesKey(secretB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, unb64(ctB64));
  return dec.decode(pt);
}

/** Session cookie value = `${sessionId}.${hmac}` so a forged id fails before a DB read. */
export async function signSession(secret: string, sessionId: string): Promise<string> {
  return `${sessionId}.${await hmacHex(secret, sessionId)}`;
}

export async function verifySessionCookie(secret: string, cookie: string | undefined): Promise<string | null> {
  if (!cookie) return null;
  const idx = cookie.lastIndexOf(".");
  if (idx <= 0) return null;
  const id = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  const expected = await hmacHex(secret, id);
  return timingSafeEqual(expected, sig) ? id : null;
}
