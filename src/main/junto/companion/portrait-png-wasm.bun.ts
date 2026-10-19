/**
 * resvg's wasm under Bun. `bun build --compile` embeds the file and this path
 * points into the binary; run from source it is the file in node_modules.
 * Only portrait-png.ts loads this module, and only under Bun: Electron's main
 * reads the wasm from the packaged node_modules instead.
 */

// @ts-expect-error Bun's file import has no type declaration; its default export is the file's path.
import wasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };

export default wasmPath as string;
