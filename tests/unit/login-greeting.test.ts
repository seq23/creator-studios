// The login card's greeting (owner, 7 Oct 2026): a first-time claimer opening her first-login
// invite link is greeted "welcome", never "welcome back"; a returning login says "welcome back".
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("../../app/state", () => ({ useApp: () => ({ refreshMe: async () => {} }) }));
vi.mock("../../app/components/ui", () => ({ useToast: () => ({ bad: () => {} }) }));
vi.mock("../../app/components/Shell", () => ({ LegalLinks: () => null }));
vi.mock("../../app/components/Wordmark", () => ({ Wordmark: () => null }));

const greeting = async (hash: string) => {
  vi.stubGlobal("window", { location: { hash, pathname: "/" }, history: { replaceState: () => {} } });
  // @ts-expect-error the app's .tsx is typechecked by tsconfig.json (DOM + JSX), not this worker-typed test config
  const { Login } = await import("../../app/pages/Login");
  const html = renderToString(createElement(Login));
  return html.match(/<span class="script">([^<]*)<\/span>/)?.[1];
};

afterEach(() => vi.unstubAllGlobals());

describe("login greeting", () => {
  it("the claim screen (invite link) says welcome; a normal login says welcome back", async () => {
    expect(await greeting("#invite=tok-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("welcome");
    expect(await greeting("")).toBe("welcome back");
  });
});
