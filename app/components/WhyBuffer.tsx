// "Why Buffer? ▾" (owner, 23 Oct 2026): why a creator's clips post through Buffer, in plain words.
// Opens on the Buffer card (Connect) and on Home's "Get set up" step ①. Help: why-we-post-through-buffer.
import { Link } from "react-router-dom";
import { WHY_BUFFER } from "@shared/whyBuffer";


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
