// Vite/Vitest's `?raw` suffix inlines a file's text at build time - a
// build-time feature, not a runtime module, so TypeScript needs telling.
declare module "*?raw" {
  const content: string;
  export default content;
}
