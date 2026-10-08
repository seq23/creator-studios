// Stand-in Research Brief for FAKE_SERVICES=1 (and the unit test that pins its shape).
// Niche-neutral: its themes, tags and hooks come from the studio's own locked Brand Profile themes
// when there are any, otherwise neutral placeholders (7 Oct 2026: it described one creator's brand to every studio). Built from her locked Brand Profile and the section 10b baseline. It cites
// only real sources: the six 10b studies, her own profile, her stats if connected, and her
// uploads. No web search happens in fake mode, so nothing here pretends to come from one;
// claims without evidence are marked uncertain, exactly as a real brief must.
import { LAUNCH_SLOTS, PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import type { BriefBody, BriefSource, Claim } from "@shared/types";
import { BASELINE_SOURCES } from "../domain/brief";

export interface FakeBriefInput {
  stats: Partial<Record<Platform, { videos: number }>>;
  uploads: { id: string; title: string }[];
  /** Her locked Brand Profile themes (themeList), when she has one. */
  themes?: string[];
}

const PLACEHOLDER_THEMES = ["How-tos", "Behind the scenes", "Tips and quick wins", "Stories from the week"];
/** "Tutorials: one clear result" -> "Tutorials". */
const themeTitle = (t: string) => t.split(/[:—–]/)[0].trim();
const tagOf = (t: string) => "#" + themeTitle(t).toLowerCase().replace(/[^a-z0-9]+/g, "");

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;

export function buildFakeBrief(input: FakeBriefInput): { body: BriefBody; sources: BriefSource[] } {
  const sources: BriefSource[] = [...BASELINE_SOURCES, { id: "her_profile", url: null, title: "Your locked Brand Profile", kind: "her_data" }];
  for (const p of PLATFORMS) {
    const s = input.stats[p];
    if (s && s.videos > 0) sources.push({ id: `her_${p}`, url: null, title: `Your ${PLATFORM_LABEL[p]} results (${s.videos} videos)`, kind: "her_data" });
  }
  for (const u of input.uploads) sources.push({ id: `up_${u.id}`, url: null, title: u.title, kind: "upload" });

  const solid = (text: string, source_ids: string[], basis: Claim["basis"]): Claim => ({ text, source_ids, basis, confidence: "solid" });
  const unsure = (text: string, source_ids: string[], basis: Claim["basis"]): Claim => ({ text, source_ids, basis, confidence: "uncertain" });
  const statIds = PLATFORMS.filter((p) => sources.some((s) => s.id === `her_${p}`)).map((p) => `her_${p}`);

  const own = (input.themes ?? []).map(themeTitle).filter((t) => t.length > 1);
  const names = (own.length ? own : PLACEHOLDER_THEMES).slice(0, 4);
  const lead = names[0].toLowerCase();

  const audience: Claim[] = [
    solid("Her core audience is the people her Brand Profile describes; every hook and theme below is written for them.", ["her_profile"], "her_data"),
    solid("They come for clear, useful videos in her own voice, and come back for the next one.", ["her_profile"], "her_data"),
    statIds.length
      ? solid("Her own results show which platform her audience watches most; the Stats page has the numbers.", statIds, "her_data")
      : unsure("Where her followers live and their age split is not known yet. Connect Instagram and YouTube stats, or upload the TikTok export, and the next refresh fills this in.", [], "her_data"),
  ];
  for (const u of input.uploads) audience.push(solid("Her uploaded report is included as a source; its claims are weighed like any other.", [`up_${u.id}`], "upload"));

  const themes = names.map((title, i) => ({
    title,
    claims: [
      solid(`${title} is one of her own themes; one clear moment from it fits a 15–45 second vertical video.`, ["her_profile"], "her_data"),
      ...(i === 0 ? [unsure(`Talking-head clips may hold attention longer than montages for ${lead}; her results will confirm it.`, [], "her_data")] : []),
    ],
  }));

  const hooks: Claim[] = [
    solid("Open on the payoff: the best moment first, then how she got there, in her voice.", ["her_profile"], "her_data"),
    solid(`"The one thing that changed ${lead} for me" over the first shot.`, ["her_profile"], "her_data"),
    solid(`"Save this before you try it" to open tip clips.`, ["her_profile"], "her_data"),
    unsure(`A question hook ("What's your take on ${lead}?") may lift comments; not tested on her account yet.`, [], "her_data"),
  ];

  const cut_styles: Claim[] = [
    solid("Hook-first cuts: move the best line or the payoff to second 0.", ["her_profile"], "her_data"),
    solid("Tight talking-head, 20–45 seconds, for tips.", ["her_profile"], "her_data"),
    unsure("Montage clips of 15–30 seconds; the best length for her audience is not known yet and will come from her results.", [], "her_data"),
  ];

  const timeClaim = (p: Platform, day: number, hour: number): Claim => {
    const at = `${DAY[day]} ${hourLabel(hour)}`;
    if (p === "tiktok") {
      if (day === 0 || day === 6) return unsure(`${at}: the big studies disagree on weekends (one says avoid, one ranks Saturday best), so this slot is a test.`, ["b_sprout_tt", "b_buffer_all"], "web");
      return solid(`${at}: weekday late afternoon and evening is where both big TikTok studies overlap.`, ["b_sprout_tt", "b_buffer_all"], "web");
    }
    if (p === "instagram") return solid(`${at}: Instagram evenings and Tuesday–Wednesday are strongest across 9.6M posts; Thursday mornings also do well.`, ["b_buffer_ig", "b_sprout_ig"], "web");
    return solid(`${at}: YouTube Shorts did best Friday around 4 pm, with Saturday close behind.`, ["b_buffer_all"], "web");
  };
  const best_times = {} as BriefBody["best_times"];
  for (const p of PLATFORMS) best_times[p] = LAUNCH_SLOTS[p].map((s) => ({ ...s, claim: timeClaim(p, s.day, s.hour) }));

  const tagPlatforms: Platform[] = ["instagram", "tiktok", "youtube"];
  const comparable_creators = names.slice(0, 3).map((t, i) => ({
    handle: tagOf(t),
    platform: tagPlatforms[i],
    why: unsure(`Creators under this tag speak to the same audience as her "${t}" theme; worth watching for hook ideas. No web search ran, so no individual creators are named.`, [], "web"),
  }));

  const shot_list: Claim[] = [
    solid(`The finished result first, close up, for a ${lead} video.`, ["her_profile"], "her_data"),
    solid("A 30-second talk to camera: one tip, one takeaway.", ["her_profile"], "her_data"),
    solid("The setup before she starts, as a quick time-lapse.", ["her_profile"], "her_data"),
    solid("Her hands doing the key step, in one steady take.", ["her_profile"], "her_data"),
    solid("A reaction or a before-and-after at the end (ask anyone on camera first).", ["her_profile"], "her_data"),
  ];

  return { body: { audience, themes, hooks, cut_styles, best_times, comparable_creators, shot_list }, sources };
}
