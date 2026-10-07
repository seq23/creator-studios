// Dump (section 7): three doors (new videos, old posts, a full video for YouTube), drop files,
// notes, the Dump button, progress, recent dumps.
// Phone-first: "Choose from camera roll", many files at once, resumable chunked uploads.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AssetRow, DumpSummary } from "@shared/types";
import { del, get, patch, post } from "../lib/api";
import { uploadFile } from "../lib/upload";
import { fmtBytes, plural } from "../lib/format";
import { Card, HelpButton, Notice, PageHead, useLoad, useToast } from "../components/ui";
import { DumpHistory } from "../components/DumpHistory";
import { PLATFORMS, PLATFORM_LABEL } from "@shared/constants";
import { Icon } from "../components/Icon";
import { NotFollowedList, SteerPanel, UnderstoodNote, type SteerLook, type SteerTrack } from "../components/Steer";
import type { SteerControls, Understood } from "@shared/steer";
import "../styles/dump.css";

type Door = "new" | "recycle" | "youtube";

// Which videos she is dumping, in her words (owner, 26 Sep 2026: "super clear which door u r
// choosing"). Nothing is picked until she taps one; the Dump button repeats her choice.
const DOORS: Record<Door, { title: string; line: string; hint: string; picked: string; noun: [string, string] }> = {
  new: {
    title: "New videos I just filmed",
    line: "We cut them into fresh clips.",
    hint: "Pick this for footage you haven't posted anywhere yet. For example: 20 minutes from your kitchen today becomes 10 to 20 short clips.",
    picked: "New videos I just filmed",
    noun: ["new video", "new videos"],
  },
  recycle: {
    title: "Old posts to reuse",
    line: "We give past videos a new life.",
    hint: "Pick this for videos you already posted. For example: last spring's recipe reel gets a new opening and caption, and waits 90 days before it goes back to the same app.",
    picked: "Old posts to reuse",
    noun: ["old post", "old posts"],
  },
  // The full-video door (owner, 26 Sep 2026): the whole video, uncut, as a normal YouTube video.
  youtube: {
    title: "A full video for YouTube",
    line: "We post it whole, not cut up.",
    hint: "Pick this for one long video that goes on YouTube as it is: no cutting, no vertical crop. We write the title, description, chapters and tags from what you say, and give you three thumbnails to pick from. You approve it in Review. Vertical and 3 minutes or less: it posts through Buffer. Longer or landscape: you upload it yourself in two taps, because YouTube only lets apps post Shorts.",
    picked: "A full video for YouTube",
    noun: ["full video", "full videos"],
  },
};

const DOOR_ICON: Record<Door, "plus" | "arrow" | "review"> = { new: "plus", recycle: "arrow", youtube: "review" };

interface Local {
  file: File;
  fraction: number;
  status: "uploading" | "uploaded" | "failed";
  assetId?: string;
  error?: string;
}

export function Dump() {
  const { id: routeId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [door, setDoor] = useState<Door | null>(null);
  const [hintOpen, setHintOpen] = useState<Door | null>(null);
  const [steer, setSteer] = useState<SteerControls>({});
  const [understood, setUnderstood] = useState<Understood | null>(null);
  const understandTimer = useRef<number | null>(null);
  const editing = useLoad(() => get<{ looks: SteerLook[]; music: SteerTrack[] }>("/api/editing"));
  // The Voice over chip's default: the Settings switch, and whether her voice is saved.
  const voiceState = useLoad(() => get<{ auto: "on" | "needs_voice" | "off"; hasSample: boolean }>("/api/voice"));
  const [dumpId, setDumpId] = useState<string | null>(routeId ?? null);
  const [notes, setNotes] = useState("");
  const [local, setLocal] = useState<Local[]>([]);
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Your dumps (paged, searchable, archivable: app/components/DumpHistory.tsx) reloads when this changes.
  const [historyKey, setHistoryKey] = useState(0);
  // Free space before every upload (day 358): every file counted, the free 10 GB.
  const storage = useLoad(() => get<{ free: number; line: string; light: "green" | "yellow" | "red" }>("/api/uploads/storage"), [dumpId]);
  const current = useLoad(() => (dumpId ? get<{ dump: DumpSummary; assets: AssetRow[] }>(`/api/dumps/${dumpId}`) : Promise.resolve(null)), [dumpId]);
  // Uploads outlive the render that started them; always reload through the latest loader.
  const reloadRef = useRef(current.reload);
  reloadRef.current = current.reload;
  const reloadCurrent = useCallback(() => reloadRef.current(), []);
  const dumpStatus = current.data?.dump.status;
  // The full-video door: this video's size and what's left of the free 10 GB, before Dump.
  const uploadedIds = (current.data?.assets ?? []).filter((a) => a.upload_status === "uploaded").map((a) => a.id).join(",");
  const space = useLoad(() => (dumpId && door === "youtube" && uploadedIds ? get<{ line: string; fits: boolean }>(`/api/dumps/${dumpId}/space`) : Promise.resolve(null)), [dumpId, door, uploadedIds]);

  useEffect(() => {
    if (current.data) {
      setDoor(current.data.dump.door);
      setNotes(current.data.dump.notes);
      setSteer(current.data.dump.steer ?? {});
      setUnderstood(current.data.dump.understood ?? null);
    }
  }, [current.data]);

  // A dump in progress polls its status while cutting.
  useEffect(() => {
    if (!dumpStatus || !["queued", "cutting"].includes(dumpStatus)) return;
    const t = setInterval(reloadCurrent, 8000);
    return () => clearInterval(t);
  }, [dumpStatus, reloadCurrent]);

  const ensureDump = useCallback(async (): Promise<string> => {
    if (dumpId) return dumpId;
    if (!door) throw new Error("First pick which videos these are: new videos you just filmed, old posts to reuse, or a full video for YouTube.");
    const r = await post<{ id: string }>("/api/dumps", { door, notes });
    setDumpId(r.id);
    nav(`/dump/${r.id}`, { replace: true });
    return r.id;
  }, [dumpId, door, notes, nav]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name));
    if (!list.length) {
      toast.bad(new Error("Pick video files (MOV, MP4, WebM)."));
      return;
    }
    let id: string;
    try {
      id = await ensureDump();
    } catch (e) {
      toast.bad(e);
      return;
    }
    const start = local.length;
    setLocal((xs) => [...xs, ...list.map((file) => ({ file, fraction: 0, status: "uploading" as const }))]);
    // Upload three at a time so a phone connection is not swamped.
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const i = idx++;
        const file = list[i];
        const pos = start + i;
        try {
          const h = await uploadFile(file, "video", id, (fraction) => setLocal((xs) => xs.map((x, j) => (j === pos ? { ...x, fraction } : x))));
          setLocal((xs) => xs.map((x, j) => (j === pos ? { ...x, status: "uploaded", fraction: 1, assetId: h.id } : x)));
        } catch (e) {
          setLocal((xs) => xs.map((x, j) => (j === pos ? { ...x, status: "failed", error: e instanceof Error ? e.message : "failed" } : x)));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    reloadCurrent();
  }

  async function saveNotes(v: string) {
    setNotes(v);
    // Here's what we understood: read shortly after she stops typing (rules, plus the free AI when connected).
    if (understandTimer.current) window.clearTimeout(understandTimer.current);
    understandTimer.current = window.setTimeout(async () => {
      if (!v.trim()) return setUnderstood(null);
      try {
        setUnderstood(await post<Understood>("/api/dumps/understand", { text: v }));
      } catch {
        /* the note is still read when she presses Dump */
      }
    }, 700);
    if (dumpId) await patch(`/api/dumps/${dumpId}`, { notes: v }).catch(() => undefined);
  }

  async function pickDoor(d: Door) {
    setDoor(d);
    if (dumpId) await patch(`/api/dumps/${dumpId}`, { door: d }).catch(() => undefined);
  }

  async function changeSteer(next: SteerControls) {
    setSteer(next);
    if (dumpId) await patch(`/api/dumps/${dumpId}`, { steer: next }).catch(() => undefined);
  }

  async function removeAsset(assetId: string) {
    if (!dumpId) return;
    try {
      await del(`/api/dumps/${dumpId}/assets/${assetId}`);
      setLocal((xs) => xs.filter((x) => x.assetId !== assetId));
      reloadCurrent();
    } catch (e) {
      toast.bad(e);
    }
  }

  async function send() {
    if (!dumpId) return;
    setSending(true);
    try {
      await patch(`/api/dumps/${dumpId}`, { notes, steer, understood });
      await post(`/api/dumps/${dumpId}/dump`);
      toast.ok("Dumped. We’ll email you when the clips are ready to review.");
      setLocal([]);
      reloadCurrent();
      setHistoryKey((n) => n + 1);
    } catch (e) {
      toast.bad(e);
    } finally {
      setSending(false);
    }
  }

  function startNew() {
    setDumpId(null);
    setLocal([]);
    setNotes("");
    setDoor(null);
    setSteer({});
    setUnderstood(null);
    nav("/dump", { replace: true });
  }

  const dump = current.data?.dump ?? null;
  const assets = current.data?.assets ?? [];
  const editable = !dump || dump.status === "uploading";
  const uploading = local.some((l) => l.status === "uploading");
  const uploadedCount = new Set([...local.filter((l) => l.status === "uploaded").map((l) => l.assetId), ...assets.filter((a) => a.upload_status === "uploaded").map((a) => a.id)]).size;
  const totalBytes = assets.reduce((n, a) => n + a.size_bytes, 0);
  // The one next step: choose videos until something is uploaded, then press Dump.
  const hasVideos = uploadedCount > 0;

  return (
    <div className="page">
      <PageHead title="Dump videos" lede="Drop in your footage. We cut it into short clips and email you when they’re ready to approve.">
        {dump && !editable ? (
          dump.status === "ready" ? (
            <>
              <button className="btn quiet" onClick={startNew}>
                Start a new dump
              </button>
              <Link to="/review" className="btn" data-primary>
                Review the clips
              </Link>
            </>
          ) : (
            <button className="btn" data-primary onClick={startNew}>
              Start a new dump
            </button>
          )
        ) : null}
      </PageHead>

      <div className="split">
        <div className="section dump-main">
          {editable ? (
            <>
              <div className="door-pick" role="radiogroup" aria-label="Which videos are these?">
                {(["new", "recycle", "youtube"] as Door[]).map((d) => (
                  <div key={d} className="door-wrap">
                    <button type="button" role="radio" aria-checked={door === d} className={`door-card${door === d ? " on" : ""}`} data-door={d} onClick={() => pickDoor(d)}>
                      <span className="door-icon" aria-hidden="true">
                        <Icon name={door === d ? "check" : DOOR_ICON[d]} />
                      </span>
                      <span className="door-text">
                        <span className="door-title">{DOORS[d].title}</span>
                        <span className="hint">{DOORS[d].line}</span>
                      </span>
                    </button>
                    <button type="button" className="door-hint-btn" aria-label={`What does "${DOORS[d].title}" mean?`} aria-expanded={hintOpen === d} aria-controls={`door-hint-${d}`} onClick={() => setHintOpen((h) => (h === d ? null : d))}>
                      ?
                    </button>
                    {hintOpen === d ? (
                      <div id={`door-hint-${d}`} className="door-hint" role="note">
                        {DOORS[d].hint}{" "}
                        <button type="button" className="link-btn" onClick={() => setHintOpen(null)}>
                          Got it
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="door-picked" aria-live="polite" data-door-picked>
                {door ? (
                  <>
                    <Icon name="check" size="sm" /> You picked: {DOORS[door].picked}
                  </>
                ) : (
                  <>First, tap which videos these are.</>
                )}
              </p>

              <div
                className={`dropzone ${over ? "over" : ""}`}
                aria-disabled={!door}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (door) setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  if (door) addFiles(e.dataTransfer.files);
                  else toast.bad(new Error("First tap which videos these are, above."));
                }}
                onClick={() => (door ? inputRef.current?.click() : toast.bad(new Error("First tap which videos these are, above.")))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === "Enter" && door ? inputRef.current?.click() : undefined)}
              >
                <div className="dropzone-title">{door === "youtube" ? "Drop your video here" : "Drop videos here"}</div>
                <div className="hint">{door === "youtube" ? "one video, landscape or any shape · it goes up whole" : "or choose from your camera roll · any size · many at once"}</div>
                {hasVideos ? (
                  <span className="btn quiet dump-choose">
                    <Icon name="plus" size="sm" /> Choose videos
                  </span>
                ) : (
                  <span className="btn dump-choose" data-primary>
                    Choose videos
                  </span>
                )}
                <input ref={inputRef} type="file" accept="video/*" multiple={door !== "youtube"} hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
              </div>
            </>
          ) : (
            <Notice tone={dump.status === "failed" ? "bad" : dump.status === "ready" ? "ok" : "info"}>
              <span>
                {dump.status === "queued" || dump.status === "cutting" ? (
                  <>
                    <strong>Cutting…</strong> {dump.progress ? `${dump.progress.step} (${dump.progress.done}/${dump.progress.total})` : "usually 10 to 30 minutes"}. We’ll email you when the clips are ready. You can leave this page.
                  </>
                ) : dump.status === "ready" ? (
                  <>
                    <strong>{plural(dump.clips_made, "clip")} ready.</strong> <Link to="/review">Review them now</Link>
                    {dump.tried ? <span className="tried" data-tried> {dump.tried}</span> : null}
                  </>
                ) : dump.status === "reviewed" ? (
                  <>This dump has been reviewed.</>
                ) : (
                  <>
                    <strong>Something went wrong cutting this dump.</strong> {dump.error_summary ?? ""} <Link to="/help/clips-look-wrong">What to do</Link>
                  </>
                )}
              </span>
            </Notice>
          )}

          {dump && !editable ? <NotFollowedList items={dump.not_followed ?? []} /> : null}

          {(local.length > 0 || assets.length > 0) && (
            <Card className="flat">
              <div className="row between">
                <strong>
                  {plural(Math.max(local.length, assets.length), "video")}
                  {totalBytes ? ` · ${fmtBytes(totalBytes)}` : ""}
                </strong>
                {uploading ? <span className="pill warn">Uploading · keep this page open</span> : null}
              </div>
              <div className="list">
                {local.map((l, i) => (
                  <div key={`l${i}`} className="list-row">
                    <div className="grow">
                      <div className="title truncate">{l.file.name}</div>
                      <div className={`meter dump-meter${l.status === "failed" ? " bad" : ""}`}>
                        <span style={{ width: `${l.fraction * 100}%` }} />
                      </div>
                    </div>
                    <span className="meta nums dump-pct">{l.status === "uploaded" ? "Uploaded" : l.status === "failed" ? "Failed" : `${Math.round(l.fraction * 100)}%`}</span>
                  </div>
                ))}
                {assets
                  .filter((a) => !local.some((l) => l.assetId === a.id))
                  .map((a) => (
                    <AssetLine key={a.id} asset={a} door={door === "recycle" ? "recycle" : "new"} dumpId={dumpId!} editable={editable} onRemove={() => removeAsset(a.id)} onSaved={reloadCurrent} />
                  ))}
              </div>
            </Card>
          )}

          {editable && door === "youtube" && space.data ? (
            <p className={`hint space-line${space.data.fits ? "" : " look-error"}`} data-space-line>
              {space.data.line}
              {space.data.fits ? "" : ". It won't fit: delete a few old videos first, or use a smaller export."}
            </p>
          ) : null}

          {editable && door === "youtube" ? (
            <div className="row wrap">
              <button className="btn big" data-primary={hasVideos ? true : undefined} disabled={sending || uploading || uploadedCount !== 1 || space.data?.fits === false} onClick={send} data-dump-button>
                {sending ? "Sending…" : "Dump 1 full video"}
              </button>
              <span className="hint">{uploadedCount > 1 ? "A full video is one video. Remove the others, or dump them as new videos." : "No cutting, no vertical crop: we draft the title, description, chapters, tags and three thumbnails. We'll email you when it's ready to approve."}</span>
            </div>
          ) : null}

          {editable && door !== "youtube" ? (
            <>
              <div className="field">
                <label htmlFor="notes">Notes for this dump</label>
                <textarea
                  id="notes"
                  className="textarea"
                  rows={3}
                  value={notes}
                  onChange={(e) => saveNotes(e.target.value)}
                  placeholder="e.g. Trip weekend, lean funny. All 2x4 grids, no music, keep them short. Don't use the part where I cough."
                />
                <div className="hint">You can ask for looks (like a 2x4 grid), music, pace, length, how many clips, captions, platforms, and moments to keep in or leave out.</div>
                <UnderstoodNote understood={understood} />
              </div>
              <SteerPanel
                steer={steer}
                onChange={changeSteer}
                looks={editing.data?.looks ?? []}
                tracks={editing.data?.music ?? []}
                voice={{ choice: voiceState.data?.auto === "off" ? "none" : "quiet", hasVoice: !!voiceState.data?.hasSample }}
              />
              <div className="row wrap">
                <button className="btn big" data-primary={hasVideos && door ? true : undefined} disabled={!door || sending || uploading || uploadedCount === 0} onClick={send} data-dump-button>
                  {sending ? "Sending…" : door ? `Dump ${uploadedCount || ""} ${uploadedCount === 1 ? DOORS[door].noun[0] : DOORS[door].noun[1]}`.replace("  ", " ") : "Dump"}
                </button>
                <span className="hint">We’ll email you when the clips are ready to review.</span>
                {storage.data ? (
                  <span className={`hint dump-space${storage.data.light !== "green" ? " warn" : ""}`} data-free-space>
                    Storage: {storage.data.line}.{storage.data.light !== "green" ? <> <Link to="/settings#storage">What takes the space</Link></> : null}
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <DumpHistory refreshKey={historyKey} />
      </div>
      <HelpButton guide={door === "recycle" ? "recycle-old-videos" : "dump-new-footage"} />
    </div>
  );
}

function AssetLine({ asset, door, dumpId, editable, onRemove, onSaved }: { asset: AssetRow; door: "new" | "recycle"; dumpId: string; editable: boolean; onRemove: () => void; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState(asset.original_platform ?? "");
  const [posted, setPosted] = useState(asset.original_posted_at?.slice(0, 10) ?? "");
  const [views, setViews] = useState(asset.original_views?.toString() ?? "");
  const [note, setNote] = useState(asset.file_note ?? "");
  async function save() {
    await patch(`/api/dumps/${dumpId}/assets/${asset.id}`, { fileNote: note, originalPlatform: platform || undefined, originalPostedAt: posted || undefined, originalViews: views ? Number(views) : undefined }).catch(() => undefined);
    setOpen(false);
    onSaved();
  }
  return (
    <div>
      <div className="list-row">
        <div className="grow">
          <div className="title truncate">{asset.file_name}</div>
          <div className="meta">
            {fmtBytes(asset.size_bytes)}
            {asset.file_note ? ` · ${asset.file_note}` : ""}
            {door === "recycle" && asset.original_platform ? ` · ${asset.original_platform}${asset.original_views ? ` · ${asset.original_views.toLocaleString()} views` : ""}` : ""}
          </div>
          <UnderstoodNote understood={asset.understood ?? null} compact />
        </div>
        {editable ? (
          <>
            <button className="btn quiet small" onClick={() => setOpen((v) => !v)}>
              {door === "recycle" ? "Posted on…" : "Note"}
            </button>
            <button className="icon-btn" aria-label="Remove this video" onClick={onRemove}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <span className="meta">{asset.upload_status === "uploaded" ? "Uploaded" : asset.upload_status}</span>
        )}
      </div>
      {open ? (
        <div className="section dump-asset-edit">
          <div className="field">
            <label>Note for this video</label>
            <div className="hint">It steers this video's clips, the same way as the dump's note.</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know? e.g. only the first minute, make it a grid, no music" />
          </div>
          {door === "recycle" ? (
            <div className="grid cols-3">
              <div className="field">
                <label>Where it was posted</label>
                <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  <option value="">Not sure</option>
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>When (roughly)</label>
                <input className="input" type="date" value={posted} onChange={(e) => setPosted(e.target.value)} />
              </div>
              <div className="field">
                <label>Views, if you know</label>
                <input className="input" inputMode="numeric" value={views} onChange={(e) => setViews(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 12000" />
              </div>
            </div>
          ) : null}
          <div className="btn-row">
            <button className="btn small" onClick={save}>
              Save
            </button>
            <button className="btn quiet small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
