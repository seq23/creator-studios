// API shapes shared by the React app and the Worker. Keep these plain (JSON-safe).
import type { BrandProfileKey, DealStage, Platform, Recipe } from "./constants";
import type { NotFollowed, SteerControls, Understood } from "./steer";

export type Light = "green" | "yellow" | "red" | "grey";

export interface Me {
  id: string;
  email: string;
  role: "owner" | "helper";
  appName: string;
  features: Features;
  /** "open": no login on this deployment (no log-in guide, no log-out). "code": the email-code login. */
  authMode: "open" | "code";
  /** The owner's first name from the studio registry ("" for a sample studio). */
  ownerName: string;
  /** Setup services still in practice mode (no key yet): the app labels them on every screen. */
  practice: string[];
}

export interface Features {
  voice: boolean;
  deeper_research: boolean;
  weekly_recap: boolean;
  help_ask: boolean;
}

export interface HealthItem {
  name: string;
  light: Light;
  note: string;
  fix_guide: string | null;
  checked_at: string;
}

export interface HomeSummary {
  today: string;
  runway: { weeks: number; approvedClips: number; thresholdWeeks: number; weeklyNeed: number };
  thisWeek: { posted: number; planned: number; perPlatform: Record<Platform, { posted: number; cap: number }> };
  waiting: { clips: number; clipsThisWeek: number; dumpsCutting: number; briefNeedsApproval: boolean; profileUnlocked: boolean };
  /** every light, worst first, capped (`total` = all of them; Settings lists the rest) */
  health: HomeSection<HealthItem>;
  /** Deal emails due soon (worker/routes/deals.ts dueDealItems): `what` is the next action, e.g. "Send follow-up 2". */
  followups: HomeSection<{ key: string; dealId: string; brand: string; dueAt: string; what: string }>;
  recentDumps: HomeSection<DumpSummary & { key: string }>;
  /**
   * "Needs you" at the top, most urgent first, ONE at a time (HOME_CAPS.notices; dismiss shows the
   * next): profile, storage red, a full video about to go, clips clearing soon, YouTube to-dos, the
   * new brief, storage yellow.
   */
  notices: HomeSection<HomeNotice>;
  /** Home's quiet "Your voice" card (worker/domain/voiceEngine.ts homeVoiceCard). */
  voice: { state: "not_set_up" | "built_in_ready" | "premium_on" | "problem"; line: string; link: { to: string; label: string } };
}

/** A full video for YouTube that needs her: Finish in YouTube Studio, Upload it yourself, or removed soon. */
export interface HomeYoutubeCard {
  key: string;
  /** youtube_note: a full video on its way to her channel (Connect YouTube) that has something to say: waiting for tomorrow's allowance, a thumbnail that needs her channel verified, or a read-back that didn't match. */
  kind: "finish_in_studio" | "upload_yourself" | "removal_soon" | "youtube_note";
  clip_id: string;
  title: string;
  thumbnail_url: string | null;
  tags: string[];
  studio_url: string;
  download_url: string | null;
  delete_on: string | null;
  /** Plain sentence for youtube_note / a direct upload that fell back to upload_yourself. */
  note?: string | null;
  /** One link with the note (e.g. YouTube's verify page). */
  link?: { label: string; url: string } | null;
}

export type HomeNotice =
  | { key: string; kind: "profile" | "brief" }
  | { key: string; kind: "storage"; light: "yellow" | "red"; line: string }
  | ({ kind: "clearing" } & ClearingSoon)
  | { key: string; kind: "youtube"; card: HomeYoutubeCard };

export interface DumpSummary {
  id: string;
  /** Which door: new videos, old posts, or "youtube" (a full video for YouTube: dumps.kind = 'full_video'). */
  door: "new" | "recycle" | "youtube";
  notes: string;
  status: "uploading" | "queued" | "cutting" | "ready" | "reviewed" | "failed";
  files: number;
  clips_made: number;
  created_at: string;
  ready_at: string | null;
  error_summary: string | null;
  progress: { step: string; done: number; total: number } | null;
  /** "Looks like someone else's video: …" when a video's watermark is another creator's. */
  held_note: string | null;
  /** The chips she tapped (empty = Surprise me), and what her note was read as. */
  steer: SteerControls;
  understood: Understood | null;
  /** After the cut: what could not be done as asked, and why (never silently dropped). */
  not_followed: NotFollowed[];
  /** "What we tried: …" (one line, Surprise me). */
  tried: string | null;
  /** Archived (by her or by the tidy rules): out of the list unless "Show archived". */
  archived_at?: string | null;
}

/** A page of a long list: the rows, and the TRUE count for what she asked (day 358). */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DumpList extends Page<DumpSummary> {
  /** how many dumps are archived (the "Show archived (N)" button) */
  archived: number;
}

/** A Home section: at most its cap in `items` (shared/constants.ts HOME_CAPS), `total` for "See all (N)". */
export interface HomeSection<T> {
  items: T[];
  total: number;
}

/** One file kind on the storage meter (worker/lib/storage.ts storageReport). */
export interface StorageKindView {
  key: string;
  label: string;
  bytes: number;
  count: number;
  rule: string;
}

export interface StorageView {
  used_bytes: number;
  limit_bytes: number;
  budget_bytes: number;
  free_bytes: number;
  light: "green" | "yellow" | "red";
  line: string;
  kinds: StorageKindView[];
  measured_at: string | null;
  tidy_on: boolean;
}

/** Home's "Clearing soon": unapproved drafts whose file goes after the warning (worker/domain/tidy.ts). */
export interface ClearingSoon {
  key: string;
  drafts: number;
  first_on: string;
  bytes: number;
}

export interface AssetRow {
  id: string;
  dump_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  upload_status: "uploading" | "uploaded" | "failed" | "aborted";
  file_note: string | null;
  /** What this video's own note was read as (it steers this video's clips). */
  understood: Understood | null;
  original_platform: string | null;
  original_posted_at: string | null;
  original_views: number | null;
}

export interface ClipRow {
  id: string;
  asset_id: string;
  dump_id: string;
  start_s: number;
  end_s: number;
  recipe: Recipe;
  hook_text: string;
  hook_alt: string | null;
  caption: string;
  hashtags: string;
  platforms: Platform[];
  score: number;
  status: "draft" | "approved" | "rejected" | "deleted";
  reject_reason: string | null;
  paid_partnership: boolean;
  hidden: boolean;
  created_at: string;
  media_url: string;
  cover_url: string | null;
  source_file: string;
  door: "new" | "recycle" | "youtube";
}

export interface PostRow {
  id: string;
  clip_id: string;
  platform: Platform;
  scheduled_at: string;
  status: "planned" | "in_buffer" | "posted" | "failed" | "unscheduled";
  url: string | null;
  error: string | null;
  hook_text: string;
  cover_url: string | null;
  recipe: Recipe;
  door: "new" | "recycle";
}

export interface SettingsShape {
  weekly_caps: Record<Platform, number>;
  hard_cap_per_channel: number;
  runway_threshold_weeks: number;
  notify_emails: string[];
  posting_slots_source: "research" | "custom";
  features: Features;
  recycle_cooldown_days: number;
  helper_email: string | null;
  audience_timezone: string;
}

export interface ConnectionView {
  service: "buffer" | "openrouter" | "firecrawl" | "resend" | "hunter" | "meta" | "google" | "tiktok" | "github" | "elevenlabs" | "opusclip" | "vizard" | "klap" | "submagic" | "descript" | "youtube" | "youtube_api" | "google_app" | "meta_app";
  status: "missing" | "ok" | "error" | "disconnected";
  meta: Record<string, unknown>;
  last_ok_at: string | null;
  last_error: string | null;
}

export type BrandProfileSections = Record<BrandProfileKey, string>;

export interface BrandProfileView {
  version: number;
  sections: BrandProfileSections;
  locked: boolean;
  locked_at: string | null;
  source: "draft" | "edited" | "rollback";
  created_at: string;
}

export interface BrandDocRow {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  extract_status: "pending" | "extracting" | "done" | "failed" | "unreadable";
  extract_error: string | null;
  uploaded_at: string;
}

export interface Claim {
  text: string;
  source_ids: string[];
  basis: "her_data" | "web" | "upload";
  confidence: "solid" | "uncertain";
}

export interface BriefSource {
  id: string;
  url: string | null;
  title: string;
  kind: "her_data" | "web" | "upload";
}

export interface BriefBody {
  audience: Claim[];
  themes: { title: string; claims: Claim[] }[];
  hooks: Claim[];
  cut_styles: Claim[];
  best_times: Record<Platform, { day: number; hour: number; minute: number; claim: Claim }[]>;
  comparable_creators: { handle: string; platform: Platform; why: Claim }[];
  shot_list: Claim[];
}

export interface BriefView {
  version: number;
  body: BriefBody;
  sources: BriefSource[];
  status: "draft" | "approved" | "superseded";
  approved_at: string | null;
  created_at: string;
}

export interface BrandCard {
  id: string;
  name: string;
  website: string | null;
  program_url: string | null;
  socials: Record<string, string>;
  fit_score: number;
  fit_reasons: string[];
  why_now: string | null;
  source_links: string[];
  origin: "her_list" | "finder" | "program_search";
  status: "suggested" | "saved" | "hidden";
  contacts: { id: string; kind: "form" | "role_email" | "agency"; value: string; found_on_url: string }[];
  deal: { id: string; stage: DealStage; next_followup_at: string | null } | null;
  pitch: PitchView | null;
}

export interface PitchView {
  id: string;
  brand_id: string;
  contact_id: string | null;
  subject: string;
  body: string;
  dm_text: string;
  followup_1: string;
  followup_2: string;
  clip_links: string[];
  status: "drafted" | "sent" | "replied" | "closed";
  sent_at: string | null;
  next_followup_at: string | null;
}

export interface MediaKitPublic {
  name: string;
  bio: string;
  photo_url: string | null;
  themes: string[];
  audience: string;
  platforms: { platform: Platform; followers: number; avg_views: number }[];
  featured: { id: string; hook_text: string; media_url: string; cover_url: string | null }[];
  past_partners: string[];
  rates: Record<string, string> | null;
  contact_email: string | null;
}

export interface HelpGuideMeta {
  slug: string;
  title: string;
  group: "getting_started" | "everyday" | "brand_deals" | "fix_it";
  screen: string | null;
  steps: number;
  last_checked: string | null;
}

export interface JobRow {
  id: string;
  type: "cut" | "extract" | "research" | "brand_finder" | "voice" | "help_screenshots" | "metrics" | "fullvideo" | "ytupload";
  status: "queued" | "dispatched" | "running" | "done" | "failed";
  ref_id: string | null;
  safe_error: string | null;
  progress: { step: string; done: number; total: number } | null;
  created_at: string;
  finished_at: string | null;
}

export interface ApiError {
  error: string;
  fix_guide?: string;
}
