// Desktop sidebar + phone bottom tab bar (section 4). Badges: Review count, Deals follow-ups,
// Every screen is always in the menu: nothing is hidden behind a Settings switch (owner, 26 Sep
// 2026; validator nothing-hidden).
// Phone: Home · Dump · Review · Calendar in the bar (the daily four, per the wireframes) and a
// Menu tab that opens a sheet with every other screen, so nothing is desktop-only. The help
// guides say "tap X in the menu"; the tab is called Menu so that sentence is true on a phone.
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useApp } from "../state";
import { Icon, type IconName } from "./Icon";
import { Tour } from "./Tour";
import { Wordmark } from "./Wordmark";
import { PracticeBanner } from "./PracticeBanner";
import { studio } from "../lib/studio";
import { post } from "../lib/api";

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: (s: ShellCounts) => string | number | undefined;
  group: "daily" | "business" | "setup";
}

const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: "home", group: "daily" },
  { to: "/dump", label: "Dump", icon: "dump", group: "daily" },
  { to: "/review", label: "Review", icon: "review", badge: (s) => s.reviewCount || undefined, group: "daily" },
  { to: "/calendar", label: "Calendar", icon: "calendar", group: "daily" },
  { to: "/deals", label: "Deals", icon: "deals", badge: (s) => s.followups || undefined, group: "business" },
  { to: "/brain", label: "Client Brain", icon: "brain", group: "business" },
  { to: "/research", label: "Research", icon: "research", group: "business" },
  { to: "/stats", label: "Stats", icon: "stats", group: "business" },
  { to: "/voice", label: "Voice overs", icon: "voice", group: "business" },
  { to: "/setup", label: "Setup", icon: "check", group: "setup" },
  { to: "/settings", label: "Settings", icon: "settings", group: "setup" },
  { to: "/help", label: "Help", icon: "help", group: "setup" },
];

const TABS = ["/", "/dump", "/review", "/calendar"];

export interface ShellCounts {
  reviewCount: number;
  followups: number;
}

/** Privacy and Terms (public pages served by the Worker, worker/routes/legal.ts), in the footer of
 *  every screen: the desktop sidebar's foot, the phone Menu sheet, the login card. Plain links, not
 *  router links: the pages are not part of the app. Validator legal-pages checks all three. */
export function LegalLinks() {
  return (
    <footer className="legal-links" aria-label="Privacy and terms">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </footer>
  );
}

/**
 * Log out of this device: ends the session (POST /api/auth/logout) and reloads to the login card.
 * In the sidebar foot and the phone Menu sheet, so every screen has it (until 7 Oct 2026 the route
 * existed and nothing in the app called it: found live on sample1).
 */
export function LogOutButton() {
  const [busy, setBusy] = useState(false);
  async function logOut() {
    setBusy(true);
    try {
      await post("/api/auth/logout");
    } catch {
      // The session cookie is cleared server-side when it can be; the reload shows where we stand.
    }
    window.location.assign("/");
  }
  return (
    <button type="button" className="log-out" onClick={logOut} disabled={busy}>
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}

export function Shell() {
  const { me, counts, health } = useApp();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = NAV;
  const allOk = health.every((h) => h.light === "green" || h.light === "grey");
  const badge = (n: NavItem) => n.badge?.(counts);
  const menuItems = items.filter((n) => !TABS.includes(n.to));
  const menuBadge = menuItems.reduce((sum, n) => sum + (Number(badge(n)) || 0), 0);
  const inMenu = menuItems.some((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)));

  // The sheet closes on navigation and on Escape.
  useEffect(() => setMenuOpen(false), [loc.pathname, loc.search]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" ? setMenuOpen(false) : undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const link = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} end={n.to === "/"}>
      <Icon name={n.icon} />
      {n.label}
      {badge(n) ? (
        <span className="badge" aria-label={`${badge(n)} waiting`}>
          {badge(n)}
        </span>
      ) : null}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label={`${studio().appName} home`}>
          <Wordmark />
        </NavLink>
        <nav className="nav" aria-label="Main">
          {items.filter((n) => n.group === "daily").map(link)}
          <hr className="nav-rule" />
          {items.filter((n) => n.group === "business").map(link)}
          <hr className="nav-rule" />
          {items.filter((n) => n.group === "setup").map(link)}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/settings" className="row">
            <span className={`dot ${allOk ? "green" : "yellow"}`} aria-hidden="true" />
            {allOk ? "All systems OK" : "Something needs you"}
          </NavLink>
          <div className="who" title={me?.email}>
            {me?.email}
          </div>
          <LogOutButton />
          <LegalLinks />
        </div>
      </aside>
      <main className="main" id="main">
        <PracticeBanner />
        <Outlet />
        <Tour />
      </main>
      {menuOpen ? <button type="button" className="more-back" aria-label="Close the menu" onClick={() => setMenuOpen(false)} /> : null}
      <div className="more-sheet" id="more-sheet" hidden={!menuOpen}>
        <nav aria-label="More screens">{menuItems.map(link)}</nav>
        <LogOutButton />
        <LegalLinks />
      </div>
      <nav className="tabbar" aria-label="Main">
        {items.filter((n) => TABS.includes(n.to)).map(link)}
        <button type="button" data-menu className={inMenu ? "active" : ""} aria-expanded={menuOpen} aria-controls="more-sheet" onClick={() => setMenuOpen((v) => !v)}>
          <Icon name={menuOpen ? "close" : "more"} />
          Menu
          {menuBadge ? (
            <span className="badge" aria-label={`${menuBadge} waiting`}>
              {menuBadge}
            </span>
          ) : null}
        </button>
      </nav>
    </div>
  );
}
