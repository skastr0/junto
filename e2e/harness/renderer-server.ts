/**
 * Node http static server for out/renderer. Unpackaged Electron windowed
 * launches require ELECTRON_RENDERER_URL to load a real origin — the trusted
 * custom renderer protocol only installs when app.isPackaged (see
 * src/main/index.ts:468 and :592) — so e2e serves the built renderer over
 * plain 127.0.0.1 http with correct MIME types instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

export interface RendererServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const startRendererServer = async (rendererDir: string): Promise<RendererServer> => {
  const root = normalize(rendererDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
        let pathname = decodeURIComponent(parsed.pathname);
        if (pathname === "/__vellum_redirect") {
          res.writeHead(302, { location: "/" }).end();
          return;
        }
        if (pathname === "/__vellum_stall") {
          // Intentionally leave the main-document response pending. The app's
          // bounded renderer-load watchdog must terminate the black window.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return;
        }
        if (pathname === "/__vellum_blank") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<!doctype html><meta charset=utf-8><title>blank renderer fixture</title>");
          return;
        }
        if (pathname === "/" || pathname === "") pathname = "/index.html";
        const resolved = normalize(join(root, pathname));
        if (!resolved.startsWith(root)) {
          res.writeHead(403).end();
          return;
        }
        const info = await stat(resolved).catch(() => undefined);
        // SPA fallback: unknown/nested paths resolve to index.html so a
        // deep client route still boots the app shell.
        const filePath = !info || info.isDirectory() ? join(root, "index.html") : resolved;
        const body = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
