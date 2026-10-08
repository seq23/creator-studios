// The studio this app is (GET /api/studio: name, owner's first name, wordmark). Loaded once in
// main.tsx before the first render, so every screen reads it synchronously. The palette and type
// come separately, as CSS, from /studio-theme.css (index.html), so nothing flashes.
import { setStudio, studio, type Studio } from "./studio-current";

export { studio, type Studio };

export async function loadStudio(): Promise<Studio> {
  try {
    const res = await fetch("/api/studio", { credentials: "same-origin" });
    if (res.ok) setStudio((await res.json()) as Studio);
  } catch {
    // Offline or the Worker is down: keep the neutral default; the app's own error screen explains.
  }
  const current = studio();
  document.title = current.appName;
  if (current.chrome) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", current.chrome);
  return current;
}
