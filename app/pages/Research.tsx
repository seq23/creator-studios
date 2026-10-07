// Research Brief (BUILD_PLAN.md section 6): the cited brief, every claim with its source link(s)
// and a label (her data / web / upload / uncertain), Approve, Refresh, upload an outside report,
// edit a draft. The Worker applies the truth rules before it sends the brief, so an uncited
// claim always arrives marked uncertain and is shown that way, never as fact.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import type { BriefBody, BriefSource, BriefView, Claim } from "@shared/types";
import { del, get, patch, post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { ago, fmtDate, plural } from "../lib/format";
import { Card, DismissButton, Empty, HelpButton, Notice, PageHead, Skeleton, useLoad, useToast } from "../components/ui";
import { archiveWithUndo, restoreArchived } from "../lib/archive";
import { Icon } from "../components/Icon";
import "../styles/research.css";

interface ResearchData {
  brief: BriefView | null;
  counts: { claims: number; uncertain: number; sources: number } | null;
  webSkipped: boolean;
  approved: { version: number; approved_at: string } | null;
  uploads: { id: string; file_name: string; uploaded_at: string }[];
  job: { id: string; status: string; safe_error: string | null; created_at: string; finished_at: string | null } | null;
  profileLocked: boolean;
  firecrawlConnected: boolean;
  /** Day 358: earlier briefs (not archived, or the archived ones with ?archived=1) and how many are archived. */
  versions: { version: number; status: "draft" | "approved" | "superseded"; approved_at: string | null; created_at: string; archived_at: string | null }[];
  archivedVersions: number;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;

const PILL: Record<string, { text: string; cls: string }> = {
  her_data: { text: "Her data", cls: "rs-pill her" },
  web: { text: "Web", cls: "rs-pill web" },
  upload: { text: "Upload", cls: "rs-pill upload" },
  uncertain: { text: "Uncertain", cls: "rs-pill unsure" },
};
/** Same rule as the server's claimLabel (worker/domain/brief.ts): uncited or weak → uncertain. */
const label = (c: Claim, sources?: Map<string, BriefSource>) => (c.confidence === "uncertain" || (sources && !c.source_ids.some((id) => sources.has(id))) ? "uncertain" : c.basis);

/** The "How often" rows are drawn here from the baseline studies, not stored in the brief. */
function frequencyClaim(p: Platform, sources: Map<string, BriefSource>): Claim {
  const f = FREQUENCY[p];
  const ids = f.sources.filter((id) => sources.has(id));
  return { text: f.text, source_ids: ids, basis: "web", confidence: f.sure && ids.length ? "solid" : "uncertain" };
}

/** Section 10b frequency baseline, shown under "How often" with its studies. */
const FREQUENCY: Record<Platform, { text: string; sources: string[]; sure: boolean }> = {
  tiktok: { text: "More posts mostly mean more chances at a breakout: 6–10 a week gave about 29% more views per post than 1 a week.", sources: ["b_buffer_tt_freq"], sure: true },
  instagram: { text: "3–5 Reels a week gave about 12% more reach per post than 1–2; gains shrink past 10.", sources: ["b_buffer_freq"], sure: true },
  youtube: { text: "Evidence is mixed: 3 a week did not clearly beat 1 a week. The launch number is a test.", sources: ["b_buffer_freq"], sure: false },
};

const SECTIONS = [
  ["times", "Posting times"],
  ["often", "How often"],
  ["audience", "Audience"],
  ["themes", "Content themes"],
  ["hooks", "Hooks"],
  ["cuts", "Cut styles + length"],
  ["creators", "Creators to learn from"],
  ["film", "What to film next"],
] as const;

export function Research() {
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => get<ResearchData>("/api/research"));
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<BriefBody | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = !!data?.job && ["queued", "dispatched", "running"].includes(data.job.status);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 6000);
    return () => clearInterval(t);
  }, [running, reload]);

  async function act(name: string, fn: () => Promise<unknown>, okText: string) {
    setBusy(name);
    try {
      await fn();
      toast.ok(okText);
      return true;
    } catch (e) {
      toast.bad(e);
      return false;
    } finally {
      setBusy(null);
      reload();
    }
  }

  async function addReport(files: FileList) {
    const f = files[0];
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const type = ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", md: "text/markdown", txt: "text/plain" } as Record<string, string>)[ext];
    if (!type) {
      toast.bad(new Error("Upload the report as PDF, Word (.docx), Markdown or plain text."));
      return;
    }
    const file = f.type === type ? f : new File([f], f.name, { type });
    await act("upload", () => uploadFile(file, "research_upload", null, () => undefined), "Report added. Press Refresh research to use it.");
  }

  const brief = data?.brief ?? null;
  const sources = useMemo(() => new Map((brief?.sources ?? []).map((s) => [s.id, s])), [brief]);
  // The header counts what the page shows: the stored claims (server count) plus the "How often"
  // rows drawn here (live test 25 Sep 2026: header said 2 uncertain, the page showed 3).
  const uncertainShown = (data?.counts?.uncertain ?? 0) + (brief ? PLATFORMS.filter((p) => label(frequencyClaim(p, sources), sources) === "uncertain").length : 0);
  const body = editing ?? brief?.body ?? null;
  const isDraft = brief?.status === "draft";
  // One next step: approve a draft waiting for her; save while editing it; otherwise refresh.
  // Before the profile is locked, the step is on Client Brain.
  const approveNext = isDraft && !editing;
  const lockNext = !!data && !data.profileLocked && !isDraft;
  const refreshNext = !!data && !isDraft && !lockNext;

  const edit = (fn: (b: BriefBody) => void) => {
    if (!editing) return;
    const next = structuredClone(editing);
    fn(next);
    setEditing(next);
  };

  return (
    <div className="page">
      <PageHead
        title="Research Brief"
        lede={
          brief ? (
            <span className="nums">{`${isDraft ? "Draft" : "Approved"} v${brief.version} · ${plural(data?.counts?.sources ?? 0, "source")}${isDraft ? " · needs your approval before clips are cut" : ` · approved ${fmtDate(brief.approved_at)}`}`}</span>
          ) : (
            "When and what to post, written from your profile, your numbers and the web. Every claim links its source."
          )
        }
      >
        <button className="btn quiet" onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
          {busy === "upload" ? "Adding…" : "Upload outside report"}
        </button>
        <input ref={fileRef} type="file" hidden aria-label="Choose an outside report" accept=".pdf,.docx,.md,.txt" onChange={(e) => (e.target.files ? addReport(e.target.files).finally(() => (e.target.value = "")) : undefined)} />
        <button className={refreshNext ? "btn" : "btn quiet"} data-primary={refreshNext || undefined} onClick={() => act("refresh", () => post("/api/research/refresh"), "Researching. Usually 5 to 10 minutes; you can leave this page.")} disabled={running || busy === "refresh" || !data?.profileLocked}>
          {running ? "Researching…" : "Refresh research"}
        </button>
        {lockNext ? (
          <Link className="btn" data-primary to="/brain">
            Open Client Brain
          </Link>
        ) : null}
        {approveNext ? (
          <button className="btn" data-primary onClick={() => act("approve", () => post("/api/research/approve"), "Approved. Clips can be cut now.")} disabled={busy === "approve"}>
            Approve brief
          </button>
        ) : null}
      </PageHead>

      {loading && !data ? <Skeleton blocks={3} /> : null}

      {data && !data.profileLocked && brief ? (
        <Notice tone="warn">
          <span>
            Lock your Brand Profile first. The research starts from it. <Link to="/brain">Open Client Brain</Link>
          </span>
        </Notice>
      ) : null}
      {running ? (
        <Notice tone="info">
          <span>
            <strong>Researching…</strong> started {ago(data?.job?.created_at)}. Usually 5 to 10 minutes. The new draft appears here.
          </span>
        </Notice>
      ) : null}
      {data?.job?.status === "failed" ? (
        <Notice tone="bad">
          <span>
            The last research run stopped ({data.job.safe_error ?? "unknown reason"}). Check the AI connection, then press Refresh research. <Link to="/help/connect-openrouter">How to fix</Link>
          </span>
        </Notice>
      ) : null}
      {data?.webSkipped ? (
        <Notice tone="warn">
          <span>
            This brief was made before web search was free, so it uses your data and the posting studies only. Press Refresh research to add web sources; no web account is needed.
          </span>
        </Notice>
      ) : null}

      {data && !brief && !running ? (
        data.profileLocked ? (
          <Empty title="No brief yet" secondary={{ to: "/help/approve-research-brief", label: "How it works" }}>
            Press Refresh research at the top. We read your profile, your numbers and the web, and write a brief where every claim links its source.
          </Empty>
        ) : (
          <Empty title="No brief yet">Lock your Brand Profile on Client Brain (the button at the top), then come back and press Refresh research.</Empty>
        )
      ) : null}

      {brief && body ? (
        <>
          <div className="rs-legend" aria-label="What the labels mean">
            <span className={PILL.her_data.cls}>Her data</span>
            <span className={PILL.web.cls}>Web</span>
            <span className={PILL.upload.cls}>Upload</span>
            <span className={PILL.uncertain.cls}>Uncertain</span>
            <span className="hint">Every claim links its source. {uncertainShown ? `${plural(uncertainShown, "claim")} marked uncertain.` : ""}</span>
          </div>

          {isDraft ? (
            <div className="btn-row">
              {editing ? (
                <>
                  <button className="btn" data-primary disabled={busy === "save"} onClick={async () => (await act("save", () => patch("/api/research", { body: editing }), "Saved.")) && setEditing(null)}>
                    Save edits
                  </button>
                  <button className="btn quiet" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn quiet small" onClick={() => setEditing(structuredClone(brief.body))}>
                  Edit this draft
                </button>
              )}
            </div>
          ) : null}

          <div className="rs-layout">
            <nav className="rs-nav" aria-label="Brief sections">
              {SECTIONS.map(([id, name]) => (
                <a key={id} href={`#rs-${id}`}>
                  {name}
                </a>
              ))}
            </nav>

            <div className="rs-body">
              <Block id="times" title="Posting times">
                {PLATFORMS.map((p) => (
                  <div key={p} className="rs-sub">
                    <h4>{PLATFORM_LABEL[p]}</h4>
                    {body.best_times[p].map((s, i) => (
                      <ClaimRow key={i} lead={`${DAY[s.day]} ${hourLabel(s.hour, s.minute)}`} claim={s.claim} sources={sources} editing={!!editing} onText={(t) => edit((b) => (b.best_times[p][i].claim.text = t))} />
                    ))}
                  </div>
                ))}
              </Block>
              <Block id="often" title="How often">
                {PLATFORMS.map((p) => {
                  const claim = frequencyClaim(p, sources);
                  return <ClaimRow key={p} lead={`${PLATFORM_LABEL[p]}: ${body.best_times[p].length} a week`} claim={claim} sources={sources} editing={false} />;
                })}
              </Block>
              <Block id="audience" title="Audience">
                <Claims list={body.audience} sources={sources} editing={!!editing} onText={(i, t) => edit((b) => (b.audience[i].text = t))} />
              </Block>
              <Block id="themes" title="Content themes">
                {body.themes.map((t, i) => (
                  <div key={i} className="rs-sub">
                    <h4>{t.title}</h4>
                    <Claims list={t.claims} sources={sources} editing={!!editing} onText={(j, v) => edit((b) => (b.themes[i].claims[j].text = v))} />
                  </div>
                ))}
              </Block>
              <Block id="hooks" title="Hooks">
                <Claims list={body.hooks} sources={sources} editing={!!editing} onText={(i, t) => edit((b) => (b.hooks[i].text = t))} />
              </Block>
              <Block id="cuts" title="Cut styles + length">
                <Claims list={body.cut_styles} sources={sources} editing={!!editing} onText={(i, t) => edit((b) => (b.cut_styles[i].text = t))} />
              </Block>
              <Block id="creators" title="Creators to learn from">
                {body.comparable_creators.length === 0 ? <p className="soft">None found yet.</p> : null}
                {body.comparable_creators.map((c, i) => (
                  <ClaimRow key={i} lead={`${c.handle} · ${PLATFORM_LABEL[c.platform]}`} claim={c.why} sources={sources} editing={!!editing} onText={(t) => edit((b) => (b.comparable_creators[i].why.text = t))} />
                ))}
              </Block>
              <Block id="film" title="What to film next">
                <Claims list={body.shot_list} sources={sources} editing={!!editing} onText={(i, t) => edit((b) => (b.shot_list[i].text = t))} />
              </Block>

              <Block id="sources" title="Sources">
                <ol className="rs-sources">
                  {brief.sources.filter((s) => s.id !== "web_skipped").map((s) => (
                    <li key={s.id} id={`src-${s.id}`}>
                      <span className={PILL[s.kind].cls}>{PILL[s.kind].text}</span> {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : <span>{s.title}</span>}
                    </li>
                  ))}
                </ol>
              </Block>
            </div>
          </div>
        </>
      ) : null}

      {data?.uploads.length ? (
        <section className="section">
          <h2>Outside reports you added</h2>
          <Card className="flat">
            <div className="list">
              {data.uploads.map((u) => (
                <div key={u.id} className="list-row">
                  <div className="grow">
                    <div className="title">{u.file_name}</div>
                    <div className="meta">Added {fmtDate(u.uploaded_at)} · used on the next refresh</div>
                  </div>
                  <button className="icon-btn" aria-label={`Remove ${u.file_name}`} onClick={() => act(u.id, () => del(`/api/research/uploads/${u.id}`), "Removed.")}>
                    <Icon name="close" size="sm" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </section>
      ) : null}
      <EarlierBriefs current={data?.brief?.version ?? null} />
      <HelpButton guide="approve-research-brief" />
    </div>
  );
}

/**
 * Earlier briefs (day 358): one a month adds up. Each can be archived with Undo; the tidy rules
 * archive a replaced brief after 90 days on their own. Show archived + Restore.
 */
function EarlierBriefs({ current }: { current: number | null }) {
  const toast = useToast();
  const [archived, setArchived] = useState(false);
  const list = useLoad(() => get<ResearchData>(`/api/research${archived ? "?archived=1" : ""}`), [archived]);
  const rows = (list.data?.versions ?? []).filter((v) => v.version !== current && v.status === "superseded");
  if (!list.data || (!rows.length && !list.data.archivedVersions && !archived)) return null;
  return (
    <section className="section" aria-label="Earlier briefs">
      <div className="section-head">
        <h2>{archived ? "Archived briefs" : "Earlier briefs"}</h2>
        <button type="button" className="link-btn" onClick={() => setArchived((a) => !a)} aria-pressed={archived} data-show-archived>
          {archived ? "Back" : `Show archived (${list.data.archivedVersions})`}
        </button>
      </div>
      {rows.length === 0 ? <p className="soft">{archived ? "Nothing archived." : "No earlier briefs."}</p> : null}
      {rows.length ? (
        <Card className="flat">
          <div className="list">
            {rows.map((v) => (
              <div key={v.version} className="list-row">
                <div className="grow">
                  <div className="title">Brief from {fmtDate(v.created_at)}</div>
                  <div className="meta">{v.approved_at ? `Approved ${fmtDate(v.approved_at)}, replaced by a newer one` : "Replaced by a newer one"}</div>
                </div>
                {archived ? (
                  <button type="button" className="btn quiet small" onClick={() => restoreArchived(toast, "brief", v.version, list.reload)}>
                    Restore
                  </button>
                ) : (
                  <DismissButton label={`Archive the brief from ${fmtDate(v.created_at)}`} onClick={() => archiveWithUndo(toast, "brief", v.version, list.reload)} />
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rs-block" id={`rs-${id}`} aria-labelledby={`rs-h-${id}`}>
      <h3 id={`rs-h-${id}`}>{title}</h3>
      {children}
    </section>
  );
}

function Claims({ list, sources, editing, onText }: { list: Claim[]; sources: Map<string, BriefSource>; editing: boolean; onText: (i: number, t: string) => void }) {
  if (!list.length) return <p className="soft">Nothing here yet.</p>;
  return (
    <>
      {list.map((c, i) => (
        <ClaimRow key={i} claim={c} sources={sources} editing={editing} onText={(t) => onText(i, t)} />
      ))}
    </>
  );
}

function ClaimRow({ claim, sources, lead, editing, onText }: { claim: Claim; sources: Map<string, BriefSource>; lead?: string; editing: boolean; onText?: (t: string) => void }) {
  const pill = PILL[label(claim, sources)];
  const cited = claim.source_ids.map((id) => sources.get(id)).filter((s): s is BriefSource => !!s);
  return (
    <div className="rs-claim" data-label={label(claim, sources)}>
      <span className={pill.cls}>{pill.text}</span>
      <div className="rs-claim-body">
        {lead ? <div className="rs-lead">{lead}</div> : null}
        {editing && onText ? <textarea className="textarea" aria-label="Claim text" rows={2} value={claim.text} onChange={(e) => onText(e.target.value)} /> : <p>{claim.text}</p>}
        <div className="rs-cites">
          {cited.length === 0 ? <span className="hint">No source yet</span> : null}
          {cited.map((s) =>
            s.url ? (
              <a key={s.id} href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
            ) : (
              <span key={s.id}>{s.title}</span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
