/** Bun's file import of resvg's wasm: its default export is the file's path. */
declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const path: string;
  export default path;
}
