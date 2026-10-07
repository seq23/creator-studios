import type { Context } from "hono";
import type { ApiError } from "@shared/types";

/** Error shape every screen understands: a plain sentence plus an optional fix guide slug. */
export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502, error: string, fix_guide?: string) {
  const body: ApiError = fix_guide ? { error, fix_guide } : { error };
  return c.json(body, status);
}

export async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export function isEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}
