// Jobs never touch storage directly. A GitHub Actions job reads its inputs and writes its
// outputs through the Worker (signed GET /api/jobs/:id/input/<key>, signed chunked upload
// /api/jobs/:id/output/*), so no R2 key exists for the owner to mint, paste or leak into a
// public repo's Actions. This fails if any file under jobs/ or .github/workflows/ mentions an
// S3 client, an R2 credential, or an S3 endpoint. Items: every file scanned (zero fails).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const FORBIDDEN = [
  [/boto3?\b|botocore/i, "an S3 client (boto3)"],
  [/R2_ACCESS_KEY/, "an R2 access key"],
  [/R2_SECRET/, "an R2 secret"],
  [/R2_ACCOUNT_ID/, "an R2 account id (only an S3 client needs it)"],
  [/r2\.cloudflarestorage\.com|amazonaws\.com|endpoint_url/i, "an S3 endpoint"],
];

const SKIP_DIRS = new Set(["__pycache__", "work", "node_modules", ".venv"]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(path.join(dir, e.name))));
    } else if (e.isFile() && !/\.(pyc|png|jpg|mp4|tflite)$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** Pure: the problems in one file's text. */
export function directStorageProblems(rel, text) {
  return FORBIDDEN.filter(([re]) => re.test(text)).map(([, label]) => `${rel}: mentions ${label}; jobs reach storage only through the Worker (jobs/common.py download_input / upload_output)`);
}

export default async function ({ root }) {
  const files = [...(await walk(path.join(root, "jobs"))), ...(await walk(path.join(root, ".github", "workflows")))];
  const problems = [];
  for (const f of files) problems.push(...directStorageProblems(path.relative(root, f), await readFile(f, "utf8")));
  if (!files.some((f) => f.endsWith(path.join("jobs", "common.py")))) problems.push("jobs/common.py was not scanned (Rule 0: the guard must reach what it governs)");
  return { items: files.length, problems };
}
