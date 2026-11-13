// Higgsfield (owner's rulings 5 and 10, 13 Nov 2026): one place to connect it, nothing bought. The key
// is a key ID plus a secret, checked read-only (a status lookup for a request that cannot exist), and
// stored like every other pasted key. Nobody ever reads "studio host" or "site owner".
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Env } from "@worker/env";
import { SETUP_STEPS, setupStep } from "@shared/setup";
import { hasEnvKey, overlayFor, practiceList } from "@worker/lib/practice";
import { checkHiggsfield } from "@worker/services/keychecks";

afterEach(() => vi.unstubAllGlobals());
const live = { FAKE_SERVICES: "0" } as Env;

describe("Higgsfield on Connections", () => {
  it("is one optional card with its own guide, backed by the two secret names", () => {
    const step = setupStep("higgsfield")!;
    expect(SETUP_STEPS.filter((s) => s.id === "higgsfield")).toHaveLength(1);
    expect(step.title).toBe("Moving video (Higgsfield)");
    expect(step.fields.map((f) => f.name)).toEqual(["key_id", "secret"]);
    expect(step.secrets).toEqual(["HIGGSFIELD_KEY_ID", "HIGGSFIELD_KEY_SECRET"]);
    expect(readFileSync(`help/guides/${step.guide}.md`, "utf8")).toContain("#setup-higgsfield");
    expect(step.practice).toMatch(/free method/);
  });

  it("a pasted key lights it up; both halves are needed", () => {
    expect(overlayFor("higgsfield", JSON.stringify({ key_id: "id1", secret: "s1" }))).toEqual({ HIGGSFIELD_KEY_ID: "id1", HIGGSFIELD_KEY_SECRET: "s1" });
    expect(overlayFor("higgsfield", JSON.stringify({ key_id: "id1" }))).toEqual({});
    expect(hasEnvKey({ HIGGSFIELD_KEY_ID: "id1" }, "higgsfield")).toBe(false);
    expect(hasEnvKey({ HIGGSFIELD_KEY_ID: "id1", HIGGSFIELD_KEY_SECRET: "s1" }, "higgsfield")).toBe(true);
    expect(practiceList(live, new Set())).toContain("higgsfield");
    expect(practiceList({ ...live, HIGGSFIELD_KEY_ID: "id1", HIGGSFIELD_KEY_SECRET: "s1" } as Env, new Set())).not.toContain("higgsfield");
  });

  it("the check is one read-only status lookup with the Key header: 401 refused, 404 accepted", async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const answer = (status: number) =>
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get("Authorization"), method: init?.method ?? "GET" });
        return new Response("{}", { status });
      });
    answer(401);
    expect(await checkHiggsfield(live, "id1", "s1")).toMatchObject({ ok: false, error: expect.stringMatching(/not valid/) });
    answer(404);
    expect(await checkHiggsfield(live, "id1", "s1")).toMatchObject({ ok: true });
    answer(500);
    expect((await checkHiggsfield(live, "id1", "s1")).ok).toBe(false);
    expect(calls.every((c) => c.method === "GET" && c.auth === "Key id1:s1" && /^https:\/\/api\.higgsfield\.ai\/requests\/[0-9a-f-]+\/status$/.test(c.url))).toBe(true);
  });

  it("no screen says studio host or site owner", () => {
    for (const f of ["shared/setup.ts", "app/pages/Setup.tsx", "app/pages/Connect.tsx", "worker/routes/photos.ts", "worker/lib/photoPosts.ts"]) {
      const shown = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(shown, f).not.toMatch(/studio host|site owner|your host/i);
    }
  });
});
