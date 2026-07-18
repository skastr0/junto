import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static product-lock tests: quit and stream-close paths must never call
 * herdr pane/tab/session kill. Runtime spawn is not exercised here.
 */
describe("herdr detach-on-quit product lock", () => {
  const root = join(import.meta.dirname, "..");

  const streamSrc = readFileSync(join(root, "src/main/vellum/herdr/stream.ts"), "utf8");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const serviceSrc = readFileSync(join(root, "src/main/vellum/herdr/service.ts"), "utf8");
  const planeSrc = readFileSync(join(root, "src/main/vellum/herdr/plane.ts"), "utf8");

  it("stream manager documents detach-only and implements terminal.release", () => {
    expect(streamSrc).toMatch(/terminal\.release/);
    expect(streamSrc).toMatch(/detachAllOnQuit/);
    expect(streamSrc).toMatch(/NEVER runs `pane close`|never pane close/i);
    // control-client kill only
    expect(streamSrc).toMatch(/active\.child\.kill\("SIGTERM"\)/);
  });

  it("stream close path does not shell pane/tab/session kill", () => {
    // Strip comments so doc lines like "never pane close" do not false-fail.
    const detachBlock = streamSrc
      .slice(streamSrc.indexOf("detachControl("), streamSrc.indexOf("detachAllOnQuit"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(detachBlock).not.toMatch(/["']pane["']\s*,\s*["']close["']/);
    expect(detachBlock).not.toMatch(/\bpane\s+close\b/);
    expect(detachBlock).not.toMatch(/\btab\s+close\b/);
    expect(detachBlock).not.toMatch(/\bsession\s+stop\b/);
    expect(detachBlock).not.toMatch(/killPane|killTab/);
    // Only the control client is signalled.
    expect(detachBlock).toMatch(/active\.child\.kill/);
  });

  it("main process detaches herdr on quit and signals", () => {
    expect(indexSrc).toMatch(/detachAllOnQuit|detachHerdrOnQuit/);
    expect(indexSrc).toMatch(/before-quit/);
    expect(indexSrc).toMatch(/will-quit/);
    expect(indexSrc).toMatch(/SIGTERM/);
    // quit handlers must not call killPane
    const quitRegion = indexSrc.slice(indexSrc.indexOf("before-quit"));
    expect(quitRegion).not.toMatch(/killPane|killTab|pane close|session stop/);
  });

  it("killPane/killTab remain explicit while the scoped plane owns server detach", () => {
    expect(serviceSrc).toMatch(/async killPane/);
    expect(serviceSrc).toMatch(/async killTab/);
    expect(planeSrc).toMatch(/detached:\s*true/);
    expect(planeSrc).toMatch(/child\.unref\(\)/);
    expect(planeSrc).toMatch(/transport\.handoffServer/);
    expect(planeSrc).toMatch(/Effect\.addFinalizer/);
  });
});
