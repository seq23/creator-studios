// The host's (and her other clients') identifiers that must never reach a CLIENT studio: its
// registry entry, its generated wrangler env, its secrets plan, or the shipped bundle every studio
// serves (studio brief §6a). One list, read by validator `sample-clean` and scripts/bundle-scan.mjs.
//
// Plain patterns for names and addresses; channel and account ids are kept as salted SHA-256 only
// (so this file does not itself publish them), and every token shaped like one is hashed and compared.
import { createHash } from "node:crypto";

/**
 * The host's former business name, in every spelling (joined, spaced, hyphenated, underscored). It
 * appears nowhere in this repo, so the pattern is assembled from parts (validator no-host-brand
 * scans every tracked file, this one included).
 */
export const HOST_BRAND = new RegExp(`${["w", "e", "s", "t"].join("")}[\\s_-]?${["p", "e", "e", "k"].join("")}`, "i");

export const PATTERNS = [
  [HOST_BRAND, "the host's former business name or address"],
  [/sequoia\s*taylor|sequoiataylor/i, "the host's name"],
  [/sequoia@|seq\.taylor@/i, "the host's email"],
  [/sheila|asheilabruce/i, "another client's studio (Sheila)"],
  [/\bseq23\b/i, "the host's GitHub account"],
];

/** sha256("owner-id:" + id) of the host's YouTube channel ids and Buffer organisation/account ids. */
export const HASHED_IDS = new Set([
  "6b4731f5ee636049fc7edf23da8ea9fd93ab605b51cc687f13c8c35a3ac278c0", // YouTube channel (how-we-know)
  "f332d76a82fd53a740c813da14b8b6c427158cbce4589f8423588bf7f6316349", // YouTube channel (test channel)
  "ec80fc5c1bf382fdfc8166a447c66d2521e61b2a0aa16eddfe6b39b0bb1a5a99", // Buffer organisation
  "c8700681b20c1675fca8856ac139b92b1dbf418ba11a30efd134c0f89039fc3a", // Buffer account
]);

const ID_TOKEN = /\bUC[A-Za-z0-9_-]{22}\b|\b[0-9a-f]{24}\b/g;
export const hashId = (id) => createHash("sha256").update(`owner-id:${id}`).digest("hex");

/**
 * Worker secret names that hold the HOST's own keys. A client studio's secret plan may carry none
 * of them; the platform sender (PLATFORM_RESEND_API_KEY, PLATFORM_EMAIL_FROM) is the one documented
 * shared piece and is named differently on purpose.
 */
export const OWNER_KEY_NAMES = ["RESEND_API_KEY", "YOUTUBE_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "META_APP_ID", "META_APP_SECRET", "GITHUB_DISPATCH_TOKEN", "OPENROUTER_API_KEY", "FIRECRAWL_API_KEY", "BUFFER_API_KEY", "BUFFER_ACCESS_TOKEN", "HUNTER_API_KEY", "ELEVENLABS_API_KEY"];

/** Every hit of a host identifier in a text. Pure. */
export function findIdentifiers(text) {
  const hits = [];
  for (const [re, what] of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(`${what} ("${m[0]}")`);
  }
  for (const m of text.matchAll(ID_TOKEN)) if (HASHED_IDS.has(hashId(m[0]))) hits.push(`a host channel or account id (${m[0].slice(0, 6)}…)`);
  return hits;
}
