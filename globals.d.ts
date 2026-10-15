// Static files are bundled as text modules via the `rules` in wrangler.jsonc
// (type: "Text"), which is the Workers equivalent of the old
// Deno.readTextFile("./index.html") calls. TypeScript can't resolve these
// relative paths to real modules, so the wildcard declarations below type
// each import as a default-exported string.
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const content: string;
  export default content;
}
