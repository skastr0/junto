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
  const observeSrc = readFileSync(join(root, "src/main/vellum/herdr/observe-pool.ts"), "utf8");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const serviceSrc = readFileSync(join(root, "src/main/vellum/herdr/service.ts"), "utf8");
  const planeSrc = readFileSync(join(root, "src/main/vellum/herdr/plane.ts"), "utf8");

  it("stream manager documents detach-only and implements terminal.release", () => {
    expect(streamSrc).toMatch(/terminal\.release/);
    expect(streamSrc).toMatch(/detachAllOnQuit/);
    expect(streamSrc).toMatch(/NEVER runs `pane close`|never pane close/i);
    // Only the tagged local child is admitted as a session-owned process
    // capability. Remote streams retain an Effect-scope closer instead.
    expect(streamSrc).toMatch(/spawned\.kind === "local-process"[\s\S]*?admitChildProcess\(\{[\s\S]*?source:\s*"herdr-control:session-owned"[\s\S]*?child/);
    expect(streamSrc).toMatch(/signalOwned\(lifecycle\.ownedProcess,\s*"SIGTERM"\)/);
    expect(streamSrc).toMatch(/signalOwned\(lifecycle\.ownedProcess,\s*"SIGKILL"\)/);
    expect(streamSrc).toMatch(/lifecycle\.kind === "remote-scope"[\s\S]*?trackRemoteClose\(lifecycle\.close\)/);
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
    // Only the admitted control-client capability is handed to the bounded
    // teardown state machine; detach itself has no pid/group or raw kill.
    expect(detachBlock).toMatch(/this\.terminateControl\(active\)/);
    expect(detachBlock).not.toMatch(/signalOwned|releaseOwned/);
    expect(detachBlock).not.toMatch(/\.kill\s*\(|\bpid\b|spawnDetachedProcessGroup/);
  });

  it("keeps exact child authority through TERM grace and bounded KILL escalation", () => {
    const start = streamSrc.indexOf("private terminateControl(");
    const end = streamSrc.indexOf("\n  private writeJson(", start);
    const terminationBlock = streamSrc.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(terminationBlock).toMatch(/lifecycle\.kind === "remote-scope"[\s\S]*?trackRemoteClose\(lifecycle\.close\)/);
    expect(terminationBlock).toMatch(/signalOwned\(lifecycle\.ownedProcess,\s*"SIGTERM"\)/);
    expect(terminationBlock).toMatch(/setTimeout/);
    expect(terminationBlock).toMatch(/signalOwned\(lifecycle\.ownedProcess,\s*"SIGKILL"\)/);
    expect(terminationBlock).toMatch(/releaseControlAuthority\(stream\)/);
    expect(terminationBlock).not.toMatch(/process\.kill|\bpid\b|spawnDetachedProcessGroup/);
  });

  it("does not treat generic control or observe errors as proof of exit", () => {
    const controlStart = streamSrc.indexOf('child.on("error"');
    const controlEnd = streamSrc.indexOf("\n\n    return { ok: true", controlStart);
    const controlErrorBlock = streamSrc.slice(controlStart, controlEnd);
    expect(controlStart).toBeGreaterThan(-1);
    expect(controlEnd).toBeGreaterThan(controlStart);
    expect(controlErrorBlock).toMatch(/terminateControl\(active\)/);
    expect(controlErrorBlock).not.toMatch(/releaseControlAuthority|releaseOwned/);

    const observeStart = observeSrc.indexOf("const onError =");
    const observeEnd = observeSrc.indexOf('child.on("close"', observeStart);
    const observeErrorBlock = observeSrc.slice(observeStart, observeEnd);
    expect(observeStart).toBeGreaterThan(-1);
    expect(observeEnd).toBeGreaterThan(observeStart);
    expect(observeErrorBlock).toMatch(/terminateGeneration\(generation\)/);
    expect(observeErrorBlock).not.toMatch(/releaseGeneration|releaseOwned/);
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
    const remoteClientStart = planeSrc.indexOf("class EffectHerdrScopeClient");
    const remoteClientEnd = planeSrc.indexOf("\nexport class HerdrPlane", remoteClientStart);
    const remoteClientBlock = planeSrc
      .slice(remoteClientStart, remoteClientEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(remoteClientStart).toBeGreaterThan(-1);
    expect(remoteClientBlock).toMatch(/makeBoundedRemoteClose/);
    expect(remoteClientBlock).not.toMatch(/\bkill\s*\(|\bpid\b|OwnedProcess|signalOwned/);
  });
});
