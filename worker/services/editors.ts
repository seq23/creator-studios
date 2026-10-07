// Connected editors (docs/EDITORS.md): Opus Clip, Vizard, Klap, Submagic, Descript. Her own key
// (pasted on Connect, stored encrypted) pays with her own credits. One interface, a real client
// per vendor and a fake that returns every failure shape, so the whole flow runs without keys.
//
// NOT YET PROVEN with a live key (none exists in the owner's vault, 25 Sep 2026): the request
// shapes follow each vendor's published docs (links in docs/EDITORS.md). Every real answer is
// read defensively: anything unexpected is "failed", and a failed editor job falls back to the
// built-in editor (worker/lib/editorJobs.ts). Every call goes through `editorFetch`, and every
// refused answer through `classifyEditorError` (401/403 refused key, 402 or a credits message =
// out of credits, 429 busy).
import type { Env } from "../env";
import { fakeServices } from "../env";
import { getConnectionSecret } from "../lib/connections";
import { log } from "../lib/log";
import type { ApiEditorId, ChoosableCapability } from "../domain/editors";

export type EditorFailure = "auth" | "credits" | "busy" | "other";
export type EditorFail = { ok: false; failure: EditorFailure; status: number };

export interface EditorAccount {
  plan: string | null;
  credits_left: number | null;
  credits_total: number | null;
}

/** One finished video from the editor: a download link and what it says about it. */
export interface EditorOutput {
  url: string;
  title: string | null;
  duration_s: number | null;
}

/** memo: what the client needs to remember between polls (a multi-step API), saved on the job row. */
export type PollAnswer = ({ ok: true; state: "working"; memo?: Record<string, unknown> } | { ok: true; state: "done"; outputs: EditorOutput[] } | { ok: true; state: "failed" }) | EditorFail;

export interface EditorClient {
  account(): Promise<({ ok: true } & EditorAccount) | EditorFail>;
  /** Send a video (a link the editor downloads) for one job. */
  submit(sourceUrl: string, cap: ChoosableCapability, title: string): Promise<{ ok: true; projectId: string } | EditorFail>;
  poll(projectId: string, cap: ChoosableCapability, memo: Record<string, unknown>): Promise<PollAnswer>;
}

export function classifyEditorError(status: number, body: string): EditorFailure {
  const b = body.toLowerCase();
  if (status === 402 || /credit|quota|insufficient|balance|out of minutes|upgrade/.test(b)) return "credits";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "busy";
  return "other";
}

async function editorFetch(editor: ApiEditorId, url: string, init: RequestInit): Promise<{ ok: true; data: unknown } | EditorFail> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, failure: "other", status: 0 };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const failure = classifyEditorError(res.status, text);
    log.warn("editor.refused", { editor, status: res.status, failure });
    return { ok: false, failure, status: res.status };
  }
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: true, data: {} };
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https:\/\//.test(s) ? s : null;
};

/** Credits when an answer happens to carry them (none of the five documents it; read if present). */
function creditsFrom(d: Record<string, unknown>): EditorAccount {
  const left = num(d.credits_left ?? d.remaining_credits ?? d.creditsRemaining ?? d.remainingCredits);
  const total = num(d.credits_total ?? d.total_credits ?? d.creditsTotal);
  return { plan: str(d.plan ?? d.tier ?? d.subscription), credits_left: left, credits_total: total };
}

// ---------------------------------------------------------------- Opus Clip
// https://help.opus.pro/api-reference/overview : POST /api/clip-projects {videoUrl};
// GET /api/exportable-clips?q=findByProjectId&projectId=… → clips with uriForExport, durationMs, title.
class OpusClip implements EditorClient {
  private base = "https://api.opus.pro";
  constructor(private key: string) {}
  private h = () => ({ Authorization: `Bearer ${this.key}`, "content-type": "application/json" });
  async account() {
    // No account endpoint is published: a read of a project that cannot exist tells a refused key (401) from a good one.
    const r = await editorFetch("opusclip", `${this.base}/api/exportable-clips?q=findByProjectId&projectId=key-check`, { headers: this.h() });
    if (!r.ok && r.failure !== "other") return r;
    return { ok: true as const, ...creditsFrom(r.ok ? obj(r.data) : {}) };
  }
  async submit(sourceUrl: string) {
    const r = await editorFetch("opusclip", `${this.base}/api/clip-projects`, { method: "POST", headers: this.h(), body: JSON.stringify({ videoUrl: sourceUrl }) });
    if (!r.ok) return r;
    const d = obj(r.data);
    const id = str(d.id ?? d.projectId ?? obj(d.data).id);
    return id ? { ok: true as const, projectId: id } : { ok: false as const, failure: "other" as const, status: 200 };
  }
  async poll(projectId: string): Promise<PollAnswer> {
    const r = await editorFetch("opusclip", `${this.base}/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`, { headers: this.h() });
    if (!r.ok) return r;
    const list = arr(Array.isArray(r.data) ? r.data : obj(r.data).data);
    const outputs = list
      .map((x) => obj(x))
      .map((x) => ({ url: httpsUrl(x.uriForExport ?? x.uriForPreview) ?? "", title: str(x.title), duration_s: num(x.durationMs) !== null ? num(x.durationMs)! / 1000 : null }))
      .filter((x) => x.url);
    return outputs.length ? { ok: true, state: "done", outputs } : { ok: true, state: "working" };
  }
}

// ---------------------------------------------------------------- Vizard
// https://docs.vizard.ai/docs/quickstart : header VIZARDAI_API_KEY; POST /project/create
// {videoUrl, videoType, lang, preferLength}; GET /project/query/{projectId} (poll every 30 s).
class Vizard implements EditorClient {
  private base = "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1";
  constructor(private key: string) {}
  private h = () => ({ VIZARDAI_API_KEY: this.key, "content-type": "application/json" });
  async account() {
    const r = await editorFetch("vizard", `${this.base}/project/query/0`, { headers: this.h() });
    if (!r.ok && r.failure !== "other") return r;
    const code = num(obj(r.ok ? r.data : {}).code);
    if (code === 4001 || code === 4002) return { ok: false as const, failure: "auth" as const, status: 401 };
    return { ok: true as const, ...creditsFrom(r.ok ? obj(r.data) : {}) };
  }
  async submit(sourceUrl: string) {
    const r = await editorFetch("vizard", `${this.base}/project/create`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ videoUrl: sourceUrl, videoType: 1, ext: "mp4", lang: "en", preferLength: [0] }),
    });
    if (!r.ok) return r;
    const d = obj(r.data);
    const id = str(d.projectId ?? d.project_id);
    return id && num(d.code) === 2000 ? { ok: true as const, projectId: id } : { ok: false as const, failure: classifyEditorError(200, JSON.stringify(d)), status: 200 };
  }
  async poll(projectId: string): Promise<PollAnswer> {
    const r = await editorFetch("vizard", `${this.base}/project/query/${encodeURIComponent(projectId)}`, { headers: this.h() });
    if (!r.ok) return r;
    const d = obj(r.data);
    const code = num(d.code);
    if (code === 1000) return { ok: true, state: "working" };
    if (code !== 2000) return { ok: true, state: "failed" };
    const outputs = arr(d.videos)
      .map((x) => obj(x))
      .map((x) => ({ url: httpsUrl(x.videoUrl) ?? "", title: str(x.title), duration_s: num(x.videoMsDuration) !== null ? num(x.videoMsDuration)! / 1000 : null }))
      .filter((x) => x.url);
    return outputs.length ? { ok: true, state: "done", outputs } : { ok: true, state: "failed" };
  }
}

// ---------------------------------------------------------------- Klap
// https://docs.klap.app/ : Bearer key; tasks (create, status), projects, exports. The task path
// POST /v2/tasks/video-to-shorts is corroborated by a published workflow, not Klap's own page.
class Klap implements EditorClient {
  private base = "https://api.klap.app/v2";
  constructor(private key: string) {}
  private h = () => ({ Authorization: `Bearer ${this.key}`, "content-type": "application/json" });
  async account() {
    const r = await editorFetch("klap", `${this.base}/projects`, { headers: this.h() });
    if (!r.ok && r.failure !== "other") return r;
    return { ok: true as const, ...creditsFrom(r.ok ? obj(r.data) : {}) };
  }
  async submit(sourceUrl: string, cap: ChoosableCapability) {
    const body =
      cap === "cut_from_source"
        ? { source_video_url: sourceUrl, language: "en", max_duration: 60, editing_options: { captions: true, reframe: true } }
        : { source_video_url: sourceUrl, language: "en", editing_options: { captions: true } };
    const r = await editorFetch("klap", `${this.base}/tasks/${cap === "cut_from_source" ? "video-to-shorts" : "video-to-video"}`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    if (!r.ok) return r;
    const id = str(obj(r.data).id);
    return id ? { ok: true as const, projectId: id } : { ok: false as const, failure: "other" as const, status: 200 };
  }
  async poll(taskId: string, _cap: ChoosableCapability, memo: Record<string, unknown>): Promise<PollAnswer> {
    // step 1: the task finishes into a folder of projects; step 2: one export per project; step 3: every export ready.
    const exports = arr(memo.exports).map((x) => obj(x));
    if (!exports.length) {
      const t = await editorFetch("klap", `${this.base}/tasks/${encodeURIComponent(taskId)}`, { headers: this.h() });
      if (!t.ok) return t;
      const task = obj(t.data);
      if (task.status === "error") return { ok: true, state: "failed" };
      const folder = str(task.output_id);
      if (task.status !== "ready" || !folder) return { ok: true, state: "working" };
      const p = await editorFetch("klap", `${this.base}/projects/${encodeURIComponent(folder)}`, { headers: this.h() });
      if (!p.ok) return p;
      const started: Record<string, unknown>[] = [];
      for (const proj of arr(p.data).map((x) => obj(x)).slice(0, 20)) {
        const pid = str(proj.id);
        if (!pid) continue;
        const e = await editorFetch("klap", `${this.base}/projects/${encodeURIComponent(folder)}/${encodeURIComponent(pid)}/exports`, { method: "POST", headers: this.h(), body: "{}" });
        if (e.ok && str(obj(e.data).id)) started.push({ folder, project: pid, export: str(obj(e.data).id), title: str(proj.name) });
      }
      return started.length ? { ok: true, state: "working", memo: { exports: started } } : { ok: true, state: "failed" };
    }
    const outputs: EditorOutput[] = [];
    for (const x of exports) {
      const e = await editorFetch("klap", `${this.base}/projects/${encodeURIComponent(String(x.folder))}/${encodeURIComponent(String(x.project))}/exports/${encodeURIComponent(String(x.export))}`, { headers: this.h() });
      if (!e.ok) return e;
      const d = obj(e.data);
      if (d.status === "error") continue;
      const url = httpsUrl(d.src_url);
      if (!url) return { ok: true, state: "working", memo: { exports } };
      outputs.push({ url, title: str(x.title), duration_s: null });
    }
    return outputs.length ? { ok: true, state: "done", outputs } : { ok: true, state: "failed" };
  }
}

// ---------------------------------------------------------------- Submagic
// https://docs.submagic.co/introduction : header x-api-key; GET /health; POST /v1/projects
// {title, language, videoUrl, …}; then the project's status and its download link.
class Submagic implements EditorClient {
  private base = "https://api.submagic.co";
  constructor(private key: string) {}
  private h = () => ({ "x-api-key": this.key, "content-type": "application/json" });
  async account() {
    const r = await editorFetch("submagic", `${this.base}/v1/templates`, { headers: this.h() });
    if (!r.ok && r.failure !== "other") return r;
    return { ok: true as const, ...creditsFrom(r.ok ? obj(r.data) : {}) };
  }
  async submit(sourceUrl: string, cap: ChoosableCapability, title: string) {
    const r = await editorFetch("submagic", `${this.base}/v1/projects`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ title: title.slice(0, 80) || "Studio clip", language: "en", videoUrl: sourceUrl, magicZooms: cap === "enhance", removeSilencePace: cap === "enhance" ? "natural" : undefined }),
    });
    if (!r.ok) return r;
    const id = str(obj(r.data).id);
    return id ? { ok: true as const, projectId: id } : { ok: false as const, failure: "other" as const, status: 200 };
  }
  async poll(projectId: string, _cap: ChoosableCapability, memo: Record<string, unknown>): Promise<PollAnswer> {
    const r = await editorFetch("submagic", `${this.base}/v1/projects/${encodeURIComponent(projectId)}`, { headers: this.h() });
    if (!r.ok) return r;
    const d = obj(r.data);
    const status = String(d.status ?? "").toLowerCase();
    if (status === "failed" || status === "error") return { ok: true, state: "failed" };
    const url = httpsUrl(d.downloadUrl ?? d.directUrl ?? d.download_url);
    if (url) return { ok: true, state: "done", outputs: [{ url, title: str(d.title), duration_s: num(d.videoDuration) }] };
    if (status === "completed" && !memo.exported) {
      const e = await editorFetch("submagic", `${this.base}/v1/projects/${encodeURIComponent(projectId)}/export`, { method: "POST", headers: this.h(), body: "{}" });
      if (!e.ok) return e;
      return { ok: true, state: "working", memo: { exported: true } };
    }
    return { ok: true, state: "working" };
  }
}

// ---------------------------------------------------------------- Descript
// https://docs.descriptapi.com/ : Bearer token; GET /v1/status; POST /v1/jobs/import/project_media;
// GET /v1/jobs/{id} (job_state "stopped" = finished); POST /v1/jobs/agent (Underlord); POST /v1/jobs/publish.
class Descript implements EditorClient {
  private base = "https://descriptapi.com/v1";
  constructor(private key: string) {}
  private h = () => ({ Authorization: `Bearer ${this.key}`, "content-type": "application/json" });
  async account() {
    const r = await editorFetch("descript", `${this.base}/status`, { headers: this.h() });
    if (!r.ok) return r;
    return { ok: true as const, ...creditsFrom(obj(r.data)) };
  }
  async submit(sourceUrl: string, _cap: ChoosableCapability, title: string) {
    const r = await editorFetch("descript", `${this.base}/jobs/import/project_media`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ project_name: title.slice(0, 80) || "Studio clip", media: [{ url: sourceUrl }] }),
    });
    if (!r.ok) return r;
    const d = obj(r.data);
    const job = str(d.job_id);
    const project = str(d.project_id);
    return job && project ? { ok: true as const, projectId: `${project}:${job}` } : { ok: false as const, failure: "other" as const, status: 200 };
  }
  async poll(ref: string, _cap: ChoosableCapability, memo: Record<string, unknown>): Promise<PollAnswer> {
    const [project, firstJob] = ref.split(":");
    const stage = String(memo.stage ?? "import");
    const job = str(memo.job) ?? firstJob;
    const r = await editorFetch("descript", `${this.base}/jobs/${encodeURIComponent(job)}`, { headers: this.h() });
    if (!r.ok) return r;
    const d = obj(r.data);
    if (d.job_state !== "stopped") return { ok: true, state: "working" };
    if (d.error || d.job_status === "failed") return { ok: true, state: "failed" };
    const next = async (path: string, body: Record<string, unknown>, stageName: string): Promise<PollAnswer> => {
      const n = await editorFetch("descript", `${this.base}${path}`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
      if (!n.ok) return n;
      const id = str(obj(n.data).job_id);
      return id ? { ok: true, state: "working", memo: { stage: stageName, job: id } } : { ok: true, state: "failed" };
    };
    if (stage === "import") return next("/jobs/agent", { project_id: project, prompt: "Remove filler words and awkward pauses, apply Studio Sound, keep the 9:16 frame." }, "agent");
    if (stage === "agent") return next("/jobs/publish", { project_id: project, media_type: "video", resolution: "1080p" }, "publish");
    const url = httpsUrl(obj(d.result).download_url ?? obj(d.result).url ?? d.download_url);
    return url ? { ok: true, state: "done", outputs: [{ url, title: null, duration_s: null }] } : { ok: true, state: "failed" };
  }
}

// ---------------------------------------------------------------- fake
// Keys starting "good-" work (a plan with credits); "good-low-" have 3 of 100 credits left;
// "good-fail-" take the video but the editor's job fails (the fallback runs); "good-credits-"
// are refused for credits on submit (402); anything else is a refused key (401). A fake job is
// done on its first poll: a cut returns three clips, a caption or polish returns one video.
// Outputs are fake://… links; the import (the cut job's fake runner) writes real tiny MP4s.
const REFUSED: EditorFail = { ok: false, failure: "auth", status: 401 };

export class FakeEditor implements EditorClient {
  constructor(
    private editor: ApiEditorId,
    private key: string,
  ) {}
  private get good() {
    return this.key.startsWith("good-");
  }
  async account() {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-low-")) return { ok: true as const, plan: "Pro", credits_left: 3, credits_total: 100 };
    return { ok: true as const, plan: "Pro", credits_left: 240, credits_total: 300 };
  }
  async submit(sourceUrl: string, cap: ChoosableCapability, _title = "") {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-credits-")) return { ok: false as const, failure: classifyEditorError(402, "insufficient credits"), status: 402 };
    if (!/^https?:\/\//.test(sourceUrl)) return { ok: false as const, failure: "other" as const, status: 400 };
    return { ok: true as const, projectId: `fake_${this.editor}_${cap}_${Math.random().toString(36).slice(2, 10)}` };
  }
  async poll(projectId: string, cap: ChoosableCapability, _memo: Record<string, unknown> = {}): Promise<PollAnswer> {
    if (!this.good) return REFUSED;
    if (this.key.startsWith("good-fail-")) return { ok: true, state: "failed" };
    if (!projectId.startsWith("fake_")) return { ok: true, state: "failed" };
    if (cap === "cut_from_source")
      return {
        ok: true,
        state: "done",
        outputs: [
          { url: "fake://clip/0", title: "The part everyone asks about", duration_s: 32 },
          { url: "fake://clip/1", title: "My honest take", duration_s: 41 },
          { url: "fake://clip/2", title: "Wait for the end", duration_s: 55 },
        ],
      };
    return { ok: true, state: "done", outputs: [{ url: "fake://clip/0", title: null, duration_s: null }] };
  }
}

export function editorClient(env: Env, editor: ApiEditorId, key: string): EditorClient {
  if (fakeServices(env)) return new FakeEditor(editor, key);
  switch (editor) {
    case "opusclip":
      return new OpusClip(key);
    case "vizard":
      return new Vizard(key);
    case "klap":
      return new Klap(key);
    case "submagic":
      return new Submagic(key);
    case "descript":
      return new Descript(key);
  }
}

/** The client for a connected editor (its stored key), or null when it is not connected. */
export async function getEditor(env: Env, editor: ApiEditorId): Promise<EditorClient | null> {
  const key = await getConnectionSecret(env, editor);
  return key ? editorClient(env, editor, key) : null;
}
