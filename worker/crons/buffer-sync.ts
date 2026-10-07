// Hourly Buffer sync (section 10 + 11):
//   1. plan ahead: keep the next 4 weeks filled from the approved pool (idempotent), and pull
//      anything whose clip is no longer approved off the calendar (nothing posts unapproved)
//   2. check Buffer (key + channels) every few hours, or every hour while something is broken
//   3. load planned posts inside the next 7 days into Buffer, never past 10 queued per channel
//   4. read back posts whose time has come → posted / failed; re-create failures up to twice,
//      then the "Posting problem" email and a red light for that channel
//   5. health rows: Buffer, each channel, Clip cutting, Email (Resend), Job runner (GitHub)
//   6. "Connection needs you" email once per flip from ok to broken
// Every decision is a pure function in domain/sync.ts. Logs carry counts only.
import type { Env } from "../env";
import { fakeServices } from "../env";
import { getSetting, parseJson, recordEvent, setHealth, setSetting } from "../lib/db";
import { getConnectionSecret, markConnection, type Service } from "../lib/connections";
import { mediaToken, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { planAhead } from "../routes/posts";
import { POSTABLE_CLIP_SQL } from "../domain/sourceCheck";
import { readSettings } from "../routes/settings";
import { bufferRequests, getBuffer, type BufferChannel, type BufferClient } from "../services/buffer";
import { emailFrame, sendEmail } from "../services/email";
import { checkEditor, checkFirecrawl, checkHunter, checkOpenRouter, type KeyCheck } from "../services/keychecks";
import { API_EDITORS } from "../domain/editors";
import { writeEditorCheckLight } from "../lib/editorJobs";
import { recheckElevenLabs } from "../lib/premiumVoice";
import { directMode, writeLight as writeYouTubeLight, youtubeAccessToken, youtubeDirectSync } from "../lib/youtubeDirect";
import {
  bufferDueAt,
  channelHealth,
  choosePostsToLoad,
  connectionFlips,
  createFailureDecision,
  dueForReadBack,
  queueUsed,
  readBackDecision,
  shouldCheckBuffer,
  type ConnState,
} from "../domain/sync";
import { BUFFER_MAX_RETRIES, BUFFER_QUEUE_LIMIT_PER_CHANNEL, PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";

export const CHANNEL_HEALTH_NAME: Record<Platform, string> = {
  tiktok: "TikTok (via Buffer)",
  instagram: "Instagram (via Buffer)",
  youtube: "YouTube (via Buffer)",
};

/** Settings key holding each connection's state at the end of the last run (flip detection). */
const STATES_KEY = "connection_states";

interface BufferMeta {
  channels?: BufferChannel[];
  organization_id?: string;
  checked_at?: string;
  queue?: Partial<Record<Platform, number>>;
}

interface BufferState {
  connected: boolean; // a key is stored
  ok: boolean; // the key works (as of the last check)
  error: string | null;
  channels: Partial<Record<Platform, BufferChannel>>;
  remoteQueue: Partial<Record<Platform, number>>;
  checkedNow: boolean;
}

async function bufferState(env: Env, client: BufferClient, force: boolean): Promise<BufferState> {
  const row = await env.DB.prepare("SELECT status, meta, last_error FROM connections WHERE service = 'buffer'").first<{ status: string; meta: string; last_error: string | null }>();
  const key = await getConnectionSecret(env, "buffer");
  const meta = parseJson<BufferMeta>(row?.meta, {});
  const byPlatform = (list: BufferChannel[] | undefined) => Object.fromEntries((list ?? []).map((c) => [c.platform, c])) as Partial<Record<Platform, BufferChannel>>;
  if (!key) return { connected: false, ok: false, error: null, channels: {}, remoteQueue: {}, checkedNow: false };

  const cached = byPlatform(meta.channels);
  // A channel she has not added yet is not "broken" (checking hourly for it would spend the API budget).
  const broken = row?.status !== "ok" || PLATFORMS.some((p) => cached[p] && (!cached[p]!.connected || cached[p]!.paused));
  if (!shouldCheckBuffer(meta.checked_at ?? null, nowIso(), broken, force)) {
    return { connected: true, ok: row?.status === "ok", error: row?.last_error ?? null, channels: cached, remoteQueue: meta.queue ?? {}, checkedNow: false };
  }
  const r = await client.checkKey();
  if (!r.ok) {
    await markConnection(env, "buffer", "error", r.error, { checked_at: nowIso() });
    return { connected: true, ok: false, error: r.error, channels: {}, remoteQueue: {}, checkedNow: true };
  }
  const channels = byPlatform(r.channels);
  const remoteQueue: Partial<Record<Platform, number>> = {};
  for (const p of PLATFORMS) {
    const ch = channels[p];
    if (!ch || !ch.connected) continue;
    const n = await client.queueCount(ch.id);
    if (n >= 0) remoteQueue[p] = n;
  }
  const patch: BufferMeta = { channels: r.channels, checked_at: nowIso(), queue: remoteQueue };
  if (r.organizationId) patch.organization_id = r.organizationId;
  await markConnection(env, "buffer", "ok", null, patch as Record<string, unknown>);
  return { connected: true, ok: true, error: null, channels, remoteQueue, checkedNow: true };
}

async function alreadyEmailed(env: Env, kind: string, refId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT id FROM emails_sent WHERE kind = ? AND ref_id = ? LIMIT 1").bind(kind, refId).first());
}

async function postingProblemEmail(env: Env, post: { id: string; platform: Platform; scheduled_at: string; hook_text: string; error: string | null }) {
  const s = await readSettings(env);
  const when = new Date(post.scheduled_at).toLocaleString("en-US", { timeZone: s.audience_timezone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const label = PLATFORM_LABEL[post.platform];
  const lines = [
    `The ${label} post of “${post.hook_text || "your clip"}” (planned for ${when}) did not go out. We tried ${BUFFER_MAX_RETRIES + 1} times.`,
    post.error ? `What Buffer said: ${post.error}` : "Buffer did not say why.",
    `How to fix it: open Buffer, go to Channels, and check that ${label} says Connected. If it says Reconnect, press it and log in to ${label}.`,
    "Then open the Calendar in your dashboard, find the red post and press Try again. Or press Take off to put the clip back in your pool.",
  ];
  const { html, text } = emailFrame("A post did not go out", lines, { label: "Show me how to fix it", url: `${env.PUBLIC_BASE_URL}/help/a-post-failed` });
  await sendEmail(env, { kind: "posting_problem", to: s.notify_emails, subject: `Posting problem: a ${label} post did not go out`, html, text, refId: post.id });
}

const CONNECTION_COPY: Record<string, { title: string; steps: string[]; guide: string }> = {
  Buffer: { title: "Buffer", steps: ["Open Buffer and go to Settings, then API.", "Create a new key and copy it.", "In your dashboard open Settings, Connect accounts, paste it under Buffer and press Check key."], guide: "reconnect-buffer" },
  [CHANNEL_HEALTH_NAME.tiktok]: { title: "TikTok in Buffer", steps: ["Open Buffer and go to Channels.", "Next to TikTok press Reconnect.", "Log in to TikTok and press Allow."], guide: "reconnect-an-account" },
  [CHANNEL_HEALTH_NAME.instagram]: { title: "Instagram in Buffer", steps: ["Open Buffer and go to Channels.", "Next to Instagram press Reconnect.", "Log in to Instagram and press Allow."], guide: "reconnect-an-account" },
  [CHANNEL_HEALTH_NAME.youtube]: { title: "YouTube in Buffer", steps: ["Open Buffer and go to Channels.", "Next to YouTube press Reconnect.", "Log in to Google, pick your channel and press Allow."], guide: "reconnect-an-account" },
  meta: { title: "Instagram stats", steps: ["In your dashboard open Settings, Connect accounts.", "Under Instagram stats press Reconnect.", "Log in to Instagram and pick your account."], guide: "reconnect-meta" },
  youtube: { title: "YouTube (full videos)", steps: ["In your dashboard open Settings, Connect accounts.", "Under YouTube · full videos tap Reconnect YouTube.", "Pick your Google account, tap Advanced, then Go to workers.dev (unsafe), then Continue. Until then your full videos wait on Home under Upload it yourself."], guide: "reconnect-youtube" },
  google: { title: "YouTube stats", steps: ["In your dashboard open Settings, Connect accounts.", "Under YouTube stats press Reconnect.", "Log in to Google and pick your channel."], guide: "reconnect-google" },
  tiktok: { title: "TikTok stats", steps: ["In your dashboard open Settings, Connect accounts.", "Under TikTok stats press Reconnect.", "Log in to TikTok and press Allow."], guide: "reconnect-tiktok" },
  openrouter: { title: "The AI (OpenRouter)", steps: ["Open OpenRouter and go to Keys.", "Create a new key and copy it.", "In your dashboard open Settings, Connect accounts, paste it under OpenRouter and press Check key."], guide: "reconnect-openrouter" },
  firecrawl: { title: "Web research (Firecrawl)", steps: ["Open Firecrawl and go to API Keys.", "Copy your key.", "In your dashboard open Settings, Connect accounts, paste it under Firecrawl and press Check key."], guide: "reconnect-firecrawl" },
  hunter: { title: "Hunter", steps: ["Open Hunter and go to API.", "Copy your key.", "In your dashboard open Settings, Connect accounts, paste it under Hunter and press Check key."], guide: "reconnect-hunter" },
  elevenlabs: { title: "Premium voice overs (ElevenLabs)", steps: ["Open ElevenLabs, tap your profile, then API keys.", "Create a new key and copy it.", "In your dashboard open Settings, Connect accounts, paste it under ElevenLabs and press Check key. Until then your voice overs use the built-in voice."], guide: "reconnect-elevenlabs" },
};

async function connectionNeedsYouEmail(env: Env, name: string) {
  const copy = CONNECTION_COPY[name];
  if (!copy) return;
  const s = await readSettings(env);
  const lines = [`${copy.title} stopped working, so the dashboard cannot use it until you reconnect it. Nothing is lost: posts wait safely.`, "Here is exactly what to do:", ...copy.steps.map((t, i) => `${i + 1}. ${t}`)];
  const { html, text } = emailFrame(`${copy.title} needs you`, lines, { label: "Show me with pictures", url: `${env.PUBLIC_BASE_URL}/help/${copy.guide}` });
  await sendEmail(env, { kind: "connection_needs_you", to: s.notify_emails, subject: `${copy.title} needs you: reconnect it`, html, text, refId: name });
}

// ---------------------------------------------------------------- the run

/** A full video's post: its title and the privacy she picked (the description is its caption). */
function fullVideoArgs(row: { full_video: number; youtube: string | null }): { privacy?: "public" | "unlisted" | "private" } {
  if (!row.full_video) return {};
  const d = parseJson<{ privacy?: "public" | "unlisted" | "private" } | null>(row.youtube, null);
  return { privacy: d?.privacy ?? "public" };
}

/**
 * Buffer would not take a full video (too big or too long for it, or refused): the last resort is
 * hers to do in two taps. Home shows "Download for YouTube" and YouTube Studio's upload page; the
 * daily public-stats read (or the link she pastes) marks it posted. No Google sign-in is needed.
 */
export async function fullVideoHandoff(env: Env, clipId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT youtube FROM clips WHERE id = ? AND full_video = 1").bind(clipId).first<{ youtube: string | null }>();
  if (!row) return;
  const d = parseJson<Record<string, unknown>>(row.youtube, {});
  if (d.handoff) return;
  d.handoff = true;
  await env.DB.prepare("UPDATE clips SET youtube = ? WHERE id = ?").bind(JSON.stringify(d), clipId).run();
  await recordEvent(env.DB, "fullvideo.handoff", clipId, {});
  log.info("fullvideo.handoff", {});
}

export async function bufferSync(env: Env, opts: { force?: boolean } = {}): Promise<void> {
  // Requests actually sent (checkKey is two: account + channels), not client method calls: the
  // log undercounted by one per check until the Phase 0 live test (25 Sep 2026).
  const sentBefore = bufferRequests.n;
  const client = await getBuffer(env);
  const now = nowIso();

  // 1. plan ahead + pull unapproved clips off the calendar
  const plan = await planAhead(env, { respectHeld: true });
  const { results: unapproved } = await env.DB.prepare(
    `SELECT p.id, p.buffer_post_id FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.status IN ('planned','in_buffer') AND NOT (${POSTABLE_CLIP_SQL})`,
  ).all<{ id: string; buffer_post_id: string | null }>();
  for (const p of unapproved) {
    if (p.buffer_post_id) await client.deletePost(p.buffer_post_id);
    await env.DB.prepare("UPDATE posts SET status = 'unscheduled', buffer_post_id = NULL WHERE id = ?").bind(p.id).run();
  }

  // 2. Buffer state
  const buf = await bufferState(env, client, !!opts.force);
  const ready = Object.fromEntries(PLATFORMS.map((p) => [p, buf.ok && !!buf.channels[p]?.connected && !buf.channels[p]?.paused])) as Record<Platform, boolean>;

  // 3. load
  const { results: inBufferRows } = await env.DB.prepare("SELECT platform, COUNT(*) AS n FROM posts WHERE status = 'in_buffer' GROUP BY platform").all<{ platform: Platform; n: number }>();
  const local = Object.fromEntries(inBufferRows.map((r) => [r.platform, r.n])) as Partial<Record<Platform, number>>;
  const used = queueUsed(local, buf.remoteQueue);
  const { results: plannedRows } = await env.DB.prepare(
    `SELECT p.id, p.platform, p.scheduled_at, p.retries, c.id AS clip_id, c.caption, c.hashtags, c.media_token, c.hook_text,
            (SELECT COUNT(*) FROM narrations n WHERE n.clip_id = c.id AND n.mix_status = 'ready' AND n.ai_generated = 1) AS ai_voice, c.full_video, c.youtube
     FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.status = 'planned' AND ${POSTABLE_CLIP_SQL}`,
  ).all<{ id: string; platform: Platform; scheduled_at: string; retries: number; clip_id: string; caption: string; hashtags: string; media_token: string | null; hook_text: string; ai_voice: number; full_video: number; youtube: string | null }>();
  // A full video Buffer can't post (landscape or over 3 minutes: Buffer posts YouTube Shorts only)
  // never goes to Buffer: it is hers to upload (Home: Upload it yourself), and it stays on the
  // Calendar as the day to do it. Sending it anyway failed twice and emailed her (staging, 26 Sep).
  // With Connect YouTube (full videos) connected, or connected and needing a reconnect, every full
  // video goes to her channel directly (worker/lib/youtubeDirect.ts) or waits for Upload it
  // yourself: never Buffer, which can only make it a Short.
  const direct = (await directMode(env)) !== "off";
  const toBuffer = plannedRows.filter((r) => !(r.full_video && (direct || parseJson<{ handoff?: boolean }>(r.youtube, {}).handoff)));
  const loadPlan = choosePostsToLoad(toBuffer, used, ready, now);
  const byId = new Map(toBuffer.map((r) => [r.id, r]));
  let loaded = 0;
  let createFailed = 0;
  for (const cand of loadPlan.load) {
    const row = byId.get(cand.id)!;
    let token = row.media_token;
    if (!token) {
      token = mediaToken();
      await env.DB.prepare("UPDATE clips SET media_token = ? WHERE id = ? AND media_token IS NULL").bind(token, row.clip_id).run();
      token = (await env.DB.prepare("SELECT media_token FROM clips WHERE id = ?").bind(row.clip_id).first<{ media_token: string }>())?.media_token ?? token;
    }
    const text = [row.caption, row.hashtags].filter((x) => x && x.trim()).join("\n\n");
    const r = await client.createPost({ channelId: buf.channels[row.platform]!.id, platform: row.platform, title: row.hook_text, text, mediaUrl: `${env.PUBLIC_BASE_URL}/media/${token}`, scheduledAt: bufferDueAt(row.scheduled_at, now), aiGenerated: row.ai_voice > 0, ...fullVideoArgs(row) });
    if (r.ok && r.id) {
      await env.DB.prepare("UPDATE posts SET status = 'in_buffer', buffer_post_id = ?, error = NULL WHERE id = ?").bind(r.id, row.id).run();
      loaded++;
      continue;
    }
    createFailed++;
    const d = createFailureDecision(row.retries, await alreadyEmailed(env, "posting_problem", row.id));
    await env.DB.prepare("UPDATE posts SET status = ?, retries = ?, error = ? WHERE id = ?").bind(d.status, d.retries, r.error, row.id).run();
    if (d.email) await postingProblemEmail(env, { id: row.id, platform: row.platform, scheduled_at: row.scheduled_at, hook_text: row.hook_text, error: r.error });
    if (row.full_video && d.status === "failed") await fullVideoHandoff(env, row.clip_id);
  }

  // 4. read back posts whose time has come
  const { results: waiting } = await env.DB.prepare(
    `SELECT p.id, p.platform, p.scheduled_at, p.retries, p.buffer_post_id, c.id AS clip_id, c.caption, c.hashtags, c.media_token, c.hook_text,
            (SELECT COUNT(*) FROM narrations n WHERE n.clip_id = c.id AND n.mix_status = 'ready' AND n.ai_generated = 1) AS ai_voice, c.full_video, c.youtube
     FROM posts p JOIN clips c ON c.id = p.clip_id WHERE p.status = 'in_buffer'`,
  ).all<{ id: string; platform: Platform; scheduled_at: string; retries: number; buffer_post_id: string | null; clip_id: string; caption: string; hashtags: string; media_token: string | null; hook_text: string; ai_voice: number; full_video: number; youtube: string | null }>();
  let posted = 0;
  let retried = 0;
  let failed = 0;
  if (buf.ok) {
    for (const p of dueForReadBack(waiting, now)) {
      if (!p.buffer_post_id) {
        await env.DB.prepare("UPDATE posts SET status = 'planned' WHERE id = ?").bind(p.id).run();
        continue;
      }
      const st = await client.getPost(p.buffer_post_id);
      const d = readBackDecision(st.status, st.url, p.retries, await alreadyEmailed(env, "posting_problem", p.id));
      if (d.next === "in_buffer") continue;
      if (d.next === "posted") {
        await env.DB.prepare("UPDATE posts SET status = 'posted', url = ?, posted_at = ?, error = NULL WHERE id = ?").bind(d.url, nowIso(), p.id).run();
        posted++;
        continue;
      }
      await client.deletePost(p.buffer_post_id); // clear the errored copy out of her Buffer
      if (d.next === "retry") {
        retried++;
        const ch = buf.channels[p.platform];
        const again = ready[p.platform] && ch && p.media_token ? await client.createPost({ channelId: ch.id, platform: p.platform, title: p.hook_text, text: [p.caption, p.hashtags].filter((x) => x && x.trim()).join("\n\n"), mediaUrl: `${env.PUBLIC_BASE_URL}/media/${p.media_token}`, scheduledAt: bufferDueAt(p.scheduled_at, now), aiGenerated: p.ai_voice > 0, ...fullVideoArgs(p) }) : null;
        if (again?.ok && again.id) await env.DB.prepare("UPDATE posts SET buffer_post_id = ?, retries = ?, error = ? WHERE id = ?").bind(again.id, d.retries, st.error, p.id).run();
        else await env.DB.prepare("UPDATE posts SET status = 'planned', buffer_post_id = NULL, retries = ?, error = ? WHERE id = ?").bind(d.retries, again?.error ?? st.error, p.id).run();
        continue;
      }
      failed++;
      await env.DB.prepare("UPDATE posts SET status = 'failed', buffer_post_id = NULL, error = ? WHERE id = ?").bind(st.error ?? "The post did not go out.", p.id).run();
      await recordEvent(env.DB, "post.failed", p.id, { platform: p.platform });
      if (p.full_video) await fullVideoHandoff(env, p.clip_id);
      if (d.email) await postingProblemEmail(env, { id: p.id, platform: p.platform, scheduled_at: p.scheduled_at, hook_text: p.hook_text, error: st.error });
    }
  }

  // 5 + 6. health rows and "Connection needs you"
  const waitingSafely = loadPlan.waitingDisconnected;
  await writeHealth(env, buf, waitingSafely);

  log.info("buffer-sync.done", {
    planned: plan.added,
    pulled_unapproved: unapproved.length,
    loaded,
    create_failed: createFailed,
    waiting_no_room: loadPlan.waitingNoRoom,
    waiting_disconnected: waitingSafely,
    posted,
    retried,
    failed,
    buffer_checked: buf.checkedNow,
    buffer_requests: bufferRequests.n - sentBefore,
  });
}

/** Health rows + flip emails. Shared by the hourly run, the daily lane and "Check everything now". */
async function writeHealth(env: Env, buf: BufferState, waitingSafely: number): Promise<void> {
  const states: Record<string, ConnState> = {};

  // Buffer
  if (!buf.connected) {
    await setHealth(env.DB, "Buffer", "yellow", waitingSafely ? `Not connected yet · ${waitingSafely} posts waiting safely` : "Not connected yet", "connect-buffer");
    states.Buffer = "off";
  } else if (!buf.ok) {
    await setHealth(env.DB, "Buffer", "red", `${buf.error ?? "Buffer stopped answering"} · posts wait safely`, "reconnect-buffer");
    states.Buffer = "bad";
  } else {
    const { results } = await env.DB.prepare("SELECT platform, COUNT(*) AS n FROM posts WHERE status = 'in_buffer' GROUP BY platform").all<{ platform: Platform; n: number }>();
    const used = queueUsed(Object.fromEntries(results.map((r) => [r.platform, r.n])), buf.remoteQueue);
    const most = Math.max(0, ...PLATFORMS.filter((p) => buf.channels[p]).map((p) => used[p]));
    await setHealth(env.DB, "Buffer", "green", `OK · ${most} of ${BUFFER_QUEUE_LIMIT_PER_CHANNEL} queue slots used`, null);
    states.Buffer = "ok";
  }

  // each channel (only meaningful while Buffer itself works)
  for (const p of PLATFORMS) {
    const name = CHANNEL_HEALTH_NAME[p];
    if (!buf.ok) {
      await setHealth(env.DB, name, "grey", buf.connected ? "Waiting for Buffer to work again" : "Connect Buffer first", buf.connected ? "reconnect-buffer" : "connect-buffer");
      states[name] = "off";
      continue;
    }
    const failedN = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed' AND platform = ?").bind(p).first<{ n: number }>())?.n ?? 0;
    const last = (await env.DB.prepare("SELECT MAX(posted_at) AS t FROM posts WHERE status = 'posted' AND platform = ?").bind(p).first<{ t: string | null }>())?.t ?? null;
    const ch = buf.channels[p];
    const h = channelHealth(PLATFORM_LABEL[p], ch ? { connected: ch.connected, paused: ch.paused, handle: ch.handle } : null, failedN, last);
    await setHealth(env.DB, name, h.light, h.note, h.fix);
    states[name] = h.state;
  }

  await serviceHealthRows(env);

  // stats + key connections from the connections table (written by Connect and the stats phase)
  const { results: conns } = await env.DB.prepare("SELECT service, status FROM connections WHERE service NOT IN ('buffer','resend','github')").all<{ service: Service; status: string }>();
  for (const c of conns) states[c.service] = c.status === "ok" ? "ok" : c.status === "error" ? "bad" : "off";

  const prev = await getSetting<Record<string, ConnState>>(env.DB, STATES_KEY, {});
  const flips = connectionFlips(prev, states);
  for (const name of flips) await connectionNeedsYouEmail(env, name);
  await setSetting(env.DB, STATES_KEY, states);
  if (flips.length) log.info("health.flips", { count: flips.length });
}

/** The one cutting light. Written here (hourly, daily, "Check everything now") and by the cut job
 * the moment a cut finishes or fails, from the same query, so the two can never disagree. Until
 * 25 Sep 2026 the cut job wrote its own "Cutting" row beside this one: two lights for one thing
 * (found in the Phase 0 live test). */
export const CLIP_CUTTING = "Clip cutting";

export async function clipCuttingLight(env: Env, justFinished?: { status: "done" | "failed"; at: string }): Promise<void> {
  await env.DB.prepare("DELETE FROM health WHERE name = 'Cutting'").run(); // the retired duplicate
  const row = await env.DB.prepare("SELECT status, finished_at, created_at FROM jobs WHERE type = 'cut' AND status IN ('done','failed') ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 1").first<{ status: string; finished_at: string | null; created_at: string }>();
  // The job route marks the job done only after the cut is applied, so the cut job passes its own outcome.
  const last = justFinished ? { status: justFinished.status, finished_at: justFinished.at, created_at: justFinished.at } : row;
  const running = (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'cut' AND status IN ('queued','dispatched','running')").first<{ n: number }>())?.n ?? 0;
  const others = Math.max(0, running - (justFinished ? 1 : 0));
  const when = (last?.finished_at ?? last?.created_at ?? "").slice(0, 10);
  const busy = others ? ` · ${others} cutting now` : "";
  if (!last) await setHealth(env.DB, CLIP_CUTTING, "grey", others ? `First cut running${busy}` : "No clips cut yet", null);
  else if (last.status === "done") await setHealth(env.DB, CLIP_CUTTING, "green", `Last job OK · ${when}${busy}`, null);
  else await setHealth(env.DB, CLIP_CUTTING, "red", `Last cut failed · ${when}${busy}`, "clips-look-wrong");
}

/** Clip cutting, Email (Resend) and Job runner (GitHub) lights. Also written by the daily lane. */
export async function serviceHealthRows(env: Env): Promise<void> {
  const fake = fakeServices(env);
  // The last real send decides: a refused one keeps the red light sendEmail wrote (with Resend's
  // reason) instead of this check painting it green because a key exists.
  const lastMail = fake ? null : await env.DB.prepare("SELECT provider_id FROM emails_sent ORDER BY sent_at DESC LIMIT 1").first<{ provider_id: string | null }>();
  if (!fake && !env.RESEND_API_KEY) await setHealth(env.DB, "Email (Resend)", "grey", "Practice mode · emails are listed here, not sent. Set up Email on Setup.", "setup-email");
  else if (lastMail && !lastMail.provider_id) {
    const row = await env.DB.prepare("SELECT light FROM health WHERE name = 'Email (Resend)'").first<{ light: string }>();
    if (row?.light !== "red") await setHealth(env.DB, "Email (Resend)", "red", "The last email was not delivered", "connect-resend");
  } else await setHealth(env.DB, "Email (Resend)", "green", fake ? "Test mode · emails are recorded, not sent" : "Ready to send", null);

  if (!fake && (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPO)) await setHealth(env.DB, "Job runner (GitHub)", "grey", "Practice mode · the practice cutter makes sample clips. Set up Clip cutting on Setup.", "setup-job-runner");
  else await setHealth(env.DB, "Job runner (GitHub)", "green", fake ? "Test mode · jobs are simulated" : "Ready", null);

  await clipCuttingLight(env);
}

/**
 * "Check everything now" (Settings): re-check Buffer and every pasted key right away, then
 * rewrite the health rows. Posting is not touched.
 */
export async function recheckEverything(env: Env): Promise<void> {
  const client = await getBuffer(env);
  const buf = await bufferState(env, client, true);
  const checks: [Service, (env: Env, key: string) => Promise<KeyCheck>][] = [
    ["openrouter", checkOpenRouter],
    ["firecrawl", checkFirecrawl],
    ["hunter", checkHunter],
  ];
  for (const [service, check] of checks) {
    const key = await getConnectionSecret(env, service);
    if (!key) continue;
    const r = await check(env, key);
    await markConnection(env, service, r.ok ? "ok" : "error", r.error, r.meta);
    await setHealth(env.DB, service, r.ok ? "green" : "red", r.ok ? "Connected" : (r.error ?? "Needs you"), r.ok ? null : `reconnect-${service}`);
  }
  for (const editor of API_EDITORS) {
    const key = await getConnectionSecret(env, editor);
    if (!key) continue;
    const r = await checkEditor(editor)(env, key);
    await markConnection(env, editor, r.ok ? "ok" : "error", r.error, r.meta);
    await writeEditorCheckLight(env, editor, r.ok, r.error, r.meta);
  }
  await recheckElevenLabs(env); // the same code as the daily lane: one "Voice · ElevenLabs" light
  // Connect YouTube (full videos): a refresh proves Google still accepts her sign-in (red if not),
  // then the same sync the hourly lane runs (uploads due, Calendar moves, read-backs), at once.
  if ((await directMode(env)) === "on" && (await youtubeAccessToken(env))) await youtubeDirectSync(env);
  await writeYouTubeLight(env);
  const waiting = (await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'planned' AND scheduled_at < ?").bind(new Date(Date.now() + 7 * 86400_000).toISOString()).first<{ n: number }>())?.n ?? 0;
  await writeHealth(env, buf, buf.ok ? 0 : waiting);
  log.info("health.recheck", { buffer_ok: buf.ok });
}
