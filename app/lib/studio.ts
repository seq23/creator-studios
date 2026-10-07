// The studio this app is (GET /api/studio: name, owner's first name, wordmark). Loaded once in
// main.tsx before the first render, so every screen reads it synchronously. The palette and type
// come separately, as CSS, from /studio-theme.css (index.html), so nothing flashes.
export interface Studio {
  slug: string;
  appName: string;
  ownerName: string;
  wordmark: { name: string; tag?: string; mark?: string };
  chrome: string | null;
}

let current: Studio = { slug: "", appName: "Studio", ownerName: "", wordmark: { name: "Studio" }, chrome: null };

export async function loadStudio(): Promise<Studio> {
  try {
    const res = await fetch("/api/studio", { credentials: "same-origin" });
    if (res.ok) current = (await res.json()) as Studio;
  } catch {
    // Offline or the Worker is down: keep the neutral default; the app's own error screen explains.
  }
  document.title = current.appName;
  if (current.chrome) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", current.chrome);
  return current;
}

export const studio = (): Studio => current;
