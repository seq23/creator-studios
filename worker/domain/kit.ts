// The media kit (section 12b.1, docs/reviews/2026-09-25-mediakit-deals.md): what she edits
// (KitContent, one editor screen, autosaved as a draft), what the public sees (publicKit: the
// newest published version, private rate fields stripped), and the Kit check (what is missing
// or stale, each with a one-tap fix). Pure; the routes read and write the database.
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "@shared/constants";
import { DEFAULT_ADDONS, DELIVERABLES, type AddOnTerms, type DeliverableKey, type RatePackage } from "./ratecard";

export const KIT_LIMITS = { showcaseMin: 3, showcaseMax: 6, packages: 8, collabs: 12, testimonials: 6, pillars: 6, series: 4, manual: 8 } as const;
/** Figures older than this are "stale" in the Kit check. */
export const STALE_DAYS = 30;

export interface Collab {
  id: string;
  brand: string;
  website: string | null;
  /** An uploaded logo (kit/photo/<uploadId>) or null: the public page then shows the brand's favicon from its website, or its initial. */
  logoKey: string | null;
  what: string;
  result: string;
  /** Came over from a deal she won (dealId), or typed by her (null). */
  dealId: string | null;
}
export interface Testimonial {
  quote: string;
  name: string;
  role: string;
}
export interface ManualFigure {
  id: string;
  platform: Platform | null;
  label: string;
  value: string;
  asOf: string; // YYYY-MM-DD she gives
}
export interface Pillar {
  title: string;
  text: string;
}

export interface KitContent {
  name: string;
  handles: Partial<Record<Platform, string>>;
  niche: string;
  location: string;
  positioning: string;
  bio: string;
  photoKey: string | null;
  pillars: Pillar[];
  series: Pillar[];
  showcase: string[];
  collabs: Collab[];
  packages: RatePackage[];
  addons: AddOnTerms;
  testimonials: Testimonial[];
  contactEmail: string | null;
  manual: ManualFigure[];
}

export function emptyKit(name: string): KitContent {
  return { name, handles: {}, niche: "", location: "", positioning: "", bio: "", photoKey: null, pillars: [], series: [], showcase: [], collabs: [], packages: [], addons: { ...DEFAULT_ADDONS }, testimonials: [], contactEmail: null, manual: [] };
}

/** Starter packages a rate card begins with (prices blank until she or the helper fills them). */
export function starterPackages(): RatePackage[] {
  const p = (id: string, name: string, items: RatePackage["items"], note: string): RatePackage => ({ id, name, items, startingAt: null, onRequest: false, floor: null, target: null, note, showOnKit: true });
  return [
    p("pkg_tiktok", "1 TikTok video", [{ key: "tiktok_video", qty: 1 }], "Concept, filming and editing; posted on my TikTok."),
    p("pkg_reel_story", "Instagram Reel + Story set", [{ key: "ig_reel", qty: 1 }, { key: "ig_story_set", qty: 1 }], "A Reel plus three Story frames with your link."),
    p("pkg_bundle", "3-video bundle", [{ key: "tiktok_video", qty: 2 }, { key: "ig_reel", qty: 1 }], "Three videos across TikTok and Instagram over a month."),
    p("pkg_ugc", "Video for your channels (no post)", [{ key: "ugc_video", qty: 1 }], "A finished video for you to post; no post from me."),
  ];
}

// ---------- validation (the PATCH body is merged over the draft, then checked whole)

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const HANDLE = /^@?[A-Za-z0-9._]{2,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIV_KEYS = Object.keys(DELIVERABLES) as DeliverableKey[];

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return NaN;
  return Math.round(n);
}

/** Coerce and check a whole kit. Returns the clean kit, or the first problem as a plain sentence. */
export function cleanKit(raw: unknown, fallbackName: string): { kit: KitContent } | { problem: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const k = emptyKit(str(r.name, 60) || fallbackName);
  const handles = (r.handles && typeof r.handles === "object" ? r.handles : {}) as Record<string, unknown>;
  for (const p of PLATFORMS) {
    const h = str(handles[p], 31);
    if (!h) continue;
    if (!HANDLE.test(h)) return { problem: `That ${PLATFORM_LABEL[p]} handle does not look right. Use letters, numbers, dots and underscores, like @samplecreator.` };
    k.handles[p] = h.startsWith("@") ? h : `@${h}`;
  }
  k.niche = str(r.niche, 90);
  k.location = str(r.location, 60);
  k.positioning = str(r.positioning, 160);
  k.bio = str(r.bio, 600);
  k.photoKey = typeof r.photoKey === "string" && /^kit\/photo\/upl_[a-z0-9]{6,40}$/.test(r.photoKey) ? r.photoKey : null;
  const pillarList = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : [])
      .map((x) => ({ title: str((x as Pillar)?.title, 50), text: str((x as Pillar)?.text, 200) }))
      .filter((x) => x.title)
      .slice(0, max);
  k.pillars = pillarList(r.pillars, KIT_LIMITS.pillars);
  k.series = pillarList(r.series, KIT_LIMITS.series);
  const showcase = [...new Set((Array.isArray(r.showcase) ? r.showcase : []).map(String))];
  if (showcase.length > KIT_LIMITS.showcaseMax) return { problem: `Pick up to ${KIT_LIMITS.showcaseMax} clips.` };
  k.showcase = showcase;
  const collabs = Array.isArray(r.collabs) ? r.collabs : [];
  if (collabs.length > KIT_LIMITS.collabs) return { problem: `List up to ${KIT_LIMITS.collabs} past collaborations.` };
  for (const c of collabs as Record<string, unknown>[]) {
    const brand = str(c?.brand, 60);
    if (!brand) continue;
    let website: string | null = str(c.website, 200) || null;
    if (website) {
      try {
        const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
        if (!u.hostname.includes(".")) throw new Error("host");
        website = u.origin;
      } catch {
        return { problem: `The website for ${brand} does not look right. Try something like brand.com.` };
      }
    }
    const logoKey = typeof c.logoKey === "string" && /^kit\/photo\/upl_[a-z0-9]{6,40}$/.test(c.logoKey) ? c.logoKey : null;
    k.collabs.push({ id: str(c.id, 40) || `col_${k.collabs.length + 1}`, brand, website, logoKey, what: str(c.what, 140), result: str(c.result, 140), dealId: typeof c.dealId === "string" ? c.dealId : null });
  }
  const pkgs = Array.isArray(r.packages) ? r.packages : [];
  if (pkgs.length > KIT_LIMITS.packages) return { problem: `Keep it to ${KIT_LIMITS.packages} packages.` };
  for (const [i, p] of (pkgs as Record<string, unknown>[]).entries()) {
    const name = str(p?.name, 60);
    if (!name) return { problem: `Package ${i + 1} needs a name.` };
    const items = (Array.isArray(p.items) ? p.items : [])
      .map((x) => ({ key: (x as { key: DeliverableKey }).key, qty: Math.max(1, Math.min(10, Math.round(Number((x as { qty: unknown }).qty) || 1))) }))
      .filter((x) => DELIV_KEYS.includes(x.key));
    const startingAt = money(p.startingAt);
    const floor = money(p.floor);
    const target = money(p.target);
    if ([startingAt, floor, target].some((x) => Number.isNaN(x))) return { problem: `${name}: prices are whole dollars, like 450.` };
    if (floor !== null && target !== null && floor > target) return { problem: `${name}: your floor (lowest you'd take) is above your target. Swap them.` };
    k.packages.push({ id: str(p.id, 40) || `pkg_${i + 1}`, name, items, startingAt, onRequest: !!p.onRequest, floor, target, note: str(p.note, 200), showOnKit: p.showOnKit !== false });
  }
  const a = (r.addons && typeof r.addons === "object" ? r.addons : {}) as Record<string, unknown>;
  const pct = (v: unknown, d: number, max = 300) => {
    const n = Number(v);
    return v === undefined || v === "" || !Number.isFinite(n) ? d : Math.max(0, Math.min(max, Math.round(n)));
  };
  k.addons = {
    usagePctPer30d: pct(a.usagePctPer30d, DEFAULT_ADDONS.usagePctPer30d),
    paidUsagePctPer30d: pct(a.paidUsagePctPer30d, DEFAULT_ADDONS.paidUsagePctPer30d),
    exclusivityPctPerMonth: pct(a.exclusivityPctPerMonth, DEFAULT_ADDONS.exclusivityPctPerMonth),
    rushPct: a.rushPct === null || a.rushPct === "" ? null : a.rushPct === undefined ? DEFAULT_ADDONS.rushPct : pct(a.rushPct, 0),
    bundleDiscountPct: pct(a.bundleDiscountPct, DEFAULT_ADDONS.bundleDiscountPct, 50),
    killFeePct: pct(a.killFeePct, DEFAULT_ADDONS.killFeePct, 100),
    upfrontPct: pct(a.upfrontPct, DEFAULT_ADDONS.upfrontPct, 100),
    upfrontOver: pct(a.upfrontOver, DEFAULT_ADDONS.upfrontOver, 1_000_000),
    netDays: pct(a.netDays, DEFAULT_ADDONS.netDays, 120),
    revisionRounds: pct(a.revisionRounds, DEFAULT_ADDONS.revisionRounds, 10),
  };
  k.testimonials = (Array.isArray(r.testimonials) ? r.testimonials : [])
    .map((t) => ({ quote: str((t as Testimonial)?.quote, 300), name: str((t as Testimonial)?.name, 60), role: str((t as Testimonial)?.role, 80) }))
    .filter((t) => t.quote && t.name)
    .slice(0, KIT_LIMITS.testimonials);
  const email = str(r.contactEmail, 120).toLowerCase();
  if (email && !EMAIL.test(email)) return { problem: "That contact email does not look right." };
  k.contactEmail = email || null;
  const manual = Array.isArray(r.manual) ? r.manual : [];
  for (const [i, m] of (manual as Record<string, unknown>[]).slice(0, KIT_LIMITS.manual).entries()) {
    const label = str(m?.label, 60);
    const value = str(m?.value, 40);
    if (!label || !value) continue;
    const asOf = str(m.asOf, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { problem: `"${label}" needs the date you read that number (as of).` };
    const platform = PLATFORMS.includes(m.platform as Platform) ? (m.platform as Platform) : null;
    k.manual.push({ id: str(m.id, 40) || `man_${i + 1}`, platform, label, value, asOf });
  }
  return { kit: k };
}

// ---------- figures (verified numbers the public kit may show)

export type FigureSource = "api" | "import" | "manual";
export interface PlatformFigures {
  platform: Platform;
  followers: number;
  avgViews: number;
  asOf: string;
  /** Plain words: "TikTok Studio export", "Instagram (connected)" … */
  source: string;
  /** True when the average came from numbers she typed (Stats → Your Instagram numbers), not the platform. */
  avgSelfReported: boolean;
  engagement: { rate: number; videos: number; method: string } | null;
  bestTimes: { label: string }[];
  topFormats: string[];
}

export function sourceLabel(platform: Platform, source: string): string {
  if (source === "import") return `${PLATFORM_LABEL[platform]} export you uploaded`;
  if (source === "manual") return "Typed in by you";
  return `${PLATFORM_LABEL[platform]}, read by the dashboard`;
}

export function isStale(asOf: string, now: Date): boolean {
  return now.getTime() - new Date(asOf).getTime() > STALE_DAYS * 86400_000;
}

// ---------- the public view

export interface PublicPackage {
  name: string;
  what: string;
  price: string;
  note: string;
}
export interface PublicKit {
  name: string;
  handles: Partial<Record<Platform, string>>;
  niche: string;
  location: string;
  positioning: string;
  bio: string;
  photoUrl: string | null;
  pillars: Pillar[];
  series: Pillar[];
  showcase: { id: string; hook: string; mediaUrl: string; coverUrl: string | null }[];
  figures: PlatformFigures[];
  manual: (ManualFigure & { selfReported: true })[];
  collabs: { brand: string; website: string | null; logoUrl: string | null; what: string; result: string }[];
  packages: PublicPackage[];
  addOns: string[];
  testimonials: Testimonial[];
  contactEmail: string | null;
  url: string;
  version: number;
  publishedAt: string;
  qrSvg: string;
}

export function priceText(p: Pick<RatePackage, "startingAt" | "onRequest">): string {
  if (p.onRequest || p.startingAt == null) return "Rates on request";
  return `Starting at $${p.startingAt.toLocaleString("en-US")}`;
}

/** The public shape: floor, target and private notes never leave this function. */
export function publicPackages(k: KitContent, packageLabel: (items: RatePackage["items"]) => string): { packages: PublicPackage[]; addOns: string[] } {
  const packages = k.packages.filter((p) => p.showOnKit).map((p) => ({ name: p.name, what: packageLabel(p.items), price: priceText(p), note: p.note }));
  const addOns = packages.length
    ? ["Extended usage on your channels", "Paid ads from my handle (whitelisting / Spark Ads)", "Category exclusivity", ...(k.addons.rushPct ? ["Rush turnaround (under 7 days)"] : [])]
    : [];
  return { packages, addOns };
}

// ---------- the Kit check

export type KitFix =
  | { action: "upload_photo" }
  | { action: "focus"; field: string }
  | { action: "auto_showcase" }
  | { action: "starter_packages" }
  | { action: "suggest_prices" }
  | { action: "import_collabs" }
  | { action: "use_owner_email"; email: string }
  | { action: "refresh_stats"; platform: Platform; how: "sync" | "import" }
  | { action: "connect_stats" }
  | { action: "publish" };

export interface KitIssue {
  key: string;
  level: "missing" | "stale" | "tip";
  text: string;
  fixLabel: string;
  fix: KitFix;
}

export interface KitCheckInput {
  kit: KitContent;
  figures: PlatformFigures[];
  approvedClipIds: string[];
  wonDealsNotInKit: number;
  ownerEmail: string;
  draftDiffers: boolean;
  published: boolean;
  now: Date;
}

/** Everything a brand manager would notice is missing or old, in the order she should fix it. */
export function kitCheck(i: KitCheckInput): KitIssue[] {
  const out: KitIssue[] = [];
  const k = i.kit;
  if (!k.photoKey) out.push({ key: "photo", level: "missing", text: "No photo of you. Brands want to see who they are hiring.", fixLabel: "Add a photo", fix: { action: "upload_photo" } });
  if (!Object.keys(k.handles).length) out.push({ key: "handles", level: "missing", text: "No handles. Brands check your profiles before they reply.", fixLabel: "Add your handles", fix: { action: "focus", field: "handles" } });
  if (!k.positioning) out.push({ key: "positioning", level: "missing", text: "No one-line positioning under your name.", fixLabel: "Write it", fix: { action: "focus", field: "positioning" } });
  if (!i.figures.length) out.push({ key: "stats", level: "missing", text: "No verified numbers yet. Connect your stats or upload your TikTok export.", fixLabel: "Connect stats", fix: { action: "connect_stats" } });
  for (const f of i.figures) {
    if (isStale(f.asOf, i.now)) {
      const how = f.platform === "tiktok" ? "import" : "sync";
      out.push({ key: `stale_${f.platform}`, level: "stale", text: `${PLATFORM_LABEL[f.platform]} numbers are from ${f.asOf.slice(0, 10)}, older than ${STALE_DAYS} days.`, fixLabel: how === "import" ? "Upload a new TikTok export" : "Refresh stats", fix: { action: "refresh_stats", platform: f.platform, how } });
    }
  }
  const live = k.showcase.filter((id) => i.approvedClipIds.includes(id));
  if (live.length < KIT_LIMITS.showcaseMin) {
    const lost = k.showcase.length - live.length;
    out.push({
      key: "showcase",
      level: "missing",
      text: lost > 0 ? `${lost} showcase ${lost === 1 ? "clip is" : "clips are"} no longer available; you have ${live.length} of at least ${KIT_LIMITS.showcaseMin}.` : `Your showcase has ${live.length} of at least ${KIT_LIMITS.showcaseMin} clips.`,
      fixLabel: i.approvedClipIds.length ? "Pick my best clips" : "Approve clips in Review",
      fix: i.approvedClipIds.length ? { action: "auto_showcase" } : { action: "focus", field: "showcase" },
    });
  }
  if (!k.packages.length) out.push({ key: "packages", level: "missing", text: "No packages. Brands skip kits that don't say what they can buy.", fixLabel: "Add starter packages", fix: { action: "starter_packages" } });
  else if (k.packages.some((p) => p.showOnKit && p.startingAt == null && !p.onRequest))
    out.push({ key: "prices", level: "missing", text: "Some packages have no price and are not marked \"Rates on request\".", fixLabel: "Suggest prices", fix: { action: "suggest_prices" } });
  if (k.packages.length && k.packages.some((p) => p.floor == null || p.target == null))
    out.push({ key: "floor", level: "tip", text: "Set a private floor and target on each package so the deal helper can work out counters.", fixLabel: "Suggest prices", fix: { action: "suggest_prices" } });
  if (!k.contactEmail) out.push({ key: "email", level: "missing", text: "No email for brands to write to.", fixLabel: `Use ${i.ownerEmail}`, fix: { action: "use_owner_email", email: i.ownerEmail } });
  if (i.wonDealsNotInKit > 0) out.push({ key: "collabs", level: "tip", text: `${i.wonDealsNotInKit} won ${i.wonDealsNotInKit === 1 ? "deal is" : "deals are"} not in your past collaborations.`, fixLabel: "Add them", fix: { action: "import_collabs" } });
  if (!k.testimonials.length) out.push({ key: "testimonials", level: "tip", text: "A line from a brand you worked with builds trust.", fixLabel: "Add a testimonial", fix: { action: "focus", field: "testimonials" } });
  if (!i.published) out.push({ key: "publish", level: "missing", text: "Your kit is not published yet. The public link shows nothing until you publish.", fixLabel: "Publish", fix: { action: "publish" } });
  else if (i.draftDiffers) out.push({ key: "publish", level: "stale", text: "You have changes that are not public yet.", fixLabel: "Publish changes", fix: { action: "publish" } });
  return out;
}

/** Auto-pick: her approved clips by score, up to the showcase maximum's midpoint (4), keeping ones she chose. */
export function autoShowcase(current: string[], approvedByScore: string[]): string[] {
  const keep = current.filter((id) => approvedByScore.includes(id));
  const add = approvedByScore.filter((id) => !keep.includes(id));
  return [...keep, ...add].slice(0, Math.max(KIT_LIMITS.showcaseMin, Math.min(4, keep.length + add.length)));
}

/** Stable comparison for "draft differs from published". */
export function sameKit(a: KitContent, b: KitContent | null): boolean {
  return !!b && JSON.stringify(a) === JSON.stringify(b);
}
