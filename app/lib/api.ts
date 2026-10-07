// One tiny fetch wrapper. Every error is an ApiError {error, fix_guide?} the UI can show with
// a "How to fix" link. A 401 sends the app to the login screen.
import type { ApiError } from "@shared/types";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    super(body.error);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
  if (!res.ok) {
    let body: ApiError = { error: `Something went wrong (${res.status}).` };
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* keep default */
    }
    throw new ApiFailure(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });
