// The studio this app is, held in memory with no DOM or fetch, so pure modules (the help guides,
// read by unit tests under the Worker types too) can read the name. app/lib/studio.ts loads it.
export interface Studio {
  slug: string;
  appName: string;
  ownerName: string;
  wordmark: { name: string; tag?: string; mark?: string };
  chrome: string | null;
}

let current: Studio = { slug: "", appName: "Studio", ownerName: "", wordmark: { name: "Studio" }, chrome: null };

export const studio = (): Studio => current;
export const setStudio = (s: Studio): void => {
  current = s;
};
