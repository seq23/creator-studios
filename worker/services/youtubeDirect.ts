// Her own YouTube channel, through her "Connect YouTube" sign-in (worker/lib/youtubeDirect.ts decides
// when; the big upload itself runs in the ytupload job, never here). The Worker's calls are small:
//   refresh          Google's token endpoint: a fresh access token from the stored refresh token
//   listVideos       videos.list part=status (1 unit): the read-back after upload and after publish
//   updateStatus     videos.update part=status (50 units): a moved slot (publishAt) or taken off
//                    (private). No delete call exists here: her videos are never deleted.
// FAKE_SERVICES=1: a stand-in YouTube kept in the settings row `fake_youtube` that answers with the
// real error bodies (shared/youtube-errors.json) for the scenario set there:
//   quota · revoked · interrupted · publish_at_rejected · thumb_unverified · kept_private
import type { Env } from "../env";
import { practice } from "../lib/practice";
import { getSetting, setSetting } from "../lib/db";
import { classifyError, type ErrorKind, type ReadBack } from "../domain/youtubeDirect";
import errors from "@shared/youtube-errors.json";

export type YtFail = { ok: false; http: number; reason: string | null; kind: ErrorKind };
export type YtResult<T> = ({ ok: true } & T) | YtFail;

export interface YouTubeDirect {
  refresh(refreshToken: string): Promise<YtResult<{ access_token: string; expires_in: number }>>;
  listVideos(accessToken: string, ids: string[]): Promise<YtResult<{ items: Record<string, ReadBack> }>>;
  updateStatus(accessToken: string, videoId: string, status: Record<string, unknown>): Promise<YtResult<{ status: ReadBack }>>;
}

export const FAKE_SCENARIOS = ["ok", "quota", "revoked", "interrupted", "publish_at_rejected", "thumb_unverified", "kept_private"] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];
export interface FakeYouTubeState {
  scenario: FakeScenario;
  videos: Record<string, { privacyStatus: string; publishAt: string | null; uploadStatus: string; thumbnail: boolean }>;
  /** every call the fake answered, for the tests (never any content) */
  calls: string[];
}
export const FAKE_KEY = "fake_youtube";

/** The first reason in a Google error body: `error.errors[0].reason`, or OAuth's `error` string. */
export function reasonOf(body: unknown): string | null {
  const b = body as { error?: unknown } | null;
  if (!b || b.error === undefined) return null;
  if (typeof b.error === "string") return b.error;
  const e = b.error as { errors?: { reason?: string }[]; status?: string };
  return e.errors?.[0]?.reason ?? e.status ?? null;
}

async function failFrom(res: Response, opts: { thumbnail?: boolean } = {}): Promise<YtFail> {
  const body = await res.json().catch(() => null);
  const reason = reasonOf(body);
  return { ok: false, http: res.status, reason, kind: classifyError(res.status, reason, opts) };
}

const net = (): YtFail => ({ ok: false, http: 0, reason: "network", kind: "retry" });

function toReadBack(item: { status?: Record<string, unknown> } | undefined): ReadBack {
  const s = item?.status ?? {};
  return {
    privacyStatus: typeof s.privacyStatus === "string" ? s.privacyStatus : null,
    publishAt: typeof s.publishAt === "string" ? s.publishAt : null,
    uploadStatus: typeof s.uploadStatus === "string" ? s.uploadStatus : null,
    failureReason: typeof s.failureReason === "string" ? s.failureReason : null,
    rejectionReason: typeof s.rejectionReason === "string" ? s.rejectionReason : null,
  };
}

function realClient(env: Env): YouTubeDirect {
  const api = "https://www.googleapis.com/youtube/v3";
  return {
    async refresh(refreshToken) {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return { ok: false, http: 0, reason: "not_set_up", kind: "other" };
      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }),
        });
        if (!res.ok) return failFrom(res);
        const t = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!t.access_token) return { ok: false, http: res.status, reason: "no_token", kind: "other" };
        return { ok: true, access_token: t.access_token, expires_in: t.expires_in ?? 3600 };
      } catch {
        return net();
      }
    },
    async listVideos(token, ids) {
      try {
        const u = new URL(`${api}/videos`);
        u.searchParams.set("part", "status");
        u.searchParams.set("id", ids.join(","));
        const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return failFrom(res);
        const data = (await res.json()) as { items?: { id: string; status?: Record<string, unknown> }[] };
        return { ok: true, items: Object.fromEntries((data.items ?? []).map((i) => [i.id, toReadBack(i)])) };
      } catch {
        return net();
      }
    },
    async updateStatus(token, videoId, status) {
      try {
        const res = await fetch(`${api}/videos?part=status`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ id: videoId, status }),
        });
        if (!res.ok) return failFrom(res);
        return { ok: true, status: toReadBack((await res.json()) as { status?: Record<string, unknown> }) };
      } catch {
        return net();
      }
    },
  };
}

// ---------------------------------------------------------------- fake

type Fixture = { http: number; body: unknown; thumbnail?: boolean };
const FIX = errors as unknown as Record<string, Fixture>;

/** A fixture's answer, classified exactly as the real one would be. */
export function fixtureFail(name: keyof typeof errors): YtFail {
  const f = FIX[name];
  const reason = reasonOf(f.body);
  return { ok: false, http: f.http, reason, kind: classifyError(f.http, reason, { thumbnail: !!f.thumbnail }) };
}

export async function readFake(env: Env): Promise<FakeYouTubeState> {
  const s = await getSetting<Partial<FakeYouTubeState>>(env.DB, FAKE_KEY, {});
  return { scenario: FAKE_SCENARIOS.includes(s.scenario as FakeScenario) ? (s.scenario as FakeScenario) : "ok", videos: s.videos ?? {}, calls: s.calls ?? [] };
}
export async function writeFake(env: Env, s: FakeYouTubeState): Promise<void> {
  await setSetting(env.DB, FAKE_KEY, { ...s, calls: s.calls.slice(-100) });
}

function fakeClient(env: Env): YouTubeDirect {
  return {
    async refresh() {
      const s = await readFake(env);
      s.calls.push("refresh");
      await writeFake(env, s);
      if (s.scenario === "revoked") return fixtureFail("token_revoked");
      return { ok: true, access_token: "fake-youtube-access", expires_in: 3600 };
    },
    async listVideos(_t, ids) {
      const s = await readFake(env);
      s.calls.push("videos.list");
      // A scheduled video whose time has come goes public, as YouTube does.
      for (const v of Object.values(s.videos)) if (v.publishAt && Date.parse(v.publishAt) <= Date.now() && v.privacyStatus === "private") Object.assign(v, { privacyStatus: "public", publishAt: null });
      await writeFake(env, s);
      if (s.scenario === "quota") return fixtureFail("quota_exceeded");
      return { ok: true, items: Object.fromEntries(ids.filter((id) => s.videos[id]).map((id) => [id, { privacyStatus: s.videos[id].privacyStatus, publishAt: s.videos[id].publishAt, uploadStatus: s.videos[id].uploadStatus }])) };
    },
    async updateStatus(_t, id, status) {
      const s = await readFake(env);
      s.calls.push("videos.update");
      if (s.scenario === "revoked") {
        await writeFake(env, s);
        return fixtureFail("access_token_invalid");
      }
      if (s.scenario === "publish_at_rejected" && status.publishAt) {
        await writeFake(env, s);
        return fixtureFail("publish_at_rejected");
      }
      const v = s.videos[id];
      if (!v) {
        await writeFake(env, s);
        return { ok: false, http: 404, reason: "videoNotFound", kind: "other" };
      }
      v.privacyStatus = String(status.privacyStatus);
      v.publishAt = typeof status.publishAt === "string" ? status.publishAt : null;
      await writeFake(env, s);
      return { ok: true, status: { privacyStatus: v.privacyStatus, publishAt: v.publishAt, uploadStatus: v.uploadStatus } };
    },
  };
}

export function getYouTubeDirect(env: Env): YouTubeDirect {
  return practice(env, "google_app") ? fakeClient(env) : realClient(env);
}
