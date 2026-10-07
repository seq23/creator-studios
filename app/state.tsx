// App-wide state: who is logged in, sidebar badge counts, health lights. Refreshed on
// navigation and every 60 s so the Review badge and the health dot stay honest.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { HealthItem, HomeSummary, Me } from "@shared/types";
import { ApiFailure, get, setUnauthorizedHandler } from "./lib/api";
import type { ShellCounts } from "./components/Shell";

interface AppState {
  me: Me | null;
  ready: boolean;
  /** /api/me failed for a reason other than "not logged in" (offline, server error). */
  unreachable: boolean;
  counts: ShellCounts;
  health: HealthItem[];
  refreshMe: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  setMe: (m: Me | null) => void;
}

const Ctx = createContext<AppState>({ me: null, ready: false, unreachable: false, counts: { reviewCount: 0, followups: 0 }, health: [], refreshMe: async () => undefined, refreshCounts: async () => undefined, setMe: () => undefined });

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [counts, setCounts] = useState<ShellCounts>({ reviewCount: 0, followups: 0 });
  const [health, setHealth] = useState<HealthItem[]>([]);
  const loc = useLocation();

  // /api/me answers in both auth modes: the owner in open mode (no login), the session's user
  // or a 401 in code mode (the app then shows the login page).
  const refreshMe = useCallback(async () => {
    try {
      setMe(await get<Me>("/api/me"));
      setUnreachable(false);
    } catch (err) {
      setMe(null);
      // Only a 401 means "log in". Anything else (offline, a server error) is a retry, never the
      // login page: in open mode there is no login to show.
      setUnreachable(!(err instanceof ApiFailure && err.status === 401));
    } finally {
      setReady(true);
    }
  }, []);

  const refreshCounts = useCallback(async () => {
    if (!me) return;
    try {
      // Home's lists are capped (day 358); the sidebar's light reads every row.
      const [h, lights] = await Promise.all([get<HomeSummary>("/api/home"), get<HealthItem[]>("/api/settings/health")]);
      setCounts({ reviewCount: h.waiting.clips, followups: h.followups.total });
      setHealth(lights);
    } catch {
      /* the page will show its own error */
    }
  }, [me]);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    refreshCounts();
    const t = setInterval(refreshCounts, 60_000);
    return () => clearInterval(t);
  }, [refreshCounts, loc.pathname]);

  const value = useMemo(() => ({ me, ready, unreachable, counts, health, refreshMe, refreshCounts, setMe }), [me, ready, unreachable, counts, health, refreshMe, refreshCounts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useApp = () => useContext(Ctx);
