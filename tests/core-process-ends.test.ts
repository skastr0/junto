import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * Each link between main and the core has two ends, one per process, and a
 * protocol module they share that holds no state. No module switches what it
 * does by which process loaded it, and no end falls back to a default: each
 * core boot (the app's core entry and the windowless core) chooses its own.
 */
const read = (path: string): string => readFileSync(path, "utf8");
const ENTRY = read("src/core/entry.ts");
const HEADLESS = read("src/core/headless.ts");

/** A module that holds nothing: no `let`, no module-level map or set. */
const holdsNoState = (source: string): boolean =>
  !/^let /mu.test(source) && !/^const \w+ = new (Map|Set|WeakMap)/mu.test(source);

it("pushes: the core publishes, main subscribes, and each core boot chooses the sink", () => {
  expect(ENTRY).toContain("sendPushesTo(served.push)");
  expect(HEADLESS).toContain("sendPushesTo(() => {})");
  expect(read("src/core/push.ts")).not.toMatch(/subscribe|listeners/u);
  expect(read("src/app/core-process/main-side/core-pushes.ts")).not.toMatch(/\bpublish\b|sendPushesTo/u);
  expect(holdsNoState(read("src/contract/core/channels.ts"))).toBe(true);
});

it("host operations: main runs the bodies, the core holds the client, the protocol holds nothing", () => {
  expect(ENTRY).toContain("useHostClient(served.host)");
  expect(HEADLESS).toContain("useHostClient(noWindowHost)");
  const protocol = read("src/core/host-ops.ts");
  expect(holdsNoState(protocol)).toBe(true);
  expect(protocol).not.toMatch(/export const/u);
  expect(read("src/core/core-host.ts")).not.toMatch(/from "[^"]*host-op-bodies"|\bhostOps\(|runHostOp/u);
  expect(read("src/app/core-process/main-side/host-op-bodies.ts")).not.toMatch(/useHostClient|\bhost\.call/u);
  // The port answers host calls with what its owner hands it, never a registry of its own.
  expect(read("src/contract/core/port.ts")).not.toMatch(/from "[^"]*host-op-bodies"|runHostOp/u);
});

it("terminals: each core boot chooses where its PTYs run, and nothing infers it from the process", () => {
  // The desktop core hands startCore its parent port; the windowless core hands nothing and runs them here.
  expect(ENTRY).toContain("windowTerminals: { parent }");
  expect(HEADLESS).not.toContain("windowTerminals");
  const core = read("src/core/core.ts");
  expect(core).toContain('else placeTerminals({ kind: "here" })');
  expect(core).not.toMatch(/\(process as unknown as \{ parentPort/u);
  expect(read("src/node/terminals/use.ts")).not.toMatch(/process\.type|parentPort/u);
});

it("core reads: only the core holds them, installed by startCore; main asks its own client", () => {
  expect(read("src/app/core-process/main-client.ts")).not.toMatch(/installCoreReads|core-runner/u);
  expect(read("src/app/browser/composition.ts")).not.toMatch(/core-runner/u);
  const runner = read("src/core/core-runner.ts");
  // No pre-boot default: a read before startCore throws, a spawn's included.
  expect(runner).not.toMatch(/floorSpawnEnv|coreNotRunning/u);
  expect(read("src/core/core.ts")).toContain("installInProcessCoreReads");
});

it("log rows: each boot builds its log and hands it its sink; loading the ring installs nothing", () => {
  // The core's two entries build the core's log with the ring as its sink and
  // the registry as its known values; a headless core opens its file and hook.
  for (const source of [ENTRY, HEADLESS]) {
    expect(source).toContain("createLogger({");
    expect(source).toContain("sink: (row) => observabilityRing.append(row)");
    expect(source).toContain("knownSecrets: registeredSecretValues");
  }
  expect(HEADLESS).toContain("log.openFile({ home })");
  expect(HEADLESS).toContain("log.installConsoleHook({ echo: false })");
  // Main builds its own log over the forwarder to the core's ring.
  expect(read("src/app/observability/main-log.ts")).toContain("createLogger({");
  expect(read("src/app/observability/main-log.ts")).toContain('core.call("observability.append"');
  const logger = read("src/node/observability/logger.ts");
  expect(logger).not.toMatch(/sendLogRowsTo|setLogRowSink|rowSink/u);
  expect(logger).not.toMatch(/^let rows/mu);
  expect(read("src/core/observability/ring.ts")).not.toMatch(/sendLogRowsTo|setLogRowSink/u);
});

it("known secrets: the scrub is given its values; no process installs a source", () => {
  const scrub = read("src/node/credentials/scrub.ts");
  expect(scrub).not.toMatch(/installedSecretValues|setKnownSecretValuesSource/u);
  expect(read("src/core/core.ts")).not.toMatch(/setKnownSecretValuesSource/u);
  expect(read("src/core/credentials/known-secrets.ts")).not.toMatch(/setKnownSecretValuesSource/u);
});
