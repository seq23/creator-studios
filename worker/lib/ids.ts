const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short, URL-safe random id with a type prefix, e.g. dmp_k3j9x2m8q1. */
export function newId(prefix: string, length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Long random token for media links Buffer fetches (section 13). */
export function mediaToken(): string {
  return newId("m", 40).slice(2);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(iso: string | Date, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
