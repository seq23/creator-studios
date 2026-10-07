/** Plain size for her screens: "9.1 GB", "640 MB", "under 1 MB". One wording for the Worker and the app. */
export function gbWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return bytes > 0 ? "under 1 MB" : "0 MB";
}
