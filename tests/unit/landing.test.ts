// Sample 3's one-page landing (studios/sample3.json -> `landing`): config, never a code fork. A
// studio with no `landing` entry carries no STUDIO_LANDING var and keeps today's plain login card
// (worker/routes/studio.ts readLanding(), app/components/StudioLanding.tsx).
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Env, Vars } from "@worker/env";
import { readLanding, studio } from "@worker/routes/studio";
// @ts-expect-error plain .mjs, no types
import { envBlock, loadRegistry } from "../../scripts/studio.mjs";

const root = process.cwd();
const reg = loadRegistry(root);
const sample3 = reg.studios.find((s: { slug: string }) => s.slug === "sample3");

const VALID = {
  heading: "Your footage, cut and ready to post.",
  sub: "Sample 3 Studio takes the videos already on your phone and turns them into short posts.",
  cta: "Email me a code",
  steps: [
    { title: "Dump it", body: "Send the clips off your phone." },
    { title: "We cut it", body: "The studio cuts short posts from your footage." },
    { title: "You approve", body: "Nothing posts until you tap approve." },
  ],
  facts: ["Real footage only.", "Built for a phone.", "Sign in with a code we email you."],
  signInHeading: "Sign in to your studio",
};

describe("envBlock: STUDIO_LANDING only when a studio has a landing block", () => {
  it("sample3 carries STUDIO_LANDING; the others carry none", () => {
    for (const s of reg.studios) {
      const e = envBlock(s, reg.themes);
      if (s.slug === "sample3") expect(JSON.parse(e.vars.STUDIO_LANDING)).toEqual(sample3.landing);
      else expect(e.vars).not.toHaveProperty("STUDIO_LANDING");
    }
  });
});

describe("readLanding: strict, null on anything unexpected", () => {
  it("returns the block for the real registry JSON", () => {
    expect(readLanding({ STUDIO_LANDING: JSON.stringify(sample3.landing) })).toEqual(sample3.landing);
  });

  it("null when the var is missing or empty", () => {
    expect(readLanding({})).toBeNull();
    expect(readLanding({ STUDIO_LANDING: "" })).toBeNull();
  });

  it("null on malformed JSON", () => {
    expect(readLanding({ STUDIO_LANDING: "{not json" })).toBeNull();
  });

  it("null on an over-long field", () => {
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, heading: "x".repeat(121) }) })).toBeNull();
    expect(readLanding({ STUDIO_LANDING: JSON.stringify(VALID) })).not.toBeNull();
  });

  it("null on markup in any text field", () => {
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, sub: "<script>alert(1)</script>" }) })).toBeNull();
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, facts: [...VALID.facts.slice(0, 2), "<b>hi</b>"] }) })).toBeNull();
  });

  it("null when steps or facts are outside 3-6", () => {
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, steps: VALID.steps.slice(0, 2) }) })).toBeNull();
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, facts: VALID.facts.slice(0, 1) }) })).toBeNull();
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, steps: Array(7).fill(VALID.steps[0]) }) })).toBeNull();
  });

  it("null when a step is missing a title or body", () => {
    expect(readLanding({ STUDIO_LANDING: JSON.stringify({ ...VALID, steps: [{ title: "Dump it" }, VALID.steps[1], VALID.steps[2]] }) })).toBeNull();
  });
});

describe("GET /api/studio returns landing", () => {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.route("/api/studio", studio);
  const get = (env: Partial<Env>) => app.request("https://w.example/api/studio", {}, { APP_NAME: "Sample 3 Studio", OWNER_NAME: "", ...env } as Env);

  it("a studio with a landing block", async () => {
    const res = await get({ STUDIO_LANDING: JSON.stringify(sample3.landing) });
    expect((await res.json() as { landing: unknown }).landing).toEqual(sample3.landing);
  });

  it("a studio without one", async () => {
    const res = await get({});
    expect((await res.json() as { landing: unknown }).landing).toBeNull();
  });
});

describe("the sample3 landing block holds no identifier", () => {
  it("no email address, no http link, no host identifier anywhere in it", () => {
    const text = JSON.stringify(sample3.landing);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\bwest\s*peek\b/i);
  });
});
