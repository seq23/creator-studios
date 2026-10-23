// The services a studio's footage can show (studio intelligence, owner's plan 22 Oct 2026). They
// come ONLY from the studio's locked Brand Profile, never from code: the shot sheet (jobs/see.py)
// labels each shot with one of them, the planner (jobs/plan.py) writes only about the one detected,
// and "Change" on the plain line offers them. One function for the Worker and the app; the job reads
// the list from its signed spec. Pinned by tests/unit/services-of.test.ts on four unlike businesses.

const MAX_SERVICES = 8;

function clean(label: string): string {
  return label
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[\s\d.)•*\-–]+/, "")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!]+$/, "");
}

function splitList(text: string): string[] {
  return text
    .split(/\n|;|,|•|\||\band\b|&/i)
    .map(clean)
    .filter((s) => s.length >= 3 && s.split(" ").length <= 5);
}

/**
 * The service labels, in the profile's own words: the labels of "What each service looks like"
 * (two or more "Service: …" lines, layer 1); else an explicit "services" section when the profile
 * has one; else the list after the first colon of "who" (e.g. "…: A, B, C and D."); else the content
 * themes (the part before a colon). At most 8, no repeats.
 */
export function servicesOf(profile: Record<string, string> | null | undefined): string[] {
  if (!profile) return [];
  const out: string[] = [];
  const add = (xs: string[]) => {
    for (const x of xs) if (out.length < MAX_SERVICES && !out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x);
  };
  // Layer 1: "What each service looks like" names the services itself, one "Service: …" line each.
  const looks = (profile.service_looks ?? "")
    .split(/\n/)
    .map((l) => l.replace(/^[\s\d.)•*\-–]+/, ""))
    .filter((l) => l.includes(":"))
    .map((l) => clean(l.slice(0, l.indexOf(":"))))
    .filter((s) => s.length >= 3 && s.split(" ").length <= 5 && !/^(all|any|everything)$/i.test(s));
  if (looks.length >= 2) add(looks);
  if (!out.length && profile.services?.trim()) add(splitList(profile.services));
  if (!out.length && profile.who) {
    const i = profile.who.indexOf(":");
    if (i >= 0) {
      const rest = profile.who.slice(i + 1);
      const sentence = rest.replace(/\([^)]*\)/g, " ").split(/\.(\s|$)/)[0] ?? "";
      add(splitList(sentence));
    }
  }
  if (!out.length && profile.themes) {
    add(
      profile.themes
        .split(/\n|\s\|\s/)
        .map((l) => clean(l.split(":")[0] ?? ""))
        .filter((s) => s.length >= 3 && s.split(" ").length <= 6),
    );
  }
  return out;
}
