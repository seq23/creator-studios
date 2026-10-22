// Realistic motion for photo videos (owner's word 22 Oct 2026): the photo maker's signed spec asks
// for it ONLY when the studio has a Hugging Face token (Setup, or the HF_TOKEN Worker secret), so a
// studio without one makes no Hugging Face call; the reel is labelled "Made with AI" whichever way
// it moved; Setup shows the named stop "Connect Hugging Face (free) for realistic motion" until a
// token is set, and nothing else depends on it.
import { describe, expect, it } from "vitest";
import { motionSpec, parsePackResult } from "@worker/jobs/photopack";
import { packOutPrefix } from "@worker/lib/photoPosts";
import { overlayFor, hasEnvKey, practiceList } from "@worker/lib/practice";
import { AI_MADE, ITEM_LABEL } from "@shared/photoPosts";
import { SETUP_STEPS, setupStep } from "@shared/setup";
import type { Env } from "@worker/env";

describe("realistic motion: no token, no call", () => {
  it("no token (unset, empty, spaces) → no motion block in the spec", () => {
    for (const t of [undefined, "", "   "]) expect(motionSpec({ HF_TOKEN: t } as Env), String(t)).toEqual({});
  });

  it("a token → the Wan 2.2 motion block carrying it", () => {
    expect(motionSpec({ HF_TOKEN: "hf_test" } as Env)).toEqual({ motion: { engine: "hf-wan2.2", hf_token: "hf_test" } });
  });
});

describe("the result says how the reel moved; anything else reads as the slow zoom", () => {
  const pack = "pk_1";
  const o = packOutPrefix(pack);
  const items = [{ kind: "reel", key: `${o}reel.mp4`, cover_key: `${o}reel.jpg` }];
  it("realistic / slow-zoom / missing / junk", () => {
    const at = (m: unknown) => parsePackResult({ privacy: { status: "clean" }, motion: m, items }, pack).motion;
    expect(at("realistic")).toBe("realistic");
    expect(at("slow-zoom")).toBe("slow-zoom");
    expect(at(undefined)).toBe("slow-zoom");
    expect(at("<script>")).toBe("slow-zoom");
  });

  it("the reel always carries the AI label, and its name fits both kinds of motion", () => {
    expect(AI_MADE.reel).toBe(true);
    expect(ITEM_LABEL.reel).not.toMatch(/zoom/i);
  });
});

describe("Setup: Connect Hugging Face (free) for realistic motion", () => {
  const step = setupStep("huggingface")!;
  it("is a free step backed by the HF_TOKEN secret, with its own guide", () => {
    expect(step.title).toBe("Connect Hugging Face (free) for realistic motion");
    expect(step.secrets).toEqual(["HF_TOKEN"]);
    expect(step.free).toBe(true);
    expect(step.guide).toBe("connect-huggingface");
    expect(step.practice).toMatch(/slow zoom/i);
    expect(SETUP_STEPS.filter((s) => s.id === "huggingface")).toHaveLength(1);
  });

  it("practice until a token is set (pasted or secret), then not", () => {
    expect(overlayFor("huggingface", "hf_x")).toEqual({ HF_TOKEN: "hf_x" });
    expect(hasEnvKey({}, "huggingface")).toBe(false);
    expect(hasEnvKey({ HF_TOKEN: "hf_x" }, "huggingface")).toBe(true);
    expect(practiceList({ FAKE_SERVICES: "0" } as Env, new Set())).toContain("huggingface");
    expect(practiceList({ FAKE_SERVICES: "0", HF_TOKEN: "hf_x" } as Env, new Set())).not.toContain("huggingface");
  });
});
