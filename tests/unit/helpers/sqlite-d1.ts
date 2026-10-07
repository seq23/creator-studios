// A D1Database stand-in over Node's built-in SQLite, with every migration applied, so a cron
// lane can be run against the real schema (CHECK constraints included) in a unit test. Covers
// the calls the lanes use: prepare().bind().first/all/run and batch.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Row = Record<string, unknown>;

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  private params() {
    return this.args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a)) as (string | number | null)[];
  }
  async first<T = Row>(col?: string): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...this.params()) as Row | undefined;
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T = Row>() {
    const rows = this.db.prepare(this.sql).all(...this.params()) as Row[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params());
    return { success: true, results: [], meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
}

export function sqliteD1(): { DB: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const dir = path.resolve(__dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  const DB = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { DB: DB as unknown as D1Database, raw };
}
