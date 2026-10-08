// Her side of the media kit: every input on one screen, in sections, autosaved as a draft.
// Preview shows exactly what brands will see; Publish makes a new dated version and only then
// does the public link change. The Kit check lists what is missing or stale, each with a one-tap
// fix. Rules: worker/domain/kit.ts; routes: worker/routes/mediakit.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import { get, patch, post } from "../../lib/api";
import { ago, fmtDate } from "../../lib/format";
import { uploadFile } from "../../lib/upload";
import { Card, Modal, MoreRow, Notice, Skeleton, useToast } from "../ui";
import { Icon } from "../Icon";
import { KitSheet, asOf, num } from "./KitSheet";
import { RateCard } from "./RateCard";
import type { KitContent, KitIssue, PlatformFigures, PublicKit } from "../../../worker/domain/kit";
import type { AddOnTerms, RateSuggestion, Source } from "../../../worker/domain/ratecard";
import "../../styles/mediakit.css";

interface OwnerView {
  draft: KitContent;
  draftSavedAt: string | null;
  slug: string;
  publicUrl: string;
  printPath: string;
  published: { version: number; publishedAt: string } | null;
  draftDiffers: boolean;
  versions: { version: number; published_at: string }[];
  /** Day 358: every published version (the list shows the newest; Show older asks for the rest). */
  versionsTotal: number;
  views: { count: number; last: string | null; last7: number };
  figures: PlatformFigures[];
  check: KitIssue[];
  clips: { id: string; hook: string; score: number; mediaUrl: string; coverUrl: string | null }[];
  profile: { locked: boolean; themes: string[]; audience: string };
  helper: { followers: Partial<Record<Platform, number>>; suggestions: Record<string, RateSuggestion>; addonBasis: Record<keyof AddOnTerms, { text: string; sources: Source[] }> };
  wonDeals: { dealId: string; brand: string; website: string | null }[];
  ownerEmail: string;
}

export function KitEditor() {
  const toast = useToast();
  const [view, setView] = useState<OwnerView | null>(null);
  const [olderVersions, setOlderVersions] = useState<OwnerView["versions"] | null>(null);
  const [draft, setDraft] = useState<KitContent | null>(null);
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [preview, setPreview] = useState<PublicKit | null>(null);
  const [publishing, setPublishing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<KitContent>>({});

  const load = useCallback(async () => {
    try {
      const v = await get<OwnerView>("/api/mediakit");
      setView(v);
      setDraft(v.draft);
      setSlug(v.slug);
    } catch (e) {
      toast.bad(e);
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    const body = pending.current;
    pending.current = {};
    if (!Object.keys(body).length) return;
    setSaving("saving");
    try {
      const r = await patch<{ view: OwnerView }>("/api/mediakit", { draft: body });
      // keep what she is typing; take the derived parts (check, suggestions, figures)
      setView((v) => (v ? { ...r.view, draft: v.draft } : r.view));
      setSaving("saved");
    } catch (e) {
      setSaving("error");
      toast.bad(e);
    }
  }, [toast]);

  function change<K extends keyof KitContent>(k: K, v: KitContent[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    pending.current = { ...pending.current, [k]: v };
    setSaving("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  }
  useEffect(() => () => void flush(), [flush]);

  if (!view || !draft) return <Skeleton blocks={3} columns={2} />;

  async function publish() {
    setPublishing(true);
    try {
      await flush();
      const r = await post<{ version: number; view: OwnerView }>("/api/mediakit/publish");
      setView(r.view);
      setDraft(r.view.draft);
      toast.ok(`Published version ${r.version}. Your link now shows it.`);
    } catch (e) {
      toast.bad(e);
    } finally {
      setPublishing(false);
    }
  }

  async function openPreview() {
    await flush();
    try {
      setPreview(await get<PublicKit>("/api/mediakit/preview"));
    } catch (e) {
      toast.bad(e);
    }
  }

  async function fix(i: KitIssue) {
    const f = i.fix;
    if (f.action === "publish") return publish();
    if (f.action === "upload_photo") return document.getElementById("kit-photo-input")?.click();
    if (f.action === "focus") return document.getElementById(`kit-${f.field}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (f.action === "connect_stats") return void (window.location.href = "/settings/connections");
    if (f.action === "refresh_stats") {
      if (f.how === "import") return void (window.location.href = "/stats");
      try {
        await post("/api/stats/sync");
        toast.ok("Refreshing your numbers. They update here in a few minutes.");
      } catch (e) {
        toast.bad(e);
      }
      return;
    }
    await flush();
    try {
      const r = await post<{ view: OwnerView }>("/api/mediakit/fix", { action: f.action });
      setView(r.view);
      setDraft(r.view.draft);
      toast.ok("Done.");
    } catch (e) {
      toast.bad(e);
    }
  }

  async function uploadImage(file: File | undefined, use: (key: string) => void) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.bad(new Error("Pick a photo (JPG or PNG)."));
    try {
      const h = await uploadFile(file, "kit_photo", null, () => undefined);
      const r = await post<{ key: string }>(`/api/mediakit/image/${h.id}`);
      use(r.key);
      toast.ok("Photo added.");
    } catch (e) {
      toast.bad(e);
    }
  }

  async function saveSlug() {
    if (slug === view!.slug) return;
    try {
      const r = await patch<{ view: OwnerView }>("/api/mediakit", { slug });
      setView((v) => (v ? { ...r.view, draft: v.draft } : r.view));
      toast.ok("Link name changed. Links you already sent still work.");
    } catch (e) {
      toast.bad(e);
    }
  }

  const status = view.published ? `Published version ${view.published.version} on ${fmtDate(view.published.publishedAt)}` : "Not published yet";
  const views = view.views.count ? `Viewed ${view.views.count} ${view.views.count === 1 ? "time" : "times"}, last on ${fmtDate(view.views.last)}` : "No views yet";
  const issues = view.check;
  const figKey = (f: PlatformFigures) => `${PLATFORM_LABEL[f.platform]}`;

  return (
    <div className="kit-editor">
      <Card className="flat kit-bar">
        <div className="kit-bar-top">
          <div className="grow">
            <div className="card-title">Your media kit</div>
            <div className="mono kit-url">{view.publicUrl}</div>
            <div className="hint">
              {status} · {views}
              {view.draftDiffers && view.published ? " · Changes not public yet" : ""} · {saving === "saving" ? "Saving…" : saving === "error" ? "Not saved: check your connection" : view.draftSavedAt ? `Draft saved ${ago(view.draftSavedAt)}` : "Draft"}
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn quiet small" onClick={openPreview}>
              Preview
            </button>
            <a className="btn quiet small" href={`${view.printPath}?autoprint=1`} target="_blank" rel="noreferrer" aria-disabled={!view.published}>
              Download PDF
            </a>
            <button type="button" className="btn quiet small" onClick={() => navigator.clipboard.writeText(view.publicUrl).then(() => toast.ok("Link copied."), () => toast.bad(new Error("Copy the link by hand.")))}>
              Copy link
            </button>
            <button type="button" className="btn" data-primary onClick={publish} disabled={publishing || (!!view.published && !view.draftDiffers)}>
              {publishing ? "Publishing…" : view.published ? (view.draftDiffers ? "Publish changes" : "Published") : "Publish"}
            </button>
          </div>
        </div>
      </Card>

      <Card className="kit-check" >
        <h2 className="card-title">Kit check</h2>
        {issues.length === 0 ? (
          <p className="soft">Nothing missing. Your kit is ready to send.</p>
        ) : (
          <ul className="kit-issues">
            {issues.map((i) => (
              <li key={i.key} className={`kit-issue ${i.level}`}>
                <span className={`pill ${i.level === "missing" ? "bad" : i.level === "stale" ? "warn" : ""}`}>{i.level === "missing" ? "Missing" : i.level === "stale" ? "Out of date" : "Tip"}</span>
                <span className="grow">{i.text}</span>
                <button type="button" className="btn quiet small" onClick={() => fix(i)}>
                  {i.fixLabel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!view.profile.locked ? <Notice tone="info">Your content pillars start from your locked Brand Profile. Lock it in Client Brain, or type them below.</Notice> : null}

      <Card className="kit-sec" >
        <h2 className="card-title" id="kit-handles">
          Cover
        </h2>
        <div className="kit-cover-row">
          {draft.photoKey ? <img className="kit-photo small" src={`/api/mediakit/file/${draft.photoKey.split("/").pop()}`} alt="Your media kit photo" /> : <div className="kit-photo small empty" aria-hidden="true" />}
          <div className="btn-row">
            <label className="btn quiet">
              {draft.photoKey ? "Change photo" : "Add a photo"}
              <input id="kit-photo-input" type="file" accept="image/*" className="sr-only" aria-label="Media kit photo" onChange={(e) => uploadImage(e.target.files?.[0], (k) => change("photoKey", k))} />
            </label>
            {draft.photoKey ? (
              <button type="button" className="link-btn" onClick={() => change("photoKey", null)}>
                Use my logo instead
              </button>
            ) : null}
          </div>
        </div>
        <div className="grid cols-2">
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={draft.name} onChange={(e) => change("name", e.target.value)} />
          </label>
          <label className="field" id="kit-positioning">
            <span className="label">One line under your name</span>
            <input className="input" maxLength={160} placeholder="Videos that make every viewer feel at home." value={draft.positioning} onChange={(e) => change("positioning", e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Your niche, in a few words</span>
            <input className="input" maxLength={90} placeholder="What you make, in a few words" value={draft.niche} onChange={(e) => change("niche", e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Where you are</span>
            <input className="input" maxLength={60} placeholder="Mobile, Alabama" value={draft.location} onChange={(e) => change("location", e.target.value)} />
          </label>
          {PLATFORMS.map((p) => (
            <label key={p} className="field">
              <span className="label">{PLATFORM_LABEL[p]} handle</span>
              <input className="input" placeholder="@yourname" value={draft.handles[p] ?? ""} onChange={(e) => change("handles", { ...draft.handles, [p]: e.target.value })} />
            </label>
          ))}
        </div>
        <label className="field">
          <span className="label">About you (a few sentences)</span>
          <textarea className="textarea" maxLength={600} value={draft.bio} onChange={(e) => change("bio", e.target.value)} placeholder="Who you are, who watches, why brands love working with you." />
          <span className="hint nums">{draft.bio.length}/600</span>
        </label>
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title">Audience at a glance</h2>
        <p className="hint">These come from your connected stats and TikTok export, with the date and source brands see. A number the dashboard can't check never appears unless you add it below, and then it is marked self-reported.</p>
        {view.figures.length ? (
          <div className="kit-figs">
            {view.figures.map((f) => (
              <div key={f.platform} className="kit-fig">
                <strong>{figKey(f)}</strong>
                <span className="nums">
                  {num(f.followers)} followers · {num(f.avgViews)} average views{f.engagement ? ` · ${f.engagement.rate}% engagement` : ""}
                </span>
                <span className="hint">
                  As of {asOf(f.asOf)} · {f.source}
                </span>
                {f.engagement ? <span className="hint">How: {f.engagement.method}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="soft">
            No verified numbers yet. <Link to="/settings/connections">Connect your stats</Link> or <Link to="/stats">upload your TikTok export</Link>.
          </p>
        )}
        <h3 className="kit-sub">Add a number yourself (shown as self-reported)</h3>
        {draft.manual.map((m, i) => (
          <div key={m.id} className="kit-manual">
            <select className="select" aria-label="Platform" value={m.platform ?? ""} onChange={(e) => change("manual", draft.manual.map((x, j) => (j === i ? { ...x, platform: (e.target.value || null) as Platform | null } : x)))}>
              <option value="">Any platform</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </option>
              ))}
            </select>
            <input className="input" aria-label="What it is" placeholder="Audience women" value={m.label} onChange={(e) => change("manual", draft.manual.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <input className="input" aria-label="Number" placeholder="82%" value={m.value} onChange={(e) => change("manual", draft.manual.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <input className="input" type="date" aria-label="As of" value={m.asOf} onChange={(e) => change("manual", draft.manual.map((x, j) => (j === i ? { ...x, asOf: e.target.value } : x)))} />
            <button type="button" className="link-btn" onClick={() => change("manual", draft.manual.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        {draft.manual.length < 8 ? (
          <button type="button" className="btn quiet small" onClick={() => change("manual", [...draft.manual, { id: `man_${Date.now().toString(36)}`, platform: null, label: "", value: "", asOf: new Date().toISOString().slice(0, 10) }])}>
            <Icon name="plus" size="sm" /> Add manually
          </button>
        ) : null}
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title">What you make</h2>
        <h3 className="kit-sub">Content pillars</h3>
        <PairList items={draft.pillars} max={6} titleLabel="Pillar" textLabel="One line about it" onChange={(v) => change("pillars", v)} />
        {view.profile.themes.length && !draft.pillars.length ? (
          <button type="button" className="btn quiet small" onClick={() => change("pillars", view.profile.themes.slice(0, 4).map((t) => ({ title: t, text: "" })))}>
            Use my Brand Profile themes
          </button>
        ) : null}
        <h3 className="kit-sub">Signature series</h3>
        <PairList items={draft.series} max={4} titleLabel="Series name" textLabel="What it is" onChange={(v) => change("series", v)} />
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title" id="kit-showcase">
          Recent work: pick 3 to 6 clips
        </h2>
        {view.clips.length === 0 ? (
          <p className="soft">Approve some clips in Review first; your best ones show up here to pick from.</p>
        ) : (
          <div className="kit-pick" role="group" aria-label="Pick 3 to 6 clips">
            {view.clips.map((c) => {
              const on = draft.showcase.includes(c.id);
              return (
                <label key={c.id} className={`kit-pick-item${on ? " on" : ""}`}>
                  <input type="checkbox" checked={on} disabled={!on && draft.showcase.length >= 6} onChange={() => change("showcase", on ? draft.showcase.filter((x) => x !== c.id) : [...draft.showcase, c.id])} />
                  <span className="kit-pick-thumb" aria-hidden="true">
                    {c.coverUrl ? <img src={c.coverUrl} alt="" /> : <Icon name="review" size="sm" />}
                  </span>
                  <span className="kit-pick-text">{c.hook || "Clip"}</span>
                </label>
              );
            })}
          </div>
        )}
        <div className="hint nums">{draft.showcase.length} of 6 picked (at least 3)</div>
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title">Brands you've worked with</h2>
        {draft.collabs.map((c, i) => (
          <div key={c.id} className="kit-collab">
            <div className="kit-collab-logo">
              {c.logoKey ? <img src={`/api/mediakit/file/${c.logoKey.split("/").pop()}`} alt="" /> : <span aria-hidden="true">{c.brand.slice(0, 1) || "?"}</span>}
              <label className="link-btn">
                {c.logoKey ? "Change logo" : "Add logo"}
                <input type="file" accept="image/*" className="sr-only" aria-label={`Logo for ${c.brand || "this brand"}`} onChange={(e) => uploadImage(e.target.files?.[0], (k) => change("collabs", draft.collabs.map((x, j) => (j === i ? { ...x, logoKey: k } : x))))} />
              </label>
            </div>
            <div className="grid cols-2 grow">
              <input className="input" aria-label="Brand" placeholder="Brand" value={c.brand} onChange={(e) => change("collabs", draft.collabs.map((x, j) => (j === i ? { ...x, brand: e.target.value } : x)))} />
              <input className="input" aria-label="Their website" placeholder="brand.com (for their logo)" value={c.website ?? ""} onChange={(e) => change("collabs", draft.collabs.map((x, j) => (j === i ? { ...x, website: e.target.value || null } : x)))} />
              <input className="input" aria-label="What you made" placeholder="2 TikToks for their holiday launch" value={c.what} onChange={(e) => change("collabs", draft.collabs.map((x, j) => (j === i ? { ...x, what: e.target.value } : x)))} />
              <input className="input" aria-label="One result" placeholder="48K views, 1.2K saves" value={c.result} onChange={(e) => change("collabs", draft.collabs.map((x, j) => (j === i ? { ...x, result: e.target.value } : x)))} />
            </div>
            <button type="button" className="link-btn" onClick={() => change("collabs", draft.collabs.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="btn-row">
          {draft.collabs.length < 12 ? (
            <button type="button" className="btn quiet small" onClick={() => change("collabs", [...draft.collabs, { id: `col_${Date.now().toString(36)}`, brand: "", website: null, logoKey: null, what: "", result: "", dealId: null }])}>
              <Icon name="plus" size="sm" /> Add a brand
            </button>
          ) : null}
          {view.wonDeals.length ? (
            <button type="button" className="btn quiet small" onClick={() => fix({ key: "collabs", level: "tip", text: "", fixLabel: "", fix: { action: "import_collabs" } })}>
              Add my {view.wonDeals.length} won {view.wonDeals.length === 1 ? "deal" : "deals"}
            </button>
          ) : null}
        </div>
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title" id="kit-packages">
          Packages and rates
        </h2>
        <p className="hint">Brands see the name, what's included and "Starting at" (or "Rates on request"). Your target and floor stay private: the deal helper uses them to work out counters.</p>
        {draft.packages.length === 0 ? (
          <button type="button" className="btn quiet" onClick={() => fix({ key: "packages", level: "missing", text: "", fixLabel: "", fix: { action: "starter_packages" } })}>
            Add starter packages
          </button>
        ) : null}
        <RateCard packages={draft.packages} addons={draft.addons} suggestions={view.helper.suggestions} basis={view.helper.addonBasis} onChange={(v) => change("packages", v)} onAddons={(v) => change("addons", v)} />
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title" id="kit-testimonials">
          What brands say
        </h2>
        {draft.testimonials.map((t, i) => (
          <div key={i} className="kit-testimonial">
            <textarea className="textarea" aria-label="Their words" placeholder="Your video sold out our holiday set in a week." value={t.quote} onChange={(e) => change("testimonials", draft.testimonials.map((x, j) => (j === i ? { ...x, quote: e.target.value } : x)))} />
            <div className="grid cols-2">
              <input className="input" aria-label="Name" placeholder="Name" value={t.name} onChange={(e) => change("testimonials", draft.testimonials.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className="input" aria-label="Role and brand" placeholder="Marketing lead, Brand" value={t.role} onChange={(e) => change("testimonials", draft.testimonials.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} />
            </div>
            <button type="button" className="link-btn" onClick={() => change("testimonials", draft.testimonials.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        {draft.testimonials.length < 6 ? (
          <button type="button" className="btn quiet small" onClick={() => change("testimonials", [...draft.testimonials, { quote: "", name: "", role: "" }])}>
            <Icon name="plus" size="sm" /> Add a testimonial
          </button>
        ) : null}
      </Card>

      <Card className="kit-sec">
        <h2 className="card-title">Contact</h2>
        <div className="grid cols-2">
          <label className="field">
            <span className="label">Email brands should use</span>
            <input className="input" type="email" value={draft.contactEmail ?? ""} onChange={(e) => change("contactEmail", e.target.value || null)} placeholder="partnerships@yourdomain.com" />
          </label>
          <label className="field">
            <span className="label">Link name</span>
            <input className="input" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} onBlur={saveSlug} />
            <span className="hint">Changing it keeps every link you already sent working: old links forward to the new one.</span>
          </label>
        </div>
      </Card>

      {view.versions.length ? (
        <Card className="kit-sec">
          <h2 className="card-title">Versions</h2>
          <ul className="kit-versions">
            {(olderVersions ?? view.versions).map((v) => (
              <li key={v.version} className="nums">
                Version {v.version} · published {fmtDate(v.published_at)}
                {v.version === view.published?.version ? " · live now" : ""}
              </li>
            ))}
          </ul>
          <MoreRow
            shown={(olderVersions ?? view.versions).length}
            total={view.versionsTotal}
            noun="versions"
            onMore={() => get<OwnerView>(`/api/mediakit?versions=${view.versionsTotal}`).then((v) => setOlderVersions(v.versions), (e) => toast.bad(e))}
          />
        </Card>
      ) : null}

      {preview ? (
        <Modal title="Preview: what brands see" onClose={() => setPreview(null)}>
          <div className="kit-preview">
            <KitSheet kit={preview} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" data-primary onClick={() => void publish().then(() => setPreview(null))}>
              {view.published ? "Publish changes" : "Publish"}
            </button>
            <button type="button" className="btn quiet" onClick={() => setPreview(null)}>
              Keep editing
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function PairList({ items, max, titleLabel, textLabel, onChange }: { items: { title: string; text: string }[]; max: number; titleLabel: string; textLabel: string; onChange: (v: { title: string; text: string }[]) => void }) {
  return (
    <div className="kit-pairs">
      {items.map((it, i) => (
        <div key={i} className="kit-pair">
          <input className="input" aria-label={titleLabel} placeholder={titleLabel} value={it.title} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
          <input className="input grow" aria-label={textLabel} placeholder={textLabel} value={it.text} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          <button type="button" className="link-btn" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {items.length < max ? (
        <button type="button" className="btn quiet small" onClick={() => onChange([...items, { title: "", text: "" }])}>
          <Icon name="plus" size="sm" /> Add
        </button>
      ) : null}
    </div>
  );
}
