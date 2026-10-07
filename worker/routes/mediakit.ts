// Media kit (section 12b.1, docs/reviews/2026-09-25-mediakit-deals.md). Her side: one editor
// screen, autosaved as a draft; Publish makes a new dated version; the public link always serves
// the newest published version (drafts are never public). Figures come live from Stats with
// their "as of" date and source; a number the dashboard cannot verify is never shown, only one
// she types herself, and that is labelled self-reported on the kit.
//   GET    /api/mediakit                  draft, published versions, views, live figures, Kit check, clips, rate helper
//   PATCH  /api/mediakit                  autosave: {draft?: Partial<KitContent>, slug?}
//   POST   /api/mediakit/publish          new version from the draft
//   POST   /api/mediakit/fix              one-tap fixes from the Kit check: {action}
//   POST   /api/mediakit/image/:uploadId  check an uploaded image (photo or logo) → {key}
//   GET    /api/mediakit/pdf              → /kit/:slug/print?autoprint=1
import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireUser } from "../lib/auth";
import { getSetting, parseJson, recordEvent } from "../lib/db";
import { fail, readJson } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { log } from "../lib/log";
import { PLATFORMS, PLATFORM_LABEL, RECIPES, type Platform } from "@shared/constants";
import type { BrandProfileSections } from "@shared/types";
import { autoShowcase, cleanKit, emptyKit, kitCheck, publicPackages, sameKit, sourceLabel, starterPackages, type KitContent, type PlatformFigures, type PublicKit } from "../domain/kit";
import { ADDON_BASIS, DELIVERABLES, engagementRate, packageLabel, suggestPackage, tiktokTypicalEngagement, type DeliverableKey, type RatePackage, type VideoStat } from "../domain/ratecard";
import { bucketByTime, learningReady, rankRecipes } from "../domain/learning";
import { loadObservations } from "../jobs/metrics";
import { qrSvg } from "../domain/qr";
// Someone else's video (watermark check) never reaches her public kit: same rule as the calendar.
import { POSTABLE_CLIP_SQL } from "../domain/sourceCheck";
import { readSettings } from "./settings";

export const mediakit = new Hono<{ Bindings: Env; Variables: Vars }>();
mediakit.use("*", requireUser);

/** The creator's name on her kit until she types her own: the studio owner's name, else the studio's. */
export const kitName = (env: Pick<Env, "OWNER_NAME" | "APP_NAME">): string => (env.OWNER_NAME || env.APP_NAME || "").trim();

interface KitRow {
  bio: string;
  photo_r2_key: string | null;
  featured_clip_ids: string;
  past_partners: string;
  rates: string | null;
  public_slug: string;
  contact_email: string | null;
  updated_at: string | null;
  draft: string | null;
  draft_saved_at: string | null;
}

export async function readKit(env: Env): Promise<KitRow> {
  const kit = await env.DB.prepare("SELECT bio, photo_r2_key, featured_clip_ids, past_partners, rates, public_slug, contact_email, updated_at, draft, draft_saved_at FROM media_kit WHERE id = 1").first<KitRow>();
  return kit ?? { bio: "", photo_r2_key: null, featured_clip_ids: "[]", past_partners: "[]", rates: null, public_slug: "studio", contact_email: null, updated_at: null, draft: null, draft_saved_at: null };
}

/** The locked Brand Profile every AI step reads (section 5), or null before she locks one. */
export async function lockedProfile(env: Env): Promise<BrandProfileSections | null> {
  const row = await env.DB.prepare("SELECT sections FROM brand_profile WHERE locked = 1 ORDER BY version DESC LIMIT 1").first<{ sections: string }>();
  return row ? parseJson<BrandProfileSections | null>(row.sections, null) : null;
}

/** "Content themes (3–5)" as a list: one per line, bullet or comma. */
export function themeList(section: string | null | undefined): string[] {
  if (!section) return [];
  return section
    .split(/\n|;|•|,(?![^()]*\))/)
    .map((t) => t.replace(/^[\s\-*\d.)]+/, "").replace(/[.:]+$/, "").trim())
    .filter((t) => t.length > 1 && t.length <= 60)
    .slice(0, 5);
}

/** The audience snapshot: the first sentence or line of the profile's Audience section. */
export function audienceLine(section: string | null | undefined): string {
  if (!section) return "";
  const first = section.split(/\n/).map((s) => s.trim()).find(Boolean) ?? "";
  return first.length > 220 ? `${first.slice(0, 217).replace(/\s+\S*$/, "")}…` : first;
}

// ---------- legacy (a kit saved before versions existed) → KitContent

function fromLegacy(name: string, row: { bio?: string; featured_clip_ids?: unknown; past_partners?: unknown; rates?: unknown; contact_email?: string | null; photo_r2_key?: string | null }, profile: BrandProfileSections | null): KitContent {
  const k = emptyKit(name);
  k.bio = row.bio ?? "";
  const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? parseJson<unknown[]>(v, []) : []);
  k.showcase = arr(row.featured_clip_ids).map(String);
  k.collabs = arr(row.past_partners).map((b, i) => ({ id: `col_${i + 1}`, brand: String(b), website: null, logoKey: null, what: "", result: "", dealId: null }));
  const rates = typeof row.rates === "string" ? parseJson<Record<string, string> | null>(row.rates, null) : (row.rates as Record<string, string> | null);
  if (rates)
    k.packages = Object.entries(rates).map(([name, price], i): RatePackage => {
      const n = Number(String(price).replace(/[^0-9.]/g, ""));
      return { id: `pkg_${i + 1}`, name, items: [], startingAt: Number.isFinite(n) && n > 0 ? Math.round(n) : null, onRequest: !(Number.isFinite(n) && n > 0), floor: null, target: null, note: "", showOnKit: true };
    });
  k.contactEmail = row.contact_email ?? null;
  k.photoKey = row.photo_r2_key && /^kit\/photo\/upl_[a-z0-9]{6,40}$/.test(row.photo_r2_key) ? row.photo_r2_key : null;
  if (profile) {
    const themes = themeList(profile.themes);
    k.pillars = themes.slice(0, 4).map((t) => ({ title: t, text: "" }));
    k.niche = themes.slice(0, 3).join(" · ");
  }
  return k;
}

function asContent(name: string, raw: unknown, profile: BrandProfileSections | null): KitContent {
  if (raw && typeof raw === "object" && (raw as { legacy?: number }).legacy) return fromLegacy(name, raw as Parameters<typeof fromLegacy>[1], profile);
  const c = cleanKit(raw, name);
  return "kit" in c ? c.kit : emptyKit(name);
}

/** Her draft; first read builds it from the old single-row kit and her Brand Profile. */
export async function readDraft(env: Env): Promise<KitContent> {
  const row = await readKit(env);
  const profile = await lockedProfile(env);
  if (row.draft) return asContent(kitName(env), parseJson(row.draft, null), profile);
  return fromLegacy(kitName(env), row, profile);
}

export async function latestVersion(env: Env): Promise<{ version: number; content: KitContent; slug: string; published_at: string } | null> {
  const r = await env.DB.prepare("SELECT version, content, slug, published_at FROM media_kit_versions ORDER BY version DESC LIMIT 1").first<{ version: number; content: string; slug: string; published_at: string }>();
  if (!r) return null;
  return { ...r, content: asContent(kitName(env), parseJson(r.content, null), await lockedProfile(env)) };
}

async function saveDraft(env: Env, k: KitContent): Promise<string> {
  const at = nowIso();
  await env.DB.prepare("UPDATE media_kit SET draft = ?, draft_saved_at = ?, contact_email = ?, updated_at = ? WHERE id = 1").bind(JSON.stringify(k), at, k.contactEmail, at).run();
  return at;
}

// ---------- live figures (verified numbers only)

export async function kitFigures(env: Env, handles: Partial<Record<Platform, string>> = {}): Promise<PlatformFigures[]> {
  const s = await readSettings(env);
  const obs = await loadObservations(env);
  const buckets = bucketByTime(obs, s.audience_timezone);
  const { results: vids } = await env.DB.prepare("SELECT platform, views, likes, comments, shares, saves, posted_at FROM platform_videos").all<VideoStat>();
  const now = new Date();
  const igManual = await getSetting<{ avg_reach?: number | null } | null>(env.DB, "instagram_manual", null);
  const out: PlatformFigures[] = [];
  for (const p of PLATFORMS) {
    const r = await env.DB.prepare("SELECT followers, avg_views, captured_at, source FROM account_stats WHERE platform = ? ORDER BY captured_at DESC LIMIT 1").bind(p).first<{ followers: number; avg_views: number; captured_at: string; source: string }>();
    if (!r || r.followers <= 0) continue;
    // Numbers she typed on Stats are hers to state, not the dashboard's: they go on the kit as
    // self-reported (manualFigures), never as a verified figure.
    if (r.source === "manual") continue;
    const eng = engagementRate(vids, p, now);
    const ready = learningReady(obs, p);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const hour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
    const typical = p === "tiktok" && eng ? tiktokTypicalEngagement(r.followers) : null;
    out.push({
      platform: p,
      followers: r.followers,
      avgViews: r.avg_views,
      asOf: r.captured_at,
      source: sourceLabel(p, r.source),
      avgSelfReported: p === "instagram" && igManual?.avg_reach != null && igManual.avg_reach === r.avg_views,
      engagement: eng ? { rate: eng.rate, videos: eng.videos, method: `(likes + comments + shares + saves) ÷ views, last 90 days, ${eng.videos} videos${typical ? `; typical for ${typical.band}: ${typical.rate}% (${typical.source.name})` : ""}` } : null,
      bestTimes: ready ? buckets.filter((b) => b.platform === p && b.posts >= 2).slice(0, 2).map((b) => ({ label: `${day[b.day]} ${hour(b.hour)}` })) : [],
      topFormats: ready ? rankRecipes(obs.filter((o) => o.platform === p && o.recipe).map((o) => ({ recipe: o.recipe as string, views: o.views }))).slice(0, 2).map((x) => RECIPES[x.recipe as keyof typeof RECIPES]?.label ?? x.recipe) : [],
    });
    void handles;
  }
  return out;
}

/** Latest numbers she typed on Stats (account_stats source "manual"), as self-reported kit figures. */
async function typedStats(env: Env): Promise<KitContent["manual"]> {
  const out: KitContent["manual"] = [];
  for (const p of PLATFORMS) {
    const r = await env.DB.prepare("SELECT followers, captured_at, source FROM account_stats WHERE platform = ? ORDER BY captured_at DESC LIMIT 1").bind(p).first<{ followers: number; captured_at: string; source: string }>();
    if (r && r.source === "manual" && r.followers > 0) out.push({ id: `typed_${p}`, platform: p, label: "Followers", value: r.followers.toLocaleString("en-US"), asOf: r.captured_at.slice(0, 10) });
  }
  return out;
}

export function kitUrl(env: Env, slug: string): string {
  return `${env.PUBLIC_BASE_URL}/kit/${slug}`;
}

/** Clips that can show on the public kit: approved, media link alive. */
async function showcaseClips(env: Env, ids: string[]): Promise<PublicKit["showcase"]> {
  const out: PublicKit["showcase"] = [];
  for (const id of ids) {
    const c = await env.DB.prepare(`SELECT c.id, c.hook_text, c.media_token, c.cover_r2_key FROM clips c WHERE c.id = ? AND ${POSTABLE_CLIP_SQL} AND c.media_token IS NOT NULL`).bind(id).first<{ id: string; hook_text: string; media_token: string; cover_r2_key: string | null }>();
    if (c) out.push({ id: c.id, hook: c.hook_text, mediaUrl: `/media/${c.media_token}`, coverUrl: c.cover_r2_key ? `/media/${c.media_token}?cover=1` : null });
  }
  return out;
}

function imageUrl(slug: string, key: string | null, preview: boolean): string | null {
  if (!key) return null;
  const id = encodeURIComponent(key.split("/").pop()!);
  return preview ? `/api/mediakit/file/${id}` : `/api/public/kit/${encodeURIComponent(slug)}/image/${id}`;
}

/** Build the public view of a kit (published or a draft preview). Private rate fields never leave. */
export async function buildPublicKit(env: Env, k: KitContent, slug: string, version: number, publishedAt: string, preview = false): Promise<PublicKit> {
  const { packages, addOns } = publicPackages(k, packageLabel);
  const url = kitUrl(env, slug);
  return {
    name: k.name,
    handles: k.handles,
    niche: k.niche,
    location: k.location,
    positioning: k.positioning,
    bio: k.bio,
    photoUrl: imageUrl(slug, k.photoKey, preview),
    pillars: k.pillars,
    series: k.series,
    showcase: await showcaseClips(env, k.showcase),
    figures: await kitFigures(env, k.handles),
    manual: [...(await typedStats(env)), ...k.manual].map((m) => ({ ...m, selfReported: true as const })),
    collabs: k.collabs.map((c) => ({ brand: c.brand, website: c.website, logoUrl: c.logoKey ? imageUrl(slug, c.logoKey, preview) : c.website ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(new URL(c.website).hostname)}&sz=64` : null, what: c.what, result: c.result })),
    packages,
    addOns,
    testimonials: k.testimonials,
    contactEmail: k.contactEmail,
    url,
    version,
    publishedAt,
    qrSvg: qrSvg(url, { dark: "#211713", light: "#fffaf1", title: `QR code: ${url}` }),
  };
}

async function approvedClipIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT c.id FROM clips c WHERE ${POSTABLE_CLIP_SQL} AND c.media_token IS NOT NULL ORDER BY c.score DESC, c.created_at DESC LIMIT 60`).all<{ id: string }>();
  return results.map((r) => r.id);
}

async function wonDealsNotInKit(env: Env, k: KitContent) {
  const { results } = await env.DB.prepare(
    "SELECT d.id, b.name, b.website, d.terms FROM deals d JOIN brands b ON b.id = d.brand_id WHERE d.stage IN ('delivering','invoiced','paid','done') ORDER BY d.updated_at DESC LIMIT 20",
  ).all<{ id: string; name: string; website: string | null; terms: string }>();
  const have = new Set(k.collabs.map((c) => c.dealId).filter(Boolean));
  const names = new Set(k.collabs.map((c) => c.brand.toLowerCase()));
  return results.filter((r) => !have.has(r.id) && !names.has(r.name.toLowerCase()));
}

async function ownFeesByDeliverable(env: Env, k: KitContent): Promise<Partial<Record<DeliverableKey, number[]>>> {
  // Her own agreed fees for single-deliverable packages beat any benchmark.
  const { results } = await env.DB.prepare("SELECT terms FROM deals WHERE agreed_at IS NOT NULL AND stage NOT IN ('declined','lost')").all<{ terms: string }>();
  const out: Partial<Record<DeliverableKey, number[]>> = {};
  for (const r of results) {
    const t = parseJson<{ fee?: number | null; packageId?: string | null }>(r.terms, {});
    const pkg = k.packages.find((p) => p.id === t.packageId);
    if (!pkg || !t.fee || pkg.items.length !== 1 || pkg.items[0].qty !== 1) continue;
    (out[pkg.items[0].key] ??= []).push(t.fee);
  }
  return out;
}

async function followersByPlatform(env: Env): Promise<Partial<Record<Platform, number>>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const f of await kitFigures(env)) out[f.platform] = f.followers;
  return out;
}

export async function viewsSummary(env: Env): Promise<{ count: number; last: string | null; last7: number }> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(viewed_at) AS last FROM kit_views").first<{ n: number; last: string | null }>();
  const w = await env.DB.prepare("SELECT COUNT(*) AS n FROM kit_views WHERE viewed_at >= ?").bind(new Date(Date.now() - 7 * 86400_000).toISOString()).first<{ n: number }>();
  return { count: r?.n ?? 0, last: r?.last ?? null, last7: w?.n ?? 0 };
}

async function ownerView(env: Env, ownerEmail: string, versionLimit = 10) {
  const row = await readKit(env);
  const draft = await readDraft(env);
  const pub = await latestVersion(env);
  // Day 358: 26 versions in a year; the newest 10 here, "Show older" asks for more (versionsTotal is true).
  const { results: versions } = await env.DB.prepare("SELECT version, published_at FROM media_kit_versions ORDER BY version DESC LIMIT ?").bind(versionLimit).all<{ version: number; published_at: string }>();
  const versionsTotal = (await env.DB.prepare("SELECT COUNT(*) AS n FROM media_kit_versions").first<{ n: number }>())?.n ?? 0;
  const figures = await kitFigures(env, draft.handles);
  const approved = await approvedClipIds(env);
  const won = await wonDealsNotInKit(env, draft);
  const profile = await lockedProfile(env);
  const followers = await followersByPlatform(env);
  const own = await ownFeesByDeliverable(env, draft);
  const { results: clips } = await env.DB.prepare(
    `SELECT c.id, c.hook_text, c.score, c.media_token, c.cover_r2_key FROM clips c WHERE ${POSTABLE_CLIP_SQL} AND c.media_token IS NOT NULL ORDER BY c.score DESC, c.created_at DESC LIMIT 40`,
  ).all<{ id: string; hook_text: string; score: number; media_token: string; cover_r2_key: string | null }>();
  return {
    draft,
    draftSavedAt: row.draft_saved_at,
    slug: row.public_slug,
    publicUrl: kitUrl(env, row.public_slug),
    printPath: `/kit/${row.public_slug}/print`,
    published: pub ? { version: pub.version, publishedAt: pub.published_at } : null,
    draftDiffers: !sameKit(draft, pub?.content ?? null),
    versions,
    versionsTotal,
    views: await viewsSummary(env),
    figures,
    check: kitCheck({ kit: draft, figures, approvedClipIds: approved, wonDealsNotInKit: won.length, ownerEmail, draftDiffers: !sameKit(draft, pub?.content ?? null), published: !!pub, now: new Date() }),
    // hook_text is also read by the Voice screen's "Attach to clip" list (app/pages/Voice.tsx).
    clips: clips.map((x) => ({ id: x.id, hook: x.hook_text, hook_text: x.hook_text, score: x.score, mediaUrl: `/media/${x.media_token}`, coverUrl: x.cover_r2_key ? `/media/${x.media_token}?cover=1` : null })),
    profile: profile ? { locked: true, themes: themeList(profile.themes), audience: audienceLine(profile.audience) } : { locked: false, themes: [], audience: "" },
    helper: {
      followers,
      deliverables: Object.entries(DELIVERABLES).map(([key, d]) => ({ key, label: d.label, platform: d.platform })),
      suggestions: Object.fromEntries(draft.packages.map((p) => [p.id, suggestPackage(p.items, followers, draft.addons, own)])),
      addonBasis: ADDON_BASIS,
    },
    wonDeals: won.map((w) => ({ dealId: w.id, brand: w.name, website: w.website })),
    ownerEmail,
    platformLabels: PLATFORM_LABEL,
  };
}

mediakit.get("/", async (c) => c.json(await ownerView(c.env, c.get("user").email, Math.min(500, Math.max(10, Number(c.req.query("versions") ?? 10) || 10)))));

mediakit.get("/preview", async (c) => {
  const row = await readKit(c.env);
  const draft = await readDraft(c.env);
  return c.json(await buildPublicKit(c.env, draft, row.public_slug, 0, nowIso(), true));
});

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

mediakit.patch("/", async (c) => {
  const body = await readJson<{ draft?: Partial<KitContent>; slug?: string }>(c);
  if (!body || (!body.draft && body.slug === undefined)) return fail(c, 400, "Nothing to save.");
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (!SLUG.test(slug)) return fail(c, 422, "The link name can use 3–40 lower-case letters, numbers and dashes.", "media-kit");
    const row = await readKit(c.env);
    if (slug !== row.public_slug) {
      await c.env.DB.prepare("UPDATE media_kit SET public_slug = ? WHERE id = 1").bind(slug).run();
      await c.env.DB.prepare("INSERT OR IGNORE INTO kit_slugs (slug) VALUES (?)").bind(slug).run();
      await recordEvent(c.env.DB, "mediakit.slug", null, {}, c.get("user").email);
    }
  }
  let savedAt: string | null = null;
  if (body.draft) {
    const current = await readDraft(c.env);
    const merged = { ...current, ...body.draft };
    const clean = cleanKit(merged, kitName(c.env));
    if ("problem" in clean) return fail(c, 422, clean.problem, "media-kit");
    const approved = await approvedClipIds(c.env);
    if (clean.kit.showcase.some((id) => !approved.includes(id))) return fail(c, 422, "Only approved clips can go in your media kit.", "media-kit");
    savedAt = await saveDraft(c.env, clean.kit);
    log.info("mediakit.draft", { fields: Object.keys(body.draft).length });
  }
  return c.json({ ok: true, draftSavedAt: savedAt, view: await ownerView(c.env, c.get("user").email) });
});

mediakit.post("/publish", async (c) => {
  const row = await readKit(c.env);
  const draft = await readDraft(c.env);
  const last = await c.env.DB.prepare("SELECT MAX(version) AS v FROM media_kit_versions").first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const at = nowIso();
  await c.env.DB.prepare("INSERT INTO media_kit_versions (version, content, slug, published_at) VALUES (?, ?, ?, ?)").bind(version, JSON.stringify(draft), row.public_slug, at).run();
  if (!row.draft) await saveDraft(c.env, draft);
  await recordEvent(c.env.DB, "mediakit.published", String(version), {}, c.get("user").email);
  log.info("mediakit.published", { version });
  return c.json({ ok: true, version, publishedAt: at, view: await ownerView(c.env, c.get("user").email) });
});

type FixAction = "auto_showcase" | "starter_packages" | "suggest_prices" | "import_collabs" | "use_owner_email";

mediakit.post("/fix", async (c) => {
  const body = await readJson<{ action?: FixAction }>(c);
  const k = await readDraft(c.env);
  switch (body?.action) {
    case "auto_showcase":
      k.showcase = autoShowcase(k.showcase, await approvedClipIds(c.env));
      if (!k.showcase.length) return fail(c, 409, "Approve some clips in Review first; your best ones come here.", "review-and-approve-clips");
      break;
    case "starter_packages":
      if (!k.packages.length) k.packages = starterPackages();
      break;
    case "suggest_prices": {
      const followers = await followersByPlatform(c.env);
      const own = await ownFeesByDeliverable(c.env, k);
      let filled = 0;
      k.packages = k.packages.map((p) => {
        const s = suggestPackage(p.items, followers, k.addons, own);
        if (s.startingAt === null) return p;
        filled++;
        return { ...p, startingAt: p.startingAt ?? s.startingAt, target: p.target ?? s.target, floor: p.floor ?? s.floor };
      });
      if (!filled) return fail(c, 409, "There's no benchmark for your packages at your numbers yet, so nothing was filled in. Set your own prices, or mark them Rates on request.", "negotiate-a-rate");
      break;
    }
    case "import_collabs": {
      for (const w of await wonDealsNotInKit(c.env, k)) {
        const t = parseJson<{ deliverables?: string | null }>(w.terms, {});
        k.collabs.push({ id: newId("col", 8), brand: w.name, website: w.website ? new URL(w.website).origin : null, logoKey: null, what: t.deliverables ?? "", result: "", dealId: w.id });
      }
      k.collabs = k.collabs.slice(0, 12);
      break;
    }
    case "use_owner_email":
      k.contactEmail = c.get("user").email;
      break;
    default:
      return fail(c, 400, "Pick a fix.");
  }
  const clean = cleanKit(k, kitName(c.env));
  if ("problem" in clean) return fail(c, 422, clean.problem, "media-kit");
  await saveDraft(c.env, clean.kit);
  return c.json({ ok: true, view: await ownerView(c.env, c.get("user").email) });
});

/** An image uploaded through /api/uploads (kind "kit_photo"): checked here, then referenced from the draft. */
mediakit.post("/image/:uploadId", async (c) => {
  const uploadId = c.req.param("uploadId");
  if (!/^upl_[a-z0-9]{6,40}$/.test(uploadId)) return fail(c, 400, "That upload is not a photo.");
  const key = `kit/photo/${uploadId}`;
  const head = await c.env.FILES.head(key);
  if (!head) return fail(c, 404, "The photo did not finish uploading. Try again.", "media-kit");
  if (!(head.httpMetadata?.contentType ?? "").startsWith("image/")) return fail(c, 422, "Pick a photo (JPG or PNG).", "media-kit");
  if (head.size > 8 * 1024 * 1024) {
    await c.env.FILES.delete(key);
    return fail(c, 413, "That photo is too big. Pick one under 8 MB.", "media-kit");
  }
  return c.json({ key });
});

/** Her own draft images (the editor and Preview); the public only ever gets published ones. */
mediakit.get("/file/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^upl_[a-z0-9]{6,40}$/.test(id)) return c.text("Not found", 404);
  const obj = await c.env.FILES.get(`kit/photo/${id}`);
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=600");
  return new Response(obj.body, { headers });
});

mediakit.get("/pdf", async (c) => {
  const kit = await readKit(c.env);
  return c.redirect(`/kit/${encodeURIComponent(kit.public_slug)}/print?autoprint=1`, 302);
});
