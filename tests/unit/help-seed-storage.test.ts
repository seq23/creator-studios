// The help pictures' storage numbers are the studio's own (PR #115, F1). The help screenshots run on the
// local studio, which is on the host's shared storage (no HOST_STORAGE_GB: the largest share, 1.5 GB;
// worker/domain/tidy.ts hostCapBytes). Its demo data (tests/e2e/seed-demo.sql, seed-help-extra.sql) and
// the health board it pictures (seed-help-lights.sql) must fit that share and say what the studio itself
// would say: a seed sized for her own 10 GB once showed "8.1 GB of 10 GB used" and a meter at
// "Full · 4.5 GB of 1.5 GB" to every studio owner reading the storage guides.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "@worker/env";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { storageHealth } from "@worker/lib/storage";
import { hostCapBytes, STORAGE } from "@worker/domain/tidy";
import { gbWords } from "@shared/bytes";

const seed = (f: string) => readFileSync(path.resolve(__dirname, "../e2e", f), "utf8");

describe("help seed storage fits the studio's share", () => {
  it("the demo files fit the 1.5 GB share (yellow, as the guides show), and the pictured Storage light is the one the studio writes", async () => {
    const db = sqliteD1();
    for (const f of ["seed-demo.sql", "seed-help-extra.sql", "seed-help-lights.sql"]) db.raw.exec(seed(f));
    const env = { DB: db.DB } as unknown as Env; // the local studio: no own storage, no HOST_STORAGE_GB
    const pictured = db.raw.prepare("SELECT light, note, fix_guide FROM health WHERE name = 'Storage'").get() as { light: string; note: string; fix_guide: string | null };
    expect(pictured).toBeTruthy();

    const r = await storageHealth(env);
    expect(r.place).toBe("host");
    expect(r.limit_bytes).toBe(hostCapBytes({}));
    expect(r.limit_bytes).toBe(1.5 * 1024 ** 3);
    // inside the share, and in the yellow band the storage-almost-full guide pictures
    expect(r.used_bytes).toBeGreaterThanOrEqual(r.limit_bytes * STORAGE.yellowAt);
    expect(r.used_bytes).toBeLessThan(r.limit_bytes * STORAGE.redAt);
    // the pictured light is exactly what the studio writes for this data: same light, same numbers
    const written = db.raw.prepare("SELECT light, note, fix_guide FROM health WHERE name = 'Storage'").get() as { light: string; note: string; fix_guide: string | null };
    expect(pictured).toEqual(written);
    expect(pictured.note.startsWith(`${gbWords(r.used_bytes)} of 1.5 GB shared storage used`)).toBe(true);
    // no help seed speaks of her own storage's 10 GB as this studio's ceiling
    for (const f of ["seed-demo.sql", "seed-help-extra.sql", "seed-help-lights.sql"]) expect(seed(f), f).not.toMatch(/of 10 GB/);
  });
});
