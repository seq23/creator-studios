// Small primitives every screen shares. Keep them dumb; behaviour lives in pages.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Light } from "@shared/types";
import { ApiFailure } from "../lib/api";
import { Icon } from "./Icon";

// ---------- toasts
interface Toast {
  id: number;
  text: string;
  bad?: boolean;
  fix?: string;
  /** "Undo" (day 358): archive and dismiss are one tap, so taking it back is one tap too. */
  action?: { label: string; run: () => void };
}
const ToastCtx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.bad || t.action ? 8000 : 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? " bad" : ""}`}>
            {t.text}
            {t.fix ? (
              <>
                {" "}
                <Link to={`/help/${t.fix}`}>How to fix</Link>
              </>
            ) : null}
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.run();
                  setToasts((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const { push } = useContext(ToastCtx);
  // One object per provider, not per render: screens put `toast` in useCallback/useEffect deps
  // (KitEditor's load), and a fresh object each render re-ran the load on every render, a GET
  // loop that reset whatever she was typing (the Link name edit was lost before blur).
  return useMemo(
    () => ({
      ok: (text: string) => push({ text }),
      /** "Archived. [Undo]": the toast carries the one tap that takes it back. */
      undo: (text: string, run: () => void) => push({ text, action: { label: "Undo", run } }),
      bad: (e: unknown, fallback = "Something went wrong.") => {
        if (e instanceof ApiFailure) push({ text: e.body.error, bad: true, fix: e.body.fix_guide });
        else push({ text: e instanceof Error && e.message ? e.message : fallback, bad: true });
      },
    }),
    [push],
  );
}

// ---------- data hook
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    loader()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- pieces
/**
 * Every screen's title block: optional breadcrumb, a short uppercase eyebrow (dates only) or a
 * script flourish (the brand's Allura, at most one per screen), the Playfair title, and a one-
 * sentence lede. `children` is the action area; mark the screen's one next step `data-primary`.
 */
export function PageHead({ eyebrow, script, title, lede, crumb, children }: { eyebrow?: string; script?: string; title: ReactNode; lede?: ReactNode; crumb?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumb ? <div className="crumb">{crumb}</div> : null}
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        {script ? <span className="script">{script}</span> : null}
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}

export function Card({ className = "", children, to, accent, onClick }: { className?: string; children: ReactNode; to?: string; accent?: boolean; onClick?: () => void }) {
  const cls = `card${accent ? " accent" : ""}${to || onClick ? " link" : ""} ${className}`;
  if (to) return <Link to={to} className={cls}>{children}</Link>;
  if (onClick)
    return (
      <div className={cls} role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => (e.key === "Enter" ? onClick() : undefined)}>
        {children}
      </div>
    );
  return <div className={cls}>{children}</div>;
}

export function Stat({ label, value, sub, meter, children }: { label: string; value: ReactNode; sub?: ReactNode; meter?: { fraction: number; tone?: "ok" | "warn" }; children?: ReactNode }) {
  return (
    <>
      <div className="card-label">{label}</div>
      <div className="stat">{value}</div>
      {meter ? (
        <div className={`meter ${meter.tone ?? ""}`}>
          <span style={{ width: `${Math.max(0, Math.min(100, meter.fraction * 100))}%` }} />
        </div>
      ) : null}
      {sub ? <div className="hint">{sub}</div> : null}
      {children}
    </>
  );
}

const LIGHT_WORDS: Record<Light, string> = { green: "Working", yellow: "Needs a look", red: "Not working", grey: "Not set up" };

/** A health light. The colour is never the only signal: the name says it in words. */
export function Dot({ light }: { light: Light }) {
  return <span className={`dot ${light}`} role="img" data-light={light} aria-label={LIGHT_WORDS[light]} />;
}

/** An empty state always says what to do next, with a link to do it. */
export function Empty({ title, children, cta, secondary, primary }: { title: string; children?: ReactNode; cta?: { to: string; label: string }; secondary?: { to: string; label: string }; /** the CTA is the screen's one next step */ primary?: boolean }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p className="soft">{children}</p> : null}
      {cta || secondary ? (
        <div className="btn-row">
          {cta ? (
            <Link className="btn" to={cta.to} data-primary={primary || undefined}>
              {cta.label}
            </Link>
          ) : null}
          {secondary ? (
            <Link className="btn quiet" to={secondary.to}>
              {secondary.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

/**
 * Loading placeholder shaped like what is coming: `blocks` draws card-sized blocks in a grid
 * (dashboards, lists of cards), `lines` draws text lines. It reserves the space so the page does
 * not jump when data arrives.
 */
export function Skeleton({ lines = 3, blocks = 0, columns = 1 }: { lines?: number; blocks?: number; columns?: 1 | 2 | 3 | 4 }) {
  if (blocks)
    return (
      <div className={`grid${columns > 1 ? ` cols-${columns}` : ""}`} aria-busy="true" aria-label="Loading">
        {Array.from({ length: blocks }).map((_, i) => (
          <div key={i} className="skeleton skeleton-block" />
        ))}
      </div>
    );
  return (
    <div className="section" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" ? onClose() : undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stepper({ value, min = 0, max, onChange, label }: { value: number; min?: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
        −
      </button>
      <output>{value}</output>
      <button type="button" aria-label={`More ${label}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
        +
      </button>
    </div>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="switch-label">{label}</span>
        {hint ? <span className="hint switch-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** "See all (N)" under a capped list: only when there is more than it shows (day 358). */
export function SeeAll({ shown, total, to, label = "See all" }: { shown: number; total: number; to: string; label?: string }) {
  if (total <= shown) return null;
  return (
    <Link to={to} className="see-all" data-see-all>
      {label} ({total}) <Icon name="arrow" size="sm" />
    </Link>
  );
}

/** "Showing 24 of 329 · Show more": the count is the true total (day 358). */
export function MoreRow({ shown, total, onMore, busy, noun }: { shown: number; total: number; onMore: () => void; busy?: boolean; noun: string }) {
  return (
    <div className="more-row">
      <span className="hint nums" data-count>
        Showing {Math.min(shown, total)} of {total} {noun}
      </span>
      {shown < total ? (
        <button type="button" className="btn quiet small" onClick={onMore} disabled={busy}>
          {busy ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** Search box for a long list: a plain field, submits as she types (debounced by the caller). */
export function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="search-box">
      <Icon name="search" size="sm" />
      <input type="search" value={value} placeholder={label} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The quiet "×" that dismisses a Home card or archives a row: 44 px target, named for screen readers. */
export function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="dismiss-btn"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name="close" size="sm" />
    </button>
  );
}

/** The "?" on every screen (section 12c): opens the guide for that exact screen. */
export function HelpButton({ guide }: { guide: string }) {
  return (
    <Link to={`/help/${guide}`} className="help-btn" aria-label="Help for this screen" title="Help for this screen">
      <Icon name="help" size="lg" />
    </Link>
  );
}
