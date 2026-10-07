// One handler per job type. A handler builds the spec a GitHub Actions job fetches, applies
// the result it posts back, and (for local development) can produce a realistic fake result.
//
// COLLISION SLOT: each phase owns its own file below and registers it here. Add a line, do
// not restructure. The validator scripts/validators/jobs-registered.mjs checks that every
// job type in migrations/0001_init.sql has a handler.
import type { Env } from "../env";
import type { JobType } from "../services/github";
import { cutJob } from "./cut";
import { extractJob } from "./extract";
import { researchJob } from "./research";
import { brandFinderJob } from "./brand_finder";
import { voiceJob } from "./voice";
import { helpScreenshotsJob } from "./help_screenshots";
import { metricsJob } from "./metrics";
import { fullVideoJob } from "./fullvideo";
import { ytUploadJob } from "./ytupload";

export interface JobHandler {
  buildSpec(env: Env, jobId: string, refId: string | null): Promise<unknown>;
  applyResult(env: Env, jobId: string, refId: string | null, result: unknown): Promise<void>;
  onFailure(env: Env, jobId: string, refId: string | null, safeError: string): Promise<void>;
  onProgress?(env: Env, jobId: string, refId: string | null, progress: { step: string; done: number; total: number }): Promise<void>;
  fakeRun?(env: Env, jobId: string, refId: string | null, options: Record<string, unknown>): Promise<unknown>;
}

export const JOB_HANDLERS: Record<JobType, JobHandler> = {
  cut: cutJob,
  extract: extractJob,
  research: researchJob,
  brand_finder: brandFinderJob,
  voice: voiceJob,
  help_screenshots: helpScreenshotsJob,
  metrics: metricsJob,
  fullvideo: fullVideoJob,
  ytupload: ytUploadJob,
};
