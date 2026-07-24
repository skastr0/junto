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
    const streamCode = streamSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(streamSrc).toMatch(/terminal\.release/);
    expect(streamSrc).toMatch(/detachAllOnQuit/);
    expect(streamSrc).toMatch(/NEVER runs `pane close`|never pane close/i);
    // Only the central factory binds local termination authority; the stream
    // manager receives no pid, raw child kill, admit, signal, or release API.
    expect(streamSrc).toMatch(/spawned\.kind === "local-process"[\s\S]*?terminate:\s*spawned\.terminate[\s\S]*?forceTerminate:\s*spawned\.forceTerminate/);
    expect(streamSrc).toMatch(/lifecycle\.terminate\("herdr-control-detach"\)/);
    expect(streamSrc).toMatch(/lifecycle\.forceTerminate\("herdr-control-grace-expired"\)/);
    expect(streamSrc).toMatch(/lifecycle\.kind === "remote-scope"[\s\S]*?trackRemoteClose\(lifecycle\)/);
    expect(streamSrc).not.toMatch(/spawnDetachedProcessGroup|admitSpawnedProcess|admitChildProcess|signalOwned|releaseOwned|signalChildHandleOnly/);
    expect(streamCode).not.toMatch(/process\.kill|\.child\.kill\s*\(|\bpid\b/);
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
    // The canonical terminal.release protocol constructor (shared/terminal-session-domain)
    // replaced the inline `{ type: "terminal.release" }` literal; check the call site.
    expect(detachBlock).toMatch(/herdrRelease\(\)/);
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
    const end = streamSrc.indexOf("\n  private writeCommand(", start);
    const terminationBlock = streamSrc.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(terminationBlock).toMatch(/lifecycle\.kind === "remote-scope"[\s\S]*?trackRemoteClose\(lifecycle\)/);
    expect(terminationBlock).toMatch(/lifecycle\.terminate\("herdr-control-detach"\)/);
    expect(terminationBlock).toMatch(/setTimeout/);
    expect(terminationBlock).toMatch(/lifecycle\.forceTerminate\("herdr-control-grace-expired"\)/);
    expect(terminationBlock).not.toMatch(/process\.kill|\bpid\b|spawnDetachedProcessGroup|signalOwned|releaseOwned/);
  });

  it("does not treat generic control or observe errors as proof of exit", () => {
    const controlStart = streamSrc.indexOf('child.on("error"');
    const controlEnd = streamSrc.indexOf("\n\n    return { ok: true", controlStart);
    const controlErrorBlock = streamSrc.slice(controlStart, controlEnd);
    expect(controlStart).toBeGreaterThan(-1);
    expect(controlEnd).toBeGreaterThan(controlStart);
    expect(controlErrorBlock).toMatch(/terminateControl\(active\)/);
    expect(controlErrorBlock).not.toMatch(/settleLocalControl|releaseOwned/);

    // Observe error path retires the generation without treating pipe errors
    // as a clean local exit. Bound to the retireGeneration helper only.
    const observeStart = observeSrc.indexOf("const retireGeneration");
    const observeEnd = observeSrc.indexOf(
      "child.stdout.on(\"error\", retireGeneration)",
      observeStart,
    );
    const observeErrorBlock = observeSrc.slice(observeStart, observeEnd);
    expect(observeStart).toBeGreaterThan(-1);
    expect(observeEnd).toBeGreaterThan(observeStart);
    expect(observeErrorBlock).toMatch(/terminateGeneration\(generation\)/);
    expect(observeErrorBlock).not.toMatch(/settleLocalGeneration|releaseOwned/);
    expect(observeSrc).toMatch(
      /child\.stdout\.on\("error",\s*retireGeneration\)/,
    );
    expect(observeSrc).toMatch(
      /child\.on\("error",\s*retireGeneration\)/,
    );
  });

  it("main process detaches herdr on quit and signals", () => {
    expect(indexSrc).toMatch(/herdrPlaneService\?\.beginShutdown\(\)|requireCleanHerdrShutdown/);
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
    expect(planeSrc).toMatch(/appProcessPlane\.spawnOutlivingDaemon/);
    expect(planeSrc).toMatch(/proveHerdrProtocolReadyAfterOsHandoff\([\s\S]*?osHandoff\.readiness[\s\S]*?runOwned\(awaitServer/);
    expect(planeSrc).toMatch(/return protocolReady/);
    expect(planeSrc).toMatch(/appProcessPlane\.spawnChild/);
    expect(planeSrc).not.toMatch(/from "node:child_process"|\bspawn\(/);
    const localFactoryStart = planeSrc.indexOf("const spawnHerdr:");
    const localFactoryEnd = planeSrc.indexOf("\n\n    const observePool", localFactoryStart);
    const localFactory = planeSrc.slice(localFactoryStart, localFactoryEnd);
    expect(localFactoryStart).toBeGreaterThan(-1);
    expect(localFactoryEnd).toBeGreaterThan(localFactoryStart);
    expect(localFactory).toMatch(/appProcessPlane\.spawnChild/);
    expect(localFactory).toMatch(/appProcessPlane\.terminate\(process, reason\)/);
    expect(localFactory).toMatch(/appProcessPlane\.forceTerminate\(process, reason\)/);
    expect(localFactory).not.toMatch(/\bpid\b|\.kill\s*\(|admitChildProcess|signalOwned|releaseOwned/);
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
    expect(remoteClientBlock).toMatch(/Scope\.make\(ExecutionStrategy\.sequential\)/);
    expect(remoteClientBlock).not.toMatch(/Scope\.fork\(/);
    expect(remoteClientBlock).not.toMatch(/\bkill\s*\(|\bpid\b|OwnedProcess|signalOwned/);
    expect(planeSrc).not.toMatch(/Scope\.fork\(/);
    expect(planeSrc).toMatch(/warm:\s*warmPart/);
    expect(planeSrc).toMatch(/warmPart\.run\(\(\) =>[\s\S]*?transport\.warm/);
  });
});
