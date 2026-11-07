// A ready niche brief for tests whose studio is past its first upload (worker/lib/nicheBrief.ts):
// without one, a new studio's first dump waits for its niche research, by design.
export const READY_BRIEF = JSON.stringify({
  buyer: "Someone planning an event for someone else.",
  competitors: [1, 2, 3, 4, 5].map((i) => ({ name: `Account ${i}`, handle: `@account_${i}`, platform: "tiktok" })),
  hooks: ["POV: they think you did all this", "Wait for it…", "Hosting and already tired?"],
  caption_patterns: ["Who it is for and the ease"],
  cta_patterns: ["One ask, one link"],
  avoid: ["Describing what is on screen"],
  channels: {},
});

export const readyBriefSql = `INSERT INTO niche_briefs (id, status, brief, sources, researched_on, origin, created_at, updated_at) VALUES ('nbr_ready', 'ready', '${READY_BRIEF.replace(/'/g, "''")}', '[]', '2026-11-07', 'research', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z');`;
