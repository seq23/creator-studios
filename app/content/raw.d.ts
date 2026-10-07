// Vite's ?raw import: a text file in the repo, shipped as a string (app/content/*.md).
declare module "*.md?raw" {
  const text: string;
  export default text;
}
