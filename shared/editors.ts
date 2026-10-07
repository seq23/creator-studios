// The editor catalogue (docs/EDITORS.md): what each connected editor and hand-off app is, in her
// words. Data only, shared by the Worker (worker/domain/editors.ts adds the rules) and the app
// (Connect's rows, Settings > Editing > Who edits, Review's Edit in CapCut).
export const EDITOR_CAPABILITIES = ["cut_from_source", "caption", "enhance", "templates"] as const;
export type EditorCapability = (typeof EDITOR_CAPABILITIES)[number];

/** The jobs "Who edits" offers a choice for. Templates are the built-in Looks only (no API tool makes video templates). */
export const CHOOSABLE = ["cut_from_source", "caption", "enhance"] as const;
export type ChoosableCapability = (typeof CHOOSABLE)[number];

export const CAPABILITY_TEXT: Record<EditorCapability, { name: string; what: string }> = {
  cut_from_source: { name: "Cutting a dump into clips", what: "Finds the moments in your videos and makes the clips." },
  caption: { name: "Captions", what: "Puts the words you say on screen." },
  enhance: { name: "Polish", what: "Cleans up filler words and sound." },
  templates: { name: "Templates", what: "The look of each clip: your Looks, made by the built-in editor." },
};

export const API_EDITORS = ["opusclip", "vizard", "klap", "submagic", "descript"] as const;
export type ApiEditorId = (typeof API_EDITORS)[number];
export const HANDOFF_APPS = ["capcut", "inshot", "other"] as const;
export type HandoffApp = (typeof HANDOFF_APPS)[number];

export interface ApiEditorDef {
  id: ApiEditorId;
  name: string;
  capabilities: ChoosableCapability[];
  /** One sentence on the Connect row. */
  why: string;
  /** How she gets the key, in her words. */
  steps: string[];
  /** What it costs her, from the vendor's own pricing page. */
  pricing: string;
  /** Whether the vendor's API tells us credits used/left. None of these does today (docs/EDITORS.md). */
  reportsCredits: boolean;
}

export const EDITORS: readonly ApiEditorDef[] = [
  {
    id: "opusclip",
    name: "Opus Clip",
    capabilities: ["cut_from_source"],
    why: "Cuts your dumps into clips instead of the built-in editor, in Opus Clip’s style. Uses your Opus Clip credits (about 1 credit per minute of video).",
    steps: ["Open opus.pro → your profile → API (paid plans)", "Create a key and copy it", "Paste it here"],
    pricing: "Paid Opus Clip plans (Pro and up); 1 credit per minute of video, at least 10 per video.",
    reportsCredits: false,
  },
  {
    id: "vizard",
    name: "Vizard",
    capabilities: ["cut_from_source"],
    why: "Cuts your dumps into clips instead of the built-in editor. Uses your Vizard credits.",
    steps: ["Open vizard.ai → Workspace settings → API (paid plans)", "Copy your API key", "Paste it here"],
    pricing: "Paid Vizard plans only.",
    reportsCredits: false,
  },
  {
    id: "klap",
    name: "Klap",
    capabilities: ["cut_from_source", "caption"],
    why: "Cuts your dumps into clips with Klap’s captions, instead of the built-in editor. Uses your Klap plan.",
    steps: ["Open klap.app → REST API", "Create a key and copy it", "Paste it here"],
    pricing: "Klap plans (Basic, Pro, Pro+) or usage-based API pricing.",
    reportsCredits: false,
  },
  {
    id: "submagic",
    name: "Submagic",
    capabilities: ["caption", "enhance"],
    why: "Adds Submagic’s animated captions and zooms to each new clip. Uses your Submagic API minutes.",
    steps: ["Open submagic.co → Settings → API (Business + API plan)", "Copy your API key", "Paste it here"],
    pricing: "Business + API plan, about $69 a month with 100 API minutes.",
    reportsCredits: false,
  },
  {
    id: "descript",
    name: "Descript",
    capabilities: ["enhance"],
    why: "Polishes each new clip with Descript: removes filler words and cleans the sound. Uses your Descript media minutes and AI credits.",
    steps: ["Open Descript → Settings → API tokens", "Create token and copy it", "Paste it here"],
    pricing: "Paid Descript plans; uses your media minutes and AI credits.",
    reportsCredits: false,
  },
];

export const HANDOFF: Record<HandoffApp, { name: string; row: string; web: string }> = {
  capcut: {
    name: "CapCut",
    row: "CapCut: no key needed. Send a clip to CapCut from Review and upload your edit back. Use it instead of the built-in editor whenever you like.",
    web: "https://www.capcut.com/editor",
  },
  inshot: {
    name: "InShot",
    row: "InShot: no key needed. Send a clip to InShot from Review and upload your edit back.",
    web: "https://inshot.com/",
  },
  other: {
    name: "another app",
    row: "Any other editing app (Descript, VN, Instagram Edits…): send the clip, edit it there, upload your edit back.",
    web: "",
  },
};

