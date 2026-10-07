// Phase 10–12c pure rules: pitch follow-up scheduling, TikTok One eligibility, off-limits and
// public-contact rules, pitch drafts, the Gmail link, the help-guide parser, and the fake
// brand finder's contract.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canMove, followupsDueLine, nextFollowup } from "@worker/domain/deals";
import { cleanBudget } from "@worker/domain/prospects";
import { afterFollowupSent, brandKey, clampFit, contactProblem, followupsDone, isRoleEmail, offLimitsTerms, sortContacts, validSentAt, violatesOffLimits } from "@worker/domain/brandfit";
import { MARKETPLACES, TIKTOK_ONE, listingSteps } from "@worker/domain/marketplaces";
import { compact } from "@worker/domain/emails";
import { fakeBrands, normaliseBrand } from "@worker/jobs/brand_finder";
import { toneWav } from "@worker/jobs/voice";
import { gmailComposeUrl, pitchAsText } from "../../app/lib/gmail";
import { parseGuide, parseInline, SCREEN_ROUTES } from "../../app/lib/markdown";

const SENT = "2026-09-01T12:00:00.000Z";

describe("weekly recap: follow-ups due", () => {
  it("lists every deal email due as brand (what, date), earliest first, in her timezone", () => {
    const line = followupsDueLine(
      [
        { brand: "Velvet & Vine Wraps", dueAt: "2026-10-02T03:30:00.000Z", what: "Send follow-up 2" }, // 1 Oct, 11:30 pm New York
        { brand: "Cedar & Salt Kitchen", dueAt: "2026-09-28T12:00:00.000Z", what: "Send the invoice" },
      ],
      "America/New_York",
    );
    expect(line).toBe("Deal emails due: Cedar & Salt Kitchen (Send the invoice, Mon, Sep 28), Velvet & Vine Wraps (Send follow-up 2, Thu, Oct 1).");
    expect(followupsDueLine([{ brand: "B", dueAt: "2026-09-28T12:00:00.000Z" }], "UTC")).toBe("Deal emails due: B (Mon, Sep 28).");
  });
  it("is no line at all when nothing is due", () => {
    expect(followupsDueLine([], "America/New_York")).toBeNull();
  });
});

describe("pitch follow-ups (day 5, day 12, day 19, then stop)", () => {
  it("a fresh send is waiting on the day-5 follow-up", () => {
    expect(followupsDone(SENT, nextFollowup(SENT, 0))).toBe(0);
  });
  it("each follow-up sent schedules the next, and the third is the last", () => {
    const d5 = nextFollowup(SENT, 0);
    const d12 = afterFollowupSent(SENT, d5);
    expect(d12).toBe("2026-09-13T12:00:00.000Z");
    expect(followupsDone(SENT, d12)).toBe(1);
    const d19 = afterFollowupSent(SENT, d12);
    expect(d19).toBe("2026-09-20T12:00:00.000Z");
    expect(followupsDone(SENT, d19)).toBe(2);
    expect(afterFollowupSent(SENT, d19)).toBeNull();
    expect(followupsDone(SENT, null)).toBe(3);
    expect(afterFollowupSent(SENT, null)).toBeNull();
  });
  it("a hand-moved date counts as the follow-up whose next day it is still before", () => {
    expect(followupsDone(SENT, "2026-09-08T09:00:00.000Z")).toBe(0);
    expect(followupsDone(SENT, "2026-09-15T09:00:00.000Z")).toBe(1);
    expect(followupsDone(SENT, "2026-09-25T09:00:00.000Z")).toBe(2);
  });
  it("sent-at must be today or up to 60 days ago, never the future", () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    expect(validSentAt(undefined, now)).toBe(now.toISOString());
    expect(validSentAt("2026-09-21T12:00:00.000Z", now)).toBe("2026-09-21T12:00:00.000Z");
    expect(validSentAt("2026-09-27T12:00:00.000Z", now)).toBeNull();
    expect(validSentAt("2026-07-01T12:00:00.000Z", now)).toBeNull();
    expect(validSentAt("not a date", now)).toBeNull();
  });
  it("sent then replied is a legal walk of the pipeline; skipping is not", () => {
    expect(canMove("pitch", "follow_up")).toBe(true);
    expect(canMove("follow_up", "negotiating")).toBe(true);
    expect(canMove("follow_up", "find_contact")).toBe(false);
    expect(canMove("follow_up", "agreed")).toBe(false);
  });
});

describe("marketplaces (Get listed here)", () => {
  it("TikTok One asks for what TikTok's own page says (1,000 followers), with its source", () => {
    expect(TIKTOK_ONE).toMatchObject({ key: "tiktok-one", minFollowers: 1000, platform: "tiktok" });
    expect(TIKTOK_ONE.sourceUrl).toBe("https://ads.tiktok.com/help/article/how-creators-can-sign-up-for-tiktok-one");
  });
  it("judges a follower bar only from the official number and her own count for that platform", () => {
    const steps = listingSteps({ tiktok: 999, instagram: 8200 }, []);
    const tt = steps.find((x) => x.key === "tiktok-one")!;
    expect(tt.status).toBe("not_yet");
    expect(tt.why).toBe("Needs 1,000+ followers; you have 999.");
    expect(steps.find((x) => x.key === "instagram-creator-marketplace")!.status).toBe("ready");
    // no official bar: never "not yet", never a guessed threshold
    expect(steps.find((x) => x.key === "ltk")!.status).toBe("ready");
    expect(listingSteps({}, []).find((x) => x.key === "tiktok-one")!.status).toBe("unknown");
  });
  it("joined ones sink to the bottom; every entry is live and links a source", () => {
    const steps = listingSteps({ tiktok: 5000 }, ["tiktok-one"]);
    expect(steps.at(-1)!.key).toBe("tiktok-one");
    expect(steps.at(-1)!.joined).toBe(true);
    for (const m of MARKETPLACES) {
      expect(m.live).toBe("yes");
      expect(m.sourceUrl).toMatch(/^https:\/\//);
    }
  });
  it("the list matches docs/BRAND-SOURCES.md: same keys, same live status", () => {
    const doc = readFileSync(path.resolve("docs/BRAND-SOURCES.md"), "utf8");
    const rows = [...doc.matchAll(/^\| ([a-z0-9-]+) \| [^|]+ \| (yes|no|unconfirmed) \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const listed = rows.filter(([, live]) => live === "yes").map(([k]) => k).sort();
    expect(MARKETPLACES.map((m) => m.key).sort()).toEqual(listed);
  });
});

describe("off-limits: never suggested", () => {
  const terms = offLimitsTerms("Alcohol, gambling and diet pills\n- No politics.");
  it("splits her section into terms", () => {
    expect(terms).toEqual(expect.arrayContaining(["alcohol", "gambling", "diet pills", "politics"]));
  });
  it("matches name, category or reason, plural-tolerant, whole words only", () => {
    expect(violatesOffLimits({ name: "Midnight Spirits", categories: ["alcohol"] }, terms)).toBe("alcohol");
    expect(violatesOffLimits({ name: "Lucky Casino", fit_reasons: ["Gambling brand with a creator program"] }, terms)).toBe("gambling");
    expect(violatesOffLimits({ name: "Slim Diet Pill Co" }, terms)).toBe("diet pills");
    expect(violatesOffLimits({ name: "Maison Candles", categories: ["home"] }, terms)).toBeNull();
    // "gambling" must not hit "gamblingly"-style substrings of unrelated words
    expect(violatesOffLimits({ name: "Politicsworld" }, ["politics"])).toBeNull();
  });
  it("an empty section blocks nothing", () => {
    expect(offLimitsTerms("")).toEqual([]);
    expect(violatesOffLimits({ name: "Anything" }, [])).toBeNull();
  });
  it("the fake finder's off-limits brand is caught by the demo profile's list", () => {
    const brands = fakeBrands("Table styling");
    expect(brands.length).toBeGreaterThanOrEqual(8);
    expect(brands.length).toBeLessThanOrEqual(12);
    const blocked = brands.filter((b) => violatesOffLimits(b, offLimitsTerms("Alcohol, gambling, diet pills")));
    expect(blocked.map((b) => b.name)).toEqual(["Midnight Spirits Co."]);
  });
});

describe("public business contacts only", () => {
  it("role addresses at a business domain pass; personal and free-mail addresses do not", () => {
    for (const ok of ["partnerships@brand.com", "pr@brand.co.uk", "us-partnerships@brand.com", "creators.team@brand.com", "hello@brand.example"]) expect(isRoleEmail(ok), ok).toBe(true);
    for (const bad of ["jane.doe@brand.com", "jdoe@brand.com", "partnerships@gmail.com", "pr@icloud.com", "not an email"]) expect(isRoleEmail(bad), bad).toBe(false);
  });
  it("every contact needs the public page it was found on", () => {
    expect(contactProblem({ kind: "role_email", value: "pr@brand.com", found_on_url: "" })).toMatch(/page it was found on/);
    expect(contactProblem({ kind: "role_email", value: "pr@brand.com", found_on_url: "javascript:alert(1)" })).toMatch(/page it was found on/);
    expect(contactProblem({ kind: "role_email", value: "pr@brand.com", found_on_url: "https://brand.com/press" })).toBeNull();
  });
  it("forms must be links; agencies may be a link or a role address", () => {
    expect(contactProblem({ kind: "form", value: "https://brand.com/apply", found_on_url: "https://brand.com/creators" })).toBeNull();
    expect(contactProblem({ kind: "form", value: "apply here", found_on_url: "https://brand.com/creators" })).toMatch(/web link/);
    expect(contactProblem({ kind: "agency", value: "talent@agency.example", found_on_url: "https://brand.com/press" })).toBeNull();
    expect(contactProblem({ kind: "agency", value: "sam@agency.example", found_on_url: "https://brand.com/press" })).toMatch(/never a personal one/);
  });
  it("priority: application form, then role email, then agency", () => {
    const sorted = sortContacts([{ kind: "agency" as const }, { kind: "role_email" as const }, { kind: "form" as const }]);
    expect(sorted.map((c) => c.kind)).toEqual(["form", "role_email", "agency"]);
  });
  it("every fake finder contact passes the same rules the Worker applies", () => {
    for (const b of fakeBrands("x")) for (const c of b.contacts) expect(contactProblem(c), `${b.name} ${c.value}`).toBeNull();
  });
});

describe("brand matching and the finder result shape", () => {
  it("dedupes by website host, else by name", () => {
    expect(brandKey({ name: "X", website: "https://www.brand.com/shop" })).toBe("brand.com");
    expect(brandKey({ name: "  Golden  Hour ", website: null })).toBe("golden hour");
  });
  it("fit accepts 0–1 or 0–100 and clamps", () => {
    expect(clampFit(87)).toBe(0.87);
    expect(clampFit(0.5)).toBe(0.5);
    expect(clampFit(250)).toBe(1);
    expect(clampFit("nope")).toBe(0);
  });
  it("normaliseBrand drops malformed input and unsafe links", () => {
    expect(normaliseBrand({})).toBeNull();
    const b = normaliseBrand({ name: "Brand", website: "javascript:alert(1)", socials: { tiktok: "https://tiktok.com/@b", "bad key": "https://x.y" }, source_links: ["https://a.b/c", "ftp://x"], fit_score: 91 })!;
    expect(b.website).toBeNull();
    expect(b.socials).toEqual({ tiktok: "https://tiktok.com/@b" });
    expect(b.source_links).toEqual(["https://a.b/c"]);
    expect(b.fit_score).toBe(0.91);
    expect(b.kind).toBe("brand");
    expect(b.budget).toEqual({ level: "unproven", evidence: [] });
  });
  it("a budget claim without a real source link is unproven; why lines need links", () => {
    expect(cleanBudget({ level: "paying", evidence: [{ text: "#ad post", url: "not a link" }] })).toEqual({ level: "unproven", evidence: [] });
    expect(cleanBudget({ level: "paying", evidence: [{ text: "#ad post", url: "https://www.tiktok.com/@x/video/1" }] }).level).toBe("paying");
    expect(cleanBudget({ level: "rich", evidence: [{ text: "x", url: "https://a.b/c" }] }).level).toBe("unproven");
    const b = normaliseBrand({ name: "B", why: [{ text: "Launching", url: "https://b.example/new" }, { text: "no link" }], kind: "agency" })!;
    expect(b.why).toEqual([{ text: "Launching", url: "https://b.example/new" }]);
    expect(b.kind).toBe("agency");
  });
  it("every fake finder brand except the unsourced one points at a page for each claim", () => {
    const brands = fakeBrands("x");
    for (const b of brands) {
      for (const e of [...b.budget.evidence, ...b.why]) expect(e.url, b.name).toMatch(/^https:\/\//);
      if (b.budget.level !== "unproven") expect(b.budget.evidence.length, b.name).toBeGreaterThan(0);
    }
    expect(brands.filter((b) => !b.source_links.length && !b.why.length && !b.budget.evidence.length).map((b) => b.name)).toEqual(["Nowhere Home Goods"]);
    expect(new Set(brands.map((b) => b.kind))).toEqual(new Set(["brand", "agency", "local"]));
  });
});

describe("numbers in emails", () => {
  it("read the way people say them", () => {
    expect(compact(950)).toBe("950");
    expect(compact(12400)).toBe("12.4K");
    expect(compact(250000)).toBe("250K");
    expect(compact(1_200_000)).toBe("1.2M");
  });
});

describe("Open in Gmail", () => {
  it("builds the pre-filled compose link with %20 spaces and every field encoded", () => {
    const url = gmailComposeUrl("pr@brand.com", "Hi & hello", "Line 1\nLine 2 #ad");
    expect(url.startsWith("https://mail.google.com/mail/?view=cm&to=pr%40brand.com&su=Hi%20%26%20hello&body=")).toBe(true);
    expect(url).not.toContain("+");
    const u = new URL(url);
    expect(u.searchParams.get("body")).toBe("Line 1\nLine 2 #ad");
  });
  it("Copy carries the subject and the body", () => {
    expect(pitchAsText("S", "B")).toBe("Subject: S\n\nB");
  });
});

describe("help guides", () => {
  const dir = path.resolve("help/guides");
  const mine = ["media-kit", "pitch-a-brand", "reply-to-a-brand-offer", "negotiate-a-rate", "invoice-a-brand", "record-your-voice", "connect-hunter"];
  it.each(mine)("%s has 3–8 real steps, one picture each, a target and today's check date", (slug) => {
    const g = parseGuide(readFileSync(path.join(dir, `${slug}.md`), "utf8"));
    expect(g.steps.length).toBeGreaterThanOrEqual(3);
    expect(g.steps.length).toBeLessThanOrEqual(8);
    g.steps.forEach((s, i) => {
      expect(s.image).toBe(`/help/screenshots/${slug}-${i + 1}.png`);
      expect(s.blocks.length).toBeGreaterThan(0);
      expect(s.route, `${slug} step ${i + 1}: an external step must be a mock`).not.toBe("external");
      expect(!!s.mock || !!s.target, `${slug} step ${i + 1} needs a target or a mock`).toBe(true);
    });
    expect(g.meta.last_checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(g.meta.screen && SCREEN_ROUTES[g.meta.screen]).toBeTruthy();
    if (g.meta.fix) expect(readFileSync(path.join(dir, `${g.meta.fix}.md`), "utf8").length).toBeGreaterThan(0);
  });
  it("the parser reads frontmatter, steps, directives and the closing section", () => {
    const g = parseGuide(
      '---\ntitle: "T"\ngroup: everyday\nscreen: deals\nlast_checked: 2026-09-25\ntarget: "role=button[name=\\"Go\\"]"\nfix: a-post-failed\n---\n\nIntro **bold**.\n\n## Step 1: Open it\n\n![Step 1](/help/screenshots/t-1.png)\n<!-- click: .card -->\n\nTap **Go**.\n\n## Two\n\n![Step 2](/help/screenshots/t-2.png)\n<!-- target: .x -->\n<!-- route: /deals?tab=kit -->\n\n- one\n- two\n\n## Did this work?\n\nIf not, tap No.\n',
    );
    expect(g.meta).toMatchObject({ title: "T", screen: "deals", target: 'role=button[name="Go"]', fix: "a-post-failed" });
    expect(g.steps.map((s) => s.title)).toEqual(["Open it", "Two"]);
    expect(g.steps[0]).toMatchObject({ clicks: [".card"], target: 'role=button[name="Go"]', route: null, mock: null, shared: false });
    expect(g.steps[1]).toMatchObject({ target: ".x", route: "/deals?tab=kit" });
    expect(g.steps[1].blocks[0]).toEqual({ kind: "ul", items: [[{ t: "text", v: "one" }], [{ t: "text", v: "two" }]] });
    expect(g.outro.length).toBe(1);
    expect(g.text).toContain("tap go");
  });
  it("never passes a script link through", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "x" }, { t: "text", v: ")" }]);
    expect(parseInline("[Hunter](https://hunter.io)")).toEqual([{ t: "link", v: "Hunter", href: "https://hunter.io" }]);
  });
});

describe("voice fake output", () => {
  it("is a real, playable WAV", () => {
    const w = toneWav(1);
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(w.slice(8, 12))).toBe("WAVE");
    expect(w.byteLength).toBe(44 + 16_000 * 2);
  });
});
