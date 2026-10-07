// The ytupload job (jobs/ytupload.py): one approved full video, uploaded whole to her own YouTube
// channel with the resumable upload protocol (videos.insert), then her chosen thumbnail
// (thumbnails.set). Ref "<dumpId>/<clipId>". The job reads the video through the Worker (signed,
// jobStorage scope full/<dumpId>/) and gets a short-lived access token from
// POST /api/jobs/:id/youtube-token; it never sees the refresh token.
//
// buildSpec   → the file, the title / description with chapters / tags / category, the status part
//               (private + publishAt, or her privacy at once), the fallback status, the chunk size
// applyResult → worker/lib/youtubeDirect.ts applyUpload: read back with videos.list and compare
// onFailure   → one more try, then the hand-off (Upload it yourself) with a red light
// fakeRun     → FAKE_SERVICES=1: the stand-in YouTube (settings `fake_youtube`) takes the upload the
//               way the scenario there says, with YouTube's real answers
import type { JobHandler } from "./registry";
import { applyUpload, buildUploadSpec, uploadJobFailed, youtubeAccessToken } from "../lib/youtubeDirect";
import { readFake, writeFake } from "../services/youtubeDirect";
import { newId } from "../lib/ids";

export const ytUploadJob: JobHandler = {
  async buildSpec(env, jobId, refId) {
    return buildUploadSpec(env, jobId, refId);
  },
  async applyResult(env, jobId, refId, result) {
    await applyUpload(env, jobId, refId, result);
  },
  async onFailure(env, _jobId, refId) {
    await uploadJobFailed(env, refId);
  },
  async fakeRun(env, jobId, refId) {
    const spec = await buildUploadSpec(env, jobId, refId);
    // The job's first call: a token from the Worker (a revoked sign-in fails right here).
    const tok = await youtubeAccessToken(env);
    if (!tok) return { outcome: "revoked", http: 400, reason: "invalid_grant" };
    const s = await readFake(env);
    s.calls.push("videos.insert");
    if (s.scenario === "quota") {
      await writeFake(env, s);
      return { outcome: "quota", http: 403, reason: "quotaExceeded" };
    }
    const status = spec.metadata.status as { privacyStatus: string; publishAt?: string };
    const rejected = s.scenario === "publish_at_rejected" && !!status.publishAt;
    const id = newId("v", 11).slice(2); // 11 characters, the shape of a YouTube video id
    // YouTube keeps the upload private whatever was asked (the read-back must catch it).
    const locked = s.scenario === "kept_private";
    s.videos[id] = {
      privacyStatus: locked || rejected ? "private" : status.privacyStatus,
      publishAt: locked || rejected ? null : (status.publishAt ?? null),
      uploadStatus: "uploaded",
      thumbnail: s.scenario !== "thumb_unverified",
    };
    s.calls.push(spec.thumb_key ? "thumbnails.set" : "no-thumbnail");
    await writeFake(env, s);
    return {
      outcome: "uploaded",
      video_id: id,
      thumbnail: !spec.thumb_key ? "none" : s.scenario === "thumb_unverified" ? "needs_verify" : "set",
      publish_at_rejected: rejected,
      resumed: s.scenario === "interrupted" ? 1 : 0,
    };
  },
};
