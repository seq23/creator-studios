// "Why Buffer? ▾" (owner, 23 Oct 2026): why a creator's clips post through Buffer, in plain words.
// Opens on the Buffer card (Connect) and on Home's "Get set up" step ①. Help: why-we-post-through-buffer.
import { Link } from "react-router-dom";

export const WHY_BUFFER = [
  "Instagram and TikTok only let an app post for you after the app passes their own review, which takes weeks to months.",
  "Buffer already passed it, so your clips can post today.",
  "Buffer’s free plan covers 3 channels: Instagram, TikTok and YouTube.",
  "You sign in on Instagram’s and TikTok’s own pages inside Buffer. We never see your passwords.",
  "You can disconnect any time.",
  "If we ever get direct approval, we’ll switch you over with nothing for you to redo.",
];

export function WhyBuffer() {
  return (
    <details className="why-buffer" data-why-buffer>
      <summary>Why Buffer? ▾</summary>
      <ul>
        {WHY_BUFFER.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Link to="/help/why-we-post-through-buffer">More in Help</Link>
    </details>
  );
}
