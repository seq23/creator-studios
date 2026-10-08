// One sentence per vendor answer to a key check (Setup Test key, Connect Check key). Pure.
/**
 * The sentence for a vendor's non-OK answer to a key check. 400/401/403 mean the key itself was
 * refused (Resend answers a malformed key with 400: found live on sample1, 7 Oct 2026, where the
 * card said "Resend answered 400. Try again in a minute."). Only a busy (429) or broken (5xx)
 * vendor is worth trying again in a minute; anything else names the status and points at the key.
 */
export function vendorStatusError(vendor: string, status: number): string {
  if (status === 400 || status === 401 || status === 403) return `${vendor} says this key is not valid.`;
  if (status === 429) return `${vendor} is busy right now. Try again in a minute.`;
  if (status >= 500) return `${vendor} did not answer properly (${status}). Try again in a minute.`;
  return `${vendor} answered ${status}. Check the key and try again.`;
}
