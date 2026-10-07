# Editors: which creator video tools can be connected, and how

The owner's ask (25 Sep 2026): "make sure we have a connection option for Sam to connect her
own CapCut and use that in lieu of our open source alt. We also need to make sure any other
premium popular influencer software can be connected that can adjust videos (only the most
popular)."

The built-in editor (Looks, `jobs/looks.py`) is free and always works. Another editor is an
option on top, never a requirement: when a connected editor is down, out of credits or
disconnected, the built-in editor does the work and the Connect row says why.

## What each tool offers (checked 25 Sep 2026)

"Self-serve API" means a solo creator can get a key or sign in from her own account, without a
sales call, an enterprise plan or an application. Checked on each vendor's own developer pages.

| Tool | Self-serve API | What the API can do | Pricing note | Source |
| --- | --- | --- | --- | --- |
| **CapCut** | **No** | No public editing or render API; the "AI API" page is marketing with no keys or endpoints. Only unofficial reverse-engineered projects exist (not used). No documented `capcut://` link either. | App: free, Pro subscription | https://www.capcut.com/explore/ai-api |
| **InShot** | **No** | No developer documentation at all. No documented app link. | App: free, Pro subscription | inshot.com (no developer pages) |
| **Descript** | **Yes** (token in the app: Settings → API tokens) | Import media from a link (`POST /v1/jobs/import/project_media`), poll (`GET /v1/jobs/{id}`), AI edits with Underlord (`POST /v1/jobs/agent`), publish for a download link (`POST /v1/jobs/publish`), account check (`GET /v1/status`); 402 when out of credits | Paid plans; uses her media minutes / AI credits | https://docs.descriptapi.com/ |
| **Opus Clip** | **Yes** (paid plans: Pro, Max, Business) | Long video link → short clips (`POST /api/clip-projects`), clips of a project (`GET /api/exportable-clips?q=findByProjectId&projectId=…`: `uriForExport`, `durationMs`, `title`) | 1 credit = 1 minute of video, 10-credit minimum per video; 30 requests/minute. Credits are not reported by the API | https://help.opus.pro/api-reference/overview |
| **Vizard** | **Yes** (paid users) | Long video link → short clips (`POST /project/create`, poll `GET /project/query/{projectId}` every 30 s) | Paid plans only; credits not reported by the API | https://docs.vizard.ai/docs/quickstart |
| **Klap** | **Yes** (key at klap.app → REST API) | Video → shorts task (`POST /v2/tasks/video-to-shorts`), task status, projects, exports | Plan-based (Basic, Pro, Pro+) plus usage-based API pricing; exact credit cost per call not published | https://docs.klap.app/ |
| **Submagic** | **Yes** (Business + API plan) | Captions, zooms, b-roll, music on a video (`POST /v1/projects`), health check (`GET /health`) | Business + API: $69/month with 100 API minutes, then $0.10–0.15/minute | https://docs.submagic.co/introduction |
| **Captions (now Mirage)** | Yes, but its endpoints could not be verified | Captions and AI videos: "call the generate endpoint, poll the status endpoint, retrieve your video"; no literal paths or schema on its pages | Not published | https://captions.ai/help/docs/api/overview |
| **Canva** | Yes (OAuth, Connect API) | Designs: brand templates, assets, export. It does not cut or caption a video; filling brand templates (autofill) needs Canva Enterprise; the integration must be registered by the builder (client id and secret) | Free to use the API; autofill is Enterprise | https://www.canva.dev/docs/connect/ |
| **VEED** | **No** (its editing API was retired around 2021) | Only single AI models (Fabric, Lipsync) through fal.ai, not a video editor | Per second via fal.ai | https://www.submagic.co/blog/does-veed-have-an-api (veed.io API pages no longer resolve) |
| **Adobe Express** | **Gated** (beta access request form, enterprise provisioning) | Templates and renditions through Firefly Services | Firefly Services credits | https://developer.adobe.com/firefly-services/docs/express-api/ |

## What the dashboard builds

Two kinds of connection, and nothing else:

1. **Hand-off and hand-back** for the tools with no API: **CapCut** first, and **InShot**. On
   every clip in Review, **Edit in CapCut** gives her the clip (a download, or on the phone the
   share sheet, where she picks CapCut) and **Replace with my edit** takes her finished video
   back. Her edit is checked (a tall 9:16 video, long enough, within the time each ticked
   platform allows), its loudness and cover are made again by the cut job, and the clip is marked
   **Edited in CapCut**. This is how she uses CapCut instead of the built-in editor. The Connect
   screen shows CapCut and InShot as rows that need no key, state **Ready**. No undocumented
   `capcut://` link is used: none is published, and the phone's share sheet opens CapCut reliably.
2. **API connections** for the tools with a verified self-serve API and a job the dashboard can
   give them. Each is a Connect row like ElevenLabs's: paste key, **Check key**, **Disconnect**, a
   health light, and credits when the vendor's API reports them (none of these five does today;
   the row says so):

   | Editor | Does | Connect row |
   | --- | --- | --- |
   | Opus Clip | `cut_from_source`: a dump is sent to Opus Clip instead of the built-in cutter | key |
   | Vizard | `cut_from_source` | key |
   | Klap | `cut_from_source`, `caption` | key |
   | Submagic | `caption`, `enhance` | key |
   | Descript | `enhance` (Underlord: remove filler words, studio sound) | token |

   Settings → Editing → **Who edits** chooses, per job (`cut_from_source`, `caption`,
   `enhance`), **Built-in (free)** or a connected editor that does it. Built-in is the default
   and the fallback. Whatever another editor sends back goes through the same checks as the
   built-in cutter (`parseCutResult` in `worker/jobs/cut.ts`, and the cut job's import mode
   re-measures every file); the dashboard never trusts a third party's output blindly.

**Not built, and why** (decided, not pending):

- **Canva**: its API makes designs from templates; it cannot cut, caption or enhance a video,
  and filling brand templates needs Canva Enterprise. The built-in Looks are the templates.
- **Captions / Mirage**: the API exists but its request paths and answers are not published
  where they could be checked; a connector written against guesses would fail silently.
  Re-check the docs page above; when the paths are published it is one more entry in
  `worker/domain/editors.ts` and `worker/services/editors.ts`.
- **VEED**, **Adobe Express**: no self-serve editing API (retired / gated).

## Proof so far

- Fakes for every connector (`FAKE_SERVICES=1`): keys starting `good-` work, `good-low-` report
  low credits, anything else is refused; a fake project finishes on the first poll with clips
  the import checks like real ones. e2e: `tests/e2e/editors.spec.ts`.
- No real key exists for any of these editors in the owner's vault (checked with
  `python3 -m repo_operator.cli vault list`, 25 Sep 2026), so no real call has been made. The
  request shapes follow each vendor's published docs above; the first real key proves or
  corrects them. Until then each real client is **not yet proven**.
