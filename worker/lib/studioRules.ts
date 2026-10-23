// The studio's clip rules as the Worker reads them: registry defaults (var STUDIO_RULES), then what
// she saved in Settings → Your clips (settings key "studio_rules"). shared/studioRules.ts holds the
// shape and the cleaning; this file only reads.
import type { Env } from "../env";
import { getSetting } from "./db";
import { studioRules, type StudioRules } from "@shared/studioRules";

export async function readStudioRules(env: Pick<Env, "DB" | "STUDIO_RULES">): Promise<StudioRules> {
  return studioRules(env.STUDIO_RULES, await getSetting<unknown>(env.DB, "studio_rules", null));
}
