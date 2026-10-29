import { createPackage } from "@electron/asar";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditRendererAssetTypes } from "../scripts/audit-packaged-app";
import { createTrustedRendererHandler, trustedRendererMimeType } from "../src/main/junto/trusted-renderer-protocol";

/**
 * The packaged app serves its renderer through `junto-app:`, which refuses a
 * file kind it has no type for; dev serves the same files through Vite. A
 * kind the protocol refuses works from source and fails only when packaged:
 * 0.11.0 shipped the pdf.js worker as `.mjs`, got 415 for it, and no PDF opened.
 */

const sourceFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return Promise.resolve(/\.tsx?$/u.test(entry.name) ? [full] : []);
    }),
  );
  return nested.flat();
};

describe("renderer asset types under the packaged protocol", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-renderer-assets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the pdf.js worker module as JavaScript", async () => {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/pdf.worker.min-CjEcRF4W.mjs"), "export {};");
    const handler = await createTrustedRendererHandler(root);
    const worker = await handler(new Request("junto-app://renderer/assets/pdf.worker.min-CjEcRF4W.mjs"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("has a served type for every file the renderer imports by URL", async () => {
    const imports: string[] = [];
    for (const file of await sourceFiles(join(__dirname, "../src/renderer"))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/["']([^"']+)\?url["']/gu)) imports.push(match[1] ?? "");
    }
    expect(imports).toContain("pdfjs-dist/build/pdf.worker.min.mjs");
    expect(imports.filter((specifier) => trustedRendererMimeType(specifier) === undefined)).toEqual([]);
  });

  it("passes a packaged renderer whose every file is served", async () => {
    const stage = join(root, "stage");
    await mkdir(join(stage, "out/renderer/assets"), { recursive: true });
    await writeFile(join(stage, "out/renderer/index.html"), "<!doctype html>");
    await writeFile(join(stage, "out/renderer/assets/app.js"), "export {};");
    await writeFile(join(stage, "out/renderer/assets/pdf.worker.min-CjEcRF4W.mjs"), "export {};");
    await writeFile(join(stage, "out/renderer/assets/app.css"), "body {}");
    await mkdir(join(stage, "out/main"), { recursive: true });
    await writeFile(join(stage, "out/main/index.cjs"), "");
    const archive = join(root, "app.asar");
    await createPackage(stage, archive);
    expect(auditRendererAssetTypes(archive)).toBe(4);
  });

  it("fails a packaged renderer holding a file the protocol would refuse, by name", async () => {
    const stage = join(root, "stage");
    await mkdir(join(stage, "out/renderer/assets"), { recursive: true });
    await writeFile(join(stage, "out/renderer/index.html"), "<!doctype html>");
    await writeFile(join(stage, "out/renderer/assets/engine.wasm"), "");
    const archive = join(root, "app.asar");
    await createPackage(stage, archive);
    expect(() => auditRendererAssetTypes(archive)).toThrow(/out\/renderer\/assets\/engine\.wasm/u);
  });

  it("fails an archive with no renderer at all", async () => {
    const stage = join(root, "stage");
    await mkdir(join(stage, "out/main"), { recursive: true });
    await writeFile(join(stage, "out/main/index.cjs"), "");
    const archive = join(root, "app.asar");
    await createPackage(stage, archive);
    expect(() => auditRendererAssetTypes(archive)).toThrow(/no renderer files/u);
  });
});
