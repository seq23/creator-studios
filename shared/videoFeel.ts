// "How my videos feel" (Brand Profile section video_feel, written from her past videos by
// worker/jobs/pastvideos.ts): every AI step that writes for her clips reads it from the profile in
// use. One sentence for the Worker's prompts; jobs/plan.py and jobs/cut.py pass the same section.
// Guard: tests/unit/past-videos.test.ts.
export const VIDEO_FEEL_PROMPT_MAX = 900;

export function feelLine(profile: { video_feel?: string | null } | null | undefined): string {
  const feel = String(profile?.video_feel ?? "").trim().slice(0, VIDEO_FEEL_PROMPT_MAX);
  return feel ? ` Match how her finished videos feel (hooks, pace, caption style, energy, how she talks): ${feel.replace(/\n+/g, "; ")}.` : "";
}
