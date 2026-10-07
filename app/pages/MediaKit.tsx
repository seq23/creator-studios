// Media kit (section 12b.1). `MediaKit` is the public, phone-first page at /kit/:slug (no login):
// the newest published version. `MediaKitPrint` is /kit/:slug/print, the same kit laid out as a
// clean two-page PDF from the browser's Print / Save as PDF. Her editor is the Media kit tab on
// Deals (app/components/kit/KitEditor.tsx).
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { get } from "../lib/api";
import { Skeleton } from "../components/ui";
import { KitSheet } from "../components/kit/KitSheet";
import type { PublicKit } from "../../worker/domain/kit";
import "../styles/mediakit.css";

export { KitEditor as MediaKitEditor } from "../components/kit/KitEditor";

type Answer = PublicKit | { moved: string };

function useKit(slug: string, preview: boolean) {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  // Each answer is tied to the link name it was fetched for, so an old "moved" answer can never
  // act after the page has moved on (a stale answer is ignored).
  const [state, setState] = useState<{ slug: string; kit: PublicKit | null; error: boolean }>({ slug: "", kit: null, error: false });
  useEffect(() => {
    let live = true;
    get<Answer>(`/api/public/kit/${encodeURIComponent(slug)}${preview ? "?preview=1" : ""}`).then(
      (a) => {
        if (!live) return;
        if ("moved" in a) {
          if (a.moved === slug) setState({ slug, kit: null, error: true });
          else navRef.current(`/kit/${a.moved}${window.location.pathname.endsWith("/print") ? "/print" : ""}${window.location.search}`, { replace: true });
          return;
        }
        document.title = `${a.name} · media kit`;
        setState({ slug, kit: a, error: false });
      },
      () => live && setState({ slug, kit: null, error: true }),
    );
    return () => {
      live = false;
    };
  }, [slug, preview]);
  const current = state.slug === slug;
  return { kit: current ? state.kit : null, loading: !current, error: current && state.error };
}

export function MediaKit() {
  const { slug = "" } = useParams();
  const [q] = useSearchParams();
  const { kit, loading, error } = useKit(slug, q.get("preview") === "1");
  return (
    <div className="kit-page">
      <main className="kit">
        {loading && !kit ? <Skeleton blocks={3} /> : null}
        {error ? (
          <div className="kit-missing">
            <h1>No media kit here</h1>
            <p className="soft">This link may be old or the kit isn't published yet. Check the link you were sent.</p>
          </div>
        ) : null}
        {kit ? <KitSheet kit={kit} pdfHref={`/kit/${encodeURIComponent(slug)}/print?autoprint=1`} /> : null}
      </main>
    </div>
  );
}

export function MediaKitPrint() {
  const { slug = "" } = useParams();
  const [q] = useSearchParams();
  const { kit, error } = useKit(slug, true);
  useEffect(() => {
    if (!kit || q.get("autoprint") !== "1") return;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [kit, q]);
  return (
    <div className="kit-print-page">
      <div className="kit-print-bar">
        <button type="button" className="btn" data-primary onClick={() => window.print()}>
          Save as PDF
        </button>
        <span className="hint">In the print window, pick “Save as PDF”.</span>
      </div>
      <main className="kit kit-print">
        {error ? <h1>No media kit here</h1> : null}
        {kit ? <KitSheet kit={kit} print /> : <Skeleton blocks={2} />}
      </main>
    </div>
  );
}
