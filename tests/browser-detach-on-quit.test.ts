import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static product-lock tests (mirrors detach-on-quit): the quit path must
 * detach browser views only — never destroy sessions or wipe profile
 * partitions. Runtime Electron is not exercised here.
 */
describe("browser detach-on-quit product lock", () => {
  const root = join(import.meta.dirname, "..");

  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const sessionsSrc = readFileSync(join(root, "src/main/vellum/browser/sessions.ts"), "utf8");
  const adapterSrc = readFileSync(join(root, "src/main/vellum/browser/view-adapter.ts"), "utf8");

  it("main process quit path detaches browser sessions", () => {
    expect(indexSrc).toMatch(/beginShutdownAdmission[\s\S]*browserComposition\?\.drainOnQuit/);
    expect(indexSrc).toMatch(/requireCleanBrowserShutdown/);
    // Browser aggregate drain and scoped SSH disposal share the same quit fan-out.
    expect(indexSrc).toMatch(/drainRuntimeOnQuit[\s\S]*requireCleanBrowserShutdown/);
    expect(indexSrc).toMatch(/AppRuntime\.dispose\(\)/);
  });

  it("detachAllOnQuit never destroys sessions or wipes profiles", () => {
    const quitBlock = sessionsSrc
      .slice(sessionsSrc.indexOf("detachAllOnQuit("))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(quitBlock).not.toMatch(/destroy\(\)/);
    expect(quitBlock).not.toMatch(/destroySession/);
    expect(quitBlock).not.toMatch(/wipeProfile/);
    expect(quitBlock).toMatch(/view\.detach\(\)/);
  });

  it("session destroy is warm-pool eviction only and never touches partitions", () => {
    expect(sessionsSrc).toMatch(/private destroySession/);
    const destroyStart = sessionsSrc.indexOf("private destroySession(");
    const destroyEnd = sessionsSrc.indexOf("/** Quit detaches", destroyStart);
    const destroyBlock = sessionsSrc.slice(destroyStart, destroyEnd);
    expect(destroyBlock).not.toMatch(/wipeProfile|clearStorageData|clearCache/);
    // adapter destroy closes the runtime webContents only — no partition APIs
    expect(adapterSrc).toMatch(/webContents\.close\(\)/);
    expect(adapterSrc).not.toMatch(/clearStorageData|clearCache|session\.defaultSession/);
  });

  it("views are partitioned and parented under the window contentView", () => {
    expect(adapterSrc).toMatch(/partition/);
    expect(adapterSrc).toMatch(/contentView\.addChildView/);
    expect(adapterSrc).toMatch(/contentView\.removeChildView/);
    expect(adapterSrc).toMatch(/sandbox:\s*true/);
  });
});
