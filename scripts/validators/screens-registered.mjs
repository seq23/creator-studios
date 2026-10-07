// Every app/pages/*.tsx component is routed in app/App.tsx.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export default async function ({ root }) {
  const dir = path.join(root, "app", "pages");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".tsx"));
  const app = await readFile(path.join(root, "app", "App.tsx"), "utf8");
  const problems = [];
  for (const f of files) {
    const name = f.replace(/\.tsx$/, "");
    if (!new RegExp(`import \\{ ${name} \\} from "\\./pages/${name}"`).test(app)) problems.push(`${f}: not imported in App.tsx`);
    else if (!new RegExp(`element=\\{<${name} />\\}`).test(app)) problems.push(`${f}: imported but has no <Route>`);
  }
  return { items: files.length, problems };
}
