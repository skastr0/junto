import { createPackage } from "@electron/asar";
import { finished } from "node:stream/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditNoSourceMaps } from "../scripts/audit-packaged-app";

/**
 * Source maps are kept as a release archive, never inside the app. The build
 * writes hidden maps and package.json leaves every `.map` out; this audit is the
 * check that fails the package if one slips in anyway.
 */

describe("the package audit refuses source maps inside the app", () => {
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
    root = await mkdtemp(join(tmpdir(), "junto-source-maps-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes an app whose scripts carry no map and no pointer to one", async () => {
    const archive = await pack({
      "out/main/index.js": "export {};\n",
      "out/preload/index.cjs": "module.exports = {};\n",
      "out/renderer/assets/app.js": "export {};\n",
      "package.json": "{}",
    });
    expect(auditNoSourceMaps(archive)).toBe(3);
  });

  it("fails a .map file inside the app, by name", async () => {
    const archive = await pack({ "out/main/index.js": "export {};\n", "out/main/index.js.map": "{}" });
    expect(() => auditNoSourceMaps(archive)).toThrow(/out\/main\/index\.js\.map/u);
  });

  it("fails a script whose tail points at a map, by name", async () => {
    const archive = await pack({ "out/renderer/assets/app.js": "export {};\n//# sourceMappingURL=app.js.map\n" });
    expect(() => auditNoSourceMaps(archive)).toThrow(/out\/renderer\/assets\/app\.js/u);
  });

  it("does not take a mention of the word in the body of a script for a pointer", async () => {
    const filler = "x".repeat(2000);
    const archive = await pack({ "out/main/index.js": `const note = "see sourceMappingURL= in the spec";\n${filler}\n` });
    expect(auditNoSourceMaps(archive)).toBe(1);
  });
});
