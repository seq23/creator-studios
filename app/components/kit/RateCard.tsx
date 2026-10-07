// Packages and rates: her rate card. Public "starting at" (or "Rates on request") per package,
// private floor and target (never on the kit, never in an email), and the add-on terms. The
// helper beside each package shows its suggestion with the arithmetic and the source named, or
// says plainly there is no benchmark. Rules: worker/domain/ratecard.ts.
import { DELIVERABLES, type AddOnTerms, type DeliverableKey, type RatePackage, type RateSuggestion, type Source } from "../../../worker/domain/ratecard";

const KEYS = Object.keys(DELIVERABLES) as DeliverableKey[];

function Sources({ list }: { list: Source[] }) {
  if (!list.length) return null;
  return (
    <span className="rc-sources">
      Source:{" "}
      {list.map((s, i) => (
        <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
          {i ? "; " : ""}
          {s.name}
        </a>
      ))}
    </span>
  );
}

const money = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.round(Number(v.replace(/[$,\s]/g, "")) || 0)));

export function RateCard({
  packages,
  addons,
  suggestions,
  basis,
  onChange,
  onAddons,
}: {
  packages: RatePackage[];
  addons: AddOnTerms;
  suggestions: Record<string, RateSuggestion>;
  basis: Record<keyof AddOnTerms, { text: string; sources: Source[] }>;
  onChange: (p: RatePackage[]) => void;
  onAddons: (a: AddOnTerms) => void;
}) {
  const set = (i: number, patch: Partial<RatePackage>) => onChange(packages.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="rc">
      {packages.map((p, i) => {
        const s = suggestions[p.id];
        return (
          <div key={p.id} className="rc-pkg" data-package={p.id}>
            <div className="rc-row">
              <label className="field grow">
                <span className="label">Package name</span>
                <input className="input" value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
              </label>
              <button type="button" className="link-btn" onClick={() => onChange(packages.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <div className="rc-items" aria-label={`What ${p.name || "this package"} includes`}>
              {p.items.map((it, k) => (
                <div key={k} className="rc-item">
                  <input className="input rc-qty" type="number" min={1} max={10} aria-label="How many" value={it.qty} onChange={(e) => set(i, { items: p.items.map((x, m) => (m === k ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)) })} />
                  <select className="select" aria-label="Deliverable" value={it.key} onChange={(e) => set(i, { items: p.items.map((x, m) => (m === k ? { ...x, key: e.target.value as DeliverableKey } : x)) })}>
                    {KEYS.map((key) => (
                      <option key={key} value={key}>
                        {DELIVERABLES[key].label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="link-btn" onClick={() => set(i, { items: p.items.filter((_, m) => m !== k) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="btn quiet small" onClick={() => set(i, { items: [...p.items, { key: "tiktok_video", qty: 1 }] })}>
                Add an item
              </button>
            </div>
            <div className="rc-prices">
              <label className="field">
                <span className="label">Starting at ($, on your kit)</span>
                <input className="input nums" inputMode="numeric" value={p.startingAt ?? ""} disabled={p.onRequest} onChange={(e) => set(i, { startingAt: money(e.target.value) })} />
              </label>
              <label className="field">
                <span className="label">Your target ($, private)</span>
                <input className="input nums" inputMode="numeric" value={p.target ?? ""} onChange={(e) => set(i, { target: money(e.target.value) })} />
              </label>
              <label className="field">
                <span className="label">Your floor ($, private)</span>
                <input className="input nums" inputMode="numeric" value={p.floor ?? ""} onChange={(e) => set(i, { floor: money(e.target.value) })} />
              </label>
            </div>
            <div className="rc-row wrap">
              <label className="check">
                <input type="checkbox" checked={p.onRequest} onChange={(e) => set(i, { onRequest: e.target.checked })} />
                Rates on request
              </label>
              <label className="check">
                <input type="checkbox" checked={p.showOnKit} onChange={(e) => set(i, { showOnKit: e.target.checked })} />
                Show on my kit
              </label>
            </div>
            <label className="field">
              <span className="label">What's included (on your kit)</span>
              <input className="input" value={p.note} onChange={(e) => set(i, { note: e.target.value })} />
            </label>
            {s ? (
              <div className={`rc-help ${s.kind}`} data-kind={s.kind}>
                <strong>{s.kind === "none" ? "No benchmark" : `Suggested: starting at $${s.startingAt?.toLocaleString("en-US")}, target $${s.target?.toLocaleString("en-US")}${s.floor != null ? `, floor $${s.floor.toLocaleString("en-US")}` : ""}`}</strong>
                <p>{s.formula}</p>
                <Sources list={s.sources} />
                {s.kind !== "none" ? (
                  <button type="button" className="btn quiet small" onClick={() => set(i, { startingAt: s.startingAt, target: s.target, floor: s.floor ?? p.floor })}>
                    Use these
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {packages.length < 8 ? (
        <button type="button" className="btn quiet" onClick={() => onChange([...packages, { id: `pkg_${Date.now().toString(36)}`, name: "", items: [{ key: "tiktok_video", qty: 1 }], startingAt: null, onRequest: false, floor: null, target: null, note: "", showOnKit: true }])}>
          Add a package
        </button>
      ) : null}

      <div className="rc-addons">
        <h3>Add-ons and terms</h3>
        <p className="hint">Priced on top of a package. The base fee includes 30 days of reposting on the brand's own channels.</p>
        {(
          [
            ["usagePctPer30d", "Usage on their channels, per extra 30 days (% of fee)"],
            ["paidUsagePctPer30d", "Paid ads from your handle, per 30 days (% of fee)"],
            ["exclusivityPctPerMonth", "Exclusivity, one category, per month (% of fee)"],
            ["rushPct", "Rush, under 7 days (% of fee; blank = none)"],
            ["bundleDiscountPct", "Bundle discount (%)"],
            ["killFeePct", "Kill fee if they cancel after the brief (%)"],
            ["upfrontPct", "Paid up front on bigger deals (%)"],
            ["upfrontOver", "…on deals over ($)"],
            ["netDays", "Payment due, days after invoice"],
            ["revisionRounds", "Rounds of changes included"],
          ] as [keyof AddOnTerms, string][]
        ).map(([k, label]) => (
          <label key={k} className="field rc-addon">
            <span className="label">{label}</span>
            <input
              className="input nums"
              inputMode="numeric"
              value={addons[k] ?? ""}
              onChange={(e) => onAddons({ ...addons, [k]: e.target.value.trim() === "" ? (k === "rushPct" ? null : 0) : Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
            <span className="hint">
              {basis[k]?.text} <Sources list={basis[k]?.sources ?? []} />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
