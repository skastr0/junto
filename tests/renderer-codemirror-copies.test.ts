import { createPackage } from "@electron/asar";
import { finished } from "node:stream/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditRendererCodeMirrorCopies,
  CODEMIRROR_COPY_MARKERS,
  duplicateCodeMirrorPackages,
} from "../scripts/audit-packaged-app";

/**
 * CodeMirror checks its own classes with `instanceof`, so a renderer that
 * bundles a second copy of @codemirror/state, view or language breaks every
 * editor while dev (one resolved copy) works. The audit tells a copy by error
 * strings every copy keeps, and fails a package that carries any of them twice.
 */

const copyOf = (pkg: keyof typeof CODEMIRROR_COPY_MARKERS): string =>
  CODEMIRROR_COPY_MARKERS[pkg].map((marker) => `throw new Error(${JSON.stringify(marker)});`).join("\n");

describe("the package audit refuses a second copy of a CodeMirror core package", () => {
  let root = "";
  const pack = async (files: Record<string, string>): Promise<string> => {
    const stage = join(root, "stage");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(stage, path, ".."), { recursive: true });
      await writeFile(join(stage, path), text);
    }
    const archive = join(root, "app.asar");
    await finished(await createPackage(stage, archive));
    return archive;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-codemirror-copies-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes a renderer holding one copy of each package, split across chunks", async () => {
    const archive = await pack({
      "out/renderer/assets/state.js": copyOf("@codemirror/state"),
      "out/renderer/assets/view.js": copyOf("@codemirror/view"),
      "out/renderer/assets/language.js": copyOf("@codemirror/language"),
      "out/main/index.js": `${copyOf("@codemirror/state")}\n${copyOf("@codemirror/state")}`,
    });
    expect(auditRendererCodeMirrorCopies(archive)).toBe(3);
  });

  it("passes a renderer that bundles none of them", async () => {
    const archive = await pack({ "out/renderer/assets/app.js": "export {};\n" });
    expect(auditRendererCodeMirrorCopies(archive)).toBe(1);
  });

  for (const pkg of Object.keys(CODEMIRROR_COPY_MARKERS) as Array<keyof typeof CODEMIRROR_COPY_MARKERS>) {
    it(`fails a second copy of ${pkg} in another chunk, naming the package and both files`, async () => {
      const archive = await pack({
        "out/renderer/assets/index-A.js": copyOf(pkg),
        "out/renderer/assets/editor-B.js": copyOf(pkg),
      });
      let message = "";
      try { auditRendererCodeMirrorCopies(archive); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).toContain(`${pkg} (2 copies, in `);
      expect(message).toContain("/out/renderer/assets/index-A.js");
      expect(message).toContain("/out/renderer/assets/editor-B.js");
    });
  }

  it("fails a second copy bundled into the same chunk", async () => {
    const archive = await pack({ "out/renderer/assets/index.js": `${copyOf("@codemirror/view")}\n${copyOf("@codemirror/view")}` });
    expect(() => auditRendererCodeMirrorCopies(archive)).toThrow(/@codemirror\/view \(2 copies/u);
  });

  it("fails on one surviving marker, since tree-shaking keeps different parts of each copy", () => {
    const [first, second] = CODEMIRROR_COPY_MARKERS["@codemirror/state"];
    const found = duplicateCodeMirrorPackages(new Map([["a.js", `"${first}"`], ["b.js", `"${first}" "${second}"`]]));
    expect(found).toEqual([{ pkg: "@codemirror/state", copies: 2, files: ["a.js", "b.js"] }]);
  });

  it("names every duplicated package at once", async () => {
    const archive = await pack({
      "out/renderer/assets/a.js": `${copyOf("@codemirror/state")}\n${copyOf("@codemirror/language")}`,
      "out/renderer/assets/b.js": `${copyOf("@codemirror/state")}\n${copyOf("@codemirror/language")}`,
    });
    expect(() => auditRendererCodeMirrorCopies(archive)).toThrow(/@codemirror\/state.*@codemirror\/language/u);
  });

  it("fails an archive with no renderer scripts", async () => {
    const archive = await pack({ "out/main/index.js": "export {};\n" });
    expect(() => auditRendererCodeMirrorCopies(archive)).toThrow(/no renderer scripts/u);
  });

  it("keys on strings the installed packages really carry, once each", async () => {
    for (const [pkg, markers] of Object.entries(CODEMIRROR_COPY_MARKERS)) {
      const name = pkg.split("/")[1];
      const source = await readFile(join(__dirname, `../node_modules/@codemirror/${name}/dist/index.js`), "utf8");
      for (const marker of markers) {
        expect(source.split(marker).length - 1, `${pkg}: ${marker}`).toBe(1);
      }
    }
  });
});
