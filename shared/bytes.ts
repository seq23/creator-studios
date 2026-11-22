/**
 * Plain size for her screens: "9.12 GB", "1.25 GB", "1.5 GB", "640 MB", "under 1 MB". Up to two
 * decimals with trailing zeros dropped, so a 1.25 GB share reads 1.25 GB, never a rounded 1.3 GB.
 * One wording for the Worker and the app.
 */
export function gbWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${+(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return bytes > 0 ? "under 1 MB" : "0 MB";
}
