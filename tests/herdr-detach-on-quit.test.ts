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
    // The exact spawned control child is admitted as a session-owned
    // capability. This surface must never acquire pid/group authority.
    expect(streamSrc).toMatch(/admitChildProcess\(\{[\s\S]*?source:\s*"herdr-control:session-owned"[\s\S]*?child/);
    expect(streamSrc).toMatch(/signalOwned\(active\.ownedProcess,\s*"SIGTERM"\)/);
    expect(streamSrc).not.toMatch(/spawnDetachedProcessGroup|admitSpawnedProcess|signalChildHandleOnly/);
    expect(streamSrc).not.toMatch(/process\.kill|\.child\.kill\s*\(/);
  });

  it("stream close path does not shell pane/tab/session kill", () => {
    // Strip comments so doc lines like "never pane close" do not false-fail.
    const detachStart = streamSrc.indexOf("private detachControlInternal(");
    const detachEnd = streamSrc.indexOf("\n  /**\n   * App/launchd shutdown", detachStart);
    const detachBlock = streamSrc
      .slice(detachStart, detachEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(detachStart).toBeGreaterThan(-1);
    expect(detachEnd).toBeGreaterThan(detachStart);
    expect(detachBlock).toMatch(/terminal\.release/);
    expect(detachBlock).not.toMatch(/["']pane["']\s*,\s*["']close["']/);
    expect(detachBlock).not.toMatch(/\bpane\s+close\b/);
    expect(detachBlock).not.toMatch(/\btab\s+close\b/);
    expect(detachBlock).not.toMatch(/\bsession\s+stop\b/);
    expect(detachBlock).not.toMatch(/killPane|killTab/);
    // Only the admitted control-client capability is signalled and retired.
    expect(detachBlock).toMatch(/signalOwned\(active\.ownedProcess,\s*"SIGTERM"\)/);
    expect(detachBlock).toMatch(/releaseOwned\(active\.ownedProcess\)/);
    expect(detachBlock).not.toMatch(/\.kill\s*\(|\bpid\b|spawnDetachedProcessGroup/);
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
    expect(planeSrc).toMatch(/HerdrServerLifetime\s*=\s*"daemon-outlives-app"/);
    expect(planeSrc).toMatch(/serverLifetime:\s*HERDR_SERVER_LIFETIME/);
    expect(planeSrc).toMatch(/transport\.handoffServer/);
    expect(planeSrc).toMatch(/Effect\.addFinalizer/);
  });
});
