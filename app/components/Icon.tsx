// One icon set for the whole app: hand-drawn 24-px line icons, 1.7 stroke, round caps (the
// `.icon` class in global.css). Replaces the mixed Unicode glyphs (⌂ ＋ ▶ ▦ ✦ ◎ ◈ ▲ ♪ ⚙) the
// first build used, which rendered differently on every phone. Decorative by default
// (aria-hidden); the button or link around an icon carries the name.
export type IconName =
  | "home"
  | "dump"
  | "review"
  | "calendar"
  | "deals"
  | "brain"
  | "research"
  | "stats"
  | "voice"
  | "settings"
  | "help"
  | "more"
  | "left"
  | "right"
  | "close"
  | "plus"
  | "check"
  | "arrow"
  | "search"
  | "archive";

const PATHS: Record<IconName, string> = {
  home: "M4 11.5 12 5l8 6.5M6 10v9h4.5v-5h3v5H18v-9",
  dump: "M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14",
  review: "M5 5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5zM10.5 9.5v5l4-2.5z",
  calendar: "M5 7.5A1.5 1.5 0 0 1 6.5 6h11A1.5 1.5 0 0 1 19 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5zM5 10.5h14M9 4v4M15 4v4",
  deals: "M12 4.5l1.9 4.4 4.6.4-3.5 3 1.1 4.6L12 14.5l-4.1 2.4L9 12.3l-3.5-3 4.6-.4z",
  brain: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  research: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.2 15.2 20 20",
  stats: "M5 19.5h14M7.5 16v-4M12 16V7.5M16.5 16v-6",
  voice: "M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  help: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.5-2.2 1.9-2.2 3.2M12 16.6v.1",
  more: "M5 6.5h14M5 12h14M5 17.5h14",
  left: "M14.5 6 8.5 12l6 6",
  right: "M9.5 6l6 6-6 6",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5.5v13M5.5 12h13",
  check: "M5.5 12.5l4 4 9-9",
  arrow: "M5 12h13M13 6.5l5.5 5.5-5.5 5.5",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.2 15.2 20 20",
  archive: "M4.5 5.5h15v3.5h-15zM6 9v9.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V9M10 12.5h4",
};

export function Icon({ name, size, className = "" }: { name: IconName; size?: "sm" | "lg"; className?: string }) {
  return (
    <svg className={`icon${size ? ` ${size}` : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
