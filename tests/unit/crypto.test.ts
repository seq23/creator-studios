import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signJobMessage, signSession, verifyJobMessage, verifySessionCookie } from "@worker/lib/crypto";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

describe("connection secrets at rest", () => {
  it("round-trips and never stores plain text", async () => {
    const packed = await encryptSecret(KEY, "buffer-key-123");
    expect(packed).not.toContain("buffer-key");
    expect(await decryptSecret(KEY, packed)).toBe("buffer-key-123");
  });
  it("a different key cannot read it", async () => {
    const packed = await encryptSecret(KEY, "x");
    const other = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    await expect(decryptSecret(other, packed)).rejects.toThrow();
  });
});

describe("job signatures", () => {
  it("accepts a fresh, correct signature and rejects a tampered body", async () => {
    const { timestamp, signature } = await signJobMessage("s", '{"a":1}');
    expect(await verifyJobMessage("s", '{"a":1}', String(timestamp), signature)).toBe(true);
    expect(await verifyJobMessage("s", '{"a":2}', String(timestamp), signature)).toBe(false);
    expect(await verifyJobMessage("other", '{"a":1}', String(timestamp), signature)).toBe(false);
  });
  it("rejects a signature older than 10 minutes", async () => {
    const old = Math.floor(Date.now() / 1000) - 700;
    const { signature } = await signJobMessage("s", "body", old);
    expect(await verifyJobMessage("s", "body", String(old), signature)).toBe(false);
  });
});

describe("session cookie", () => {
  it("verifies its own signature and rejects a forged id", async () => {
    const cookie = await signSession("secret", "ses_abc");
    expect(await verifySessionCookie("secret", cookie)).toBe("ses_abc");
    expect(await verifySessionCookie("secret", "ses_zzz." + cookie.split(".")[1])).toBeNull();
    expect(await verifySessionCookie("secret", undefined)).toBeNull();
  });
});
