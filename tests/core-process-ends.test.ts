import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * Each link between main and the core has two ends, one per process, and a
 * protocol module they share that holds no state. No module switches what it
 * does by which process loaded it, and no end falls back to a default: each
 * core boot (the app's core entry and the windowless core) chooses its own.
 */
const read = (path: string): string => readFileSync(path, "utf8");
const ENTRY = read("src/main/core-process/entry.ts");
const HEADLESS = read("src/main/headless.ts");

/** A module that holds nothing: no `let`, no module-level map or set. */
const holdsNoState = (source: string): boolean =>
  !/^let /mu.test(source) && !/^const \w+ = new (Map|Set|WeakMap)/mu.test(source);

it("pushes: the core publishes, main subscribes, and each core boot chooses the sink", () => {
  expect(ENTRY).toContain("sendPushesTo(served.push)");
  expect(HEADLESS).toContain("sendPushesTo(() => {})");
  expect(read("src/main/core-process/push.ts")).not.toMatch(/subscribe|listeners/u);
  expect(read("src/main/core-process/main-side/core-pushes.ts")).not.toMatch(/\bpublish\b|sendPushesTo/u);
  expect(holdsNoState(read("src/main/core-process/channels.ts"))).toBe(true);
});

it("host operations: main runs the bodies, the core holds the client, the protocol holds nothing", () => {
  expect(ENTRY).toContain("useHostClient(served.host)");
  expect(HEADLESS).toContain("useHostClient(noWindowHost)");
  const protocol = read("src/main/core-process/host-ops.ts");
  expect(holdsNoState(protocol)).toBe(true);
  expect(protocol).not.toMatch(/export const/u);
  expect(read("src/main/core-process/core-host.ts")).not.toMatch(/from "[^"]*host-op-bodies"|\bhostOps\(|runHostOp/u);
  expect(read("src/main/core-process/main-side/host-op-bodies.ts")).not.toMatch(/useHostClient|\bhost\.call/u);
  // The port answers host calls with what its owner hands it, never a registry of its own.
  expect(read("src/main/core-process/port.ts")).not.toMatch(/from "[^"]*host-op-bodies"|runHostOp/u);
});

it("terminals: each core boot chooses where its PTYs run, and nothing infers it from the process", () => {
  // The desktop core hands startCore its parent port; the windowless core hands nothing and runs them here.
  expect(ENTRY).toContain("windowTerminals: { parent }");
  expect(HEADLESS).not.toContain("windowTerminals");
  const core = read("src/main/junto/core.ts");
  expect(core).toContain('else placeTerminals({ kind: "here" })');
  expect(core).not.toMatch(/\(process as unknown as \{ parentPort/u);
  expect(read("src/main/terminal-process/use.ts")).not.toMatch(/process\.type|parentPort/u);
});

it("core reads: only the core holds them, installed by startCore; main asks its own client", () => {
  expect(read("src/main/core-process/main-client.ts")).not.toMatch(/installCoreReads|core-runner/u);
  expect(read("src/main/junto/browser/composition.ts")).not.toMatch(/core-runner/u);
  const runner = read("src/main/core-runner.ts");
  // No pre-boot default: a read before startCore throws, a spawn's included.
  expect(runner).not.toMatch(/floorSpawnEnv|coreNotRunning/u);
  expect(read("src/main/junto/core.ts")).toContain("installInProcessCoreReads");
});

it("log rows: one destination per process, chosen by its boot; loading the ring installs nothing", () => {
  expect(ENTRY).toContain("sendLogRowsTo((row) => observabilityRing.append(row))");
  expect(HEADLESS).toContain("sendLogRowsTo((row) => observabilityRing.append(row))");
  expect(read("src/main/junto/observability/ipc.ts")).toContain("sendLogRowsTo((entry) =>");
  const logger = read("src/main/junto/observability/logger.ts");
  expect(logger).not.toMatch(/setObservabilityForwarder|setLogRowSink|rowSink/u);
  expect(read("src/main/junto/observability/ring.ts")).not.toMatch(/sendLogRowsTo|setLogRowSink/u);
});
