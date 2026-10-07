// The studio's wordmark, set in its theme's display face (studios/<slug>.json → theme.wordmark).
// Text, not an image: one component, a theme per studio, never a logo file per client.
import { studio } from "../lib/studio";

export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const w = studio().wordmark;
  return (
    <span className={`wordmark wordmark-${size}`} aria-label={studio().appName}>
      {w.mark ? (
        <span className="wordmark-mark" aria-hidden="true">
          {w.mark}
        </span>
      ) : null}
      <span className="wordmark-text" aria-hidden="true">
        <span className="wordmark-name">{w.name}</span>
        {w.tag ? <span className="wordmark-tag">{w.tag}</span> : null}
      </span>
    </span>
  );
}
