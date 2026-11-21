// A studio whose bucket is on another Cloudflare account (owner, 20 Nov 2026: Hadiyah's files moved
// to the second account) reaches it over the S3 API: worker/services/s3files.ts must behave like the
// R2 binding for everything the Worker does (put, get with a range, head, list, delete, multipart),
// and hydrate() must swap it in only when the registry says r2.s3.
import { describe, expect, it } from "vitest";
import { S3Files, filesFor, s3Config, signedDownload } from "@worker/services/s3files";
import { memoryR2 } from "./helpers/r2-memory";
import { fakeS3 } from "./helpers/s3-fake";
import type { Env } from "@worker/env";

const cfg = { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "her-bucket", accessKeyId: "AKID", secretAccessKey: "SECRET" };
const bytes = (s: string) => new TextEncoder().encode(s);

/** The same steps against the R2 binding and against S3: the results must match. */
async function scenario(files: R2Bucket) {
  const out: unknown[] = [];
  await files.put("raw/d1/a b.mov", bytes("0123456789"), { httpMetadata: { contentType: "video/quicktime" } });
  await files.put("brain/doc", new Response("hello").body!, { httpMetadata: { contentType: "text/plain" } });
  const head = await files.head("raw/d1/a b.mov");
  out.push(["head", head?.size, head?.httpMetadata?.contentType]);
  out.push(["missing", await files.head("nope"), await files.get("nope")]);
  const ranged = await files.get("raw/d1/a b.mov", { range: new Headers({ range: "bytes=2-5" }) });
  out.push(["range", ranged?.size, ranged?.range, await new Response(ranged!.body).text()]);
  const whole = await files.get("brain/doc");
  const h = new Headers();
  whole!.writeHttpMetadata(h);
  out.push(["whole", await new Response(whole!.body).text(), h.get("content-type"), typeof whole!.httpEtag]);
  const mp = await files.createMultipartUpload("out/clip.mp4", { httpMetadata: { contentType: "video/mp4" } });
  const p1 = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).uploadPart(1, new Response("abc").body!);
  const p2 = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).uploadPart(2, bytes("def"));
  const done = await files.resumeMultipartUpload("out/clip.mp4", mp.uploadId).complete([p1, p2]);
  out.push(["multipart", done.size, await new Response((await files.get("out/clip.mp4"))!.body).text()]);
  const mp2 = await files.createMultipartUpload("out/gone.mp4");
  await files.resumeMultipartUpload("out/gone.mp4", mp2.uploadId).abort();
  out.push(["aborted", await files.head("out/gone.mp4")]);
  const page1 = await files.list({ limit: 2 });
  const page2 = await files.list({ limit: 2, cursor: page1.truncated ? page1.cursor : undefined });
  out.push(["list", page1.objects.map((o) => [o.key, o.size]), page1.truncated, page2.objects.map((o) => o.key), page2.truncated]);
  await files.delete(["raw/d1/a b.mov", "brain/doc"]);
  await files.delete("not-there");
  out.push(["after delete", (await files.list()).objects.map((o) => o.key)]);
  return out;
}

describe("Files on another Cloudflare account (S3)", () => {
  it("behaves like the R2 binding for every step the Worker uses", async () => {
    const r2 = await scenario(memoryR2().FILES);
    const s3 = fakeS3();
    const viaS3 = await scenario(new S3Files(cfg, s3.fetcher) as unknown as R2Bucket);
    expect(viaS3).toEqual(r2);
    // It really went over S3, signed, never hashing a payload in the Worker.
    expect(s3.seen.length).toBeGreaterThan(10);
    expect(s3.seen.every((r) => r.headers.get("x-amz-content-sha256") === "UNSIGNED-PAYLOAD")).toBe(true);
    expect(s3.seen.every((r) => r.url.startsWith("https://acct.r2.cloudflarestorage.com/her-bucket"))).toBe(true);
  });

  it("a refused write is an error, never a silent success", async () => {
    const files = new S3Files(cfg, fakeS3({ failPut: true }).fetcher) as unknown as R2Bucket;
    await expect(files.put("k", bytes("x"))).rejects.toThrow(/s3 put 500/);
    const bad = new S3Files({ ...cfg, bucket: "someone-elses" }, fakeS3().fetcher) as unknown as R2Bucket;
    await expect(bad.list()).rejects.toThrow(/s3 list 404/);
  });

  it("a download link is signed, time-limited and names the file; the binding gives none", async () => {
    const files = new S3Files(cfg, fakeS3().fetcher) as unknown as R2Bucket;
    const url = new URL((await signedDownload(files, "raw/d1/IMG 1.MOV", 3600, 'IMG "1".MOV'))!);
    expect(url.origin + url.pathname).toBe("https://acct.r2.cloudflarestorage.com/her-bucket/raw/d1/IMG%201.MOV");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toBe('attachment; filename="IMG _1_.MOV"');
    expect(await signedDownload(memoryR2().FILES, "k", 3600)).toBeNull();
  });

  it("is swapped in only when the studio says so, and a half-set studio is a named stop", () => {
    const binding = memoryR2().FILES;
    const base = { FILES: binding } as unknown as Env;
    expect(s3Config(base)).toBeNull();
    expect(filesFor(base)).toBe(binding);
    const full = { ...base, FILES_S3_BUCKET: "her-bucket", FILES_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/", FILES_S3_ACCESS_KEY_ID: "A", FILES_S3_SECRET_ACCESS_KEY: "S" } as Env;
    expect(s3Config(full)).toEqual({ ...cfg, accessKeyId: "A", secretAccessKey: "S" });
    expect(filesFor(full)).toBeInstanceOf(S3Files);
    expect(() => filesFor({ ...full, FILES_S3_SECRET_ACCESS_KEY: "" } as Env)).toThrow(/FILES_S3_SECRETS_MISSING/);
  });
});
