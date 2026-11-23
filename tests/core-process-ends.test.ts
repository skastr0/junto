import { existsSync, readFileSync } from "node:fs";
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
  expect(ENTRY).toContain("CorePushes.over(served.push)");
  expect(HEADLESS).toContain("host: HostClientsNoWindow");
  expect(read("src/core/push.ts")).not.toMatch(/sendPushesTo|^let /mu);
  expect(read("src/core/push.ts")).not.toMatch(/subscribe|listeners/u);
  expect(read("src/app/core-process/main-side/core-pushes.ts")).not.toMatch(/\bpublish\b|sendPushesTo/u);
  expect(holdsNoState(read("src/contract/core/channels.ts"))).toBe(true);
});

it("what the core asks of Electron is the host groups: each core boot chooses its clients, and no named operation is left", () => {
  expect(ENTRY).toContain("HostClientsLive.pipe(");
  expect(HEADLESS).toContain("host: HostClientsNoWindow");
  // The port carries pushes and RPC alone: no call, answer, hostCall or hostAnswer message.
  expect(read("src/contract/core/port.ts")).not.toMatch(/"call"|"answer"|"hostCall"|"hostAnswer"/u);
  for (const gone of ["src/core/host-ops.ts", "src/core/core-host.ts", "src/core/ops.ts", "src/app/core-process/main-client.ts", "src/contract/core/client.ts"]) {
    expect(existsSync(gone), gone).toBe(false);
  }
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

it("core reads: only the core holds them, installed by startCore; main asks the core's groups", () => {
  expect(read("src/app/browser/composition.ts")).not.toMatch(/core-runner/u);
  const runner = read("src/core/core-runner.ts");
  // No pre-boot default: a read before startCore throws, a spawn's included.
  expect(runner).not.toMatch(/floorSpawnEnv|coreNotRunning/u);
  expect(read("src/core/core.ts")).toContain("installInProcessCoreReads");
});

it("log rows: each boot builds its log and hands it its sink; loading the ring installs nothing", () => {
  // The core's two entries build the core's log through one helper, with the
  // ring as its sink and the registry as its known values; each opens its file
  // and hook (tests/core-log-file.test.ts), and only the app's core echoes.
  const coreLog = read("src/core/core-log.ts");
  expect(coreLog).toContain("createLogger({");
  expect(coreLog).toContain("sink: (row) => observabilityRing.append(row)");
  expect(coreLog).toContain("knownSecrets: registeredSecretValues");
  expect(coreLog).toContain("log.openFile({ home: options.home })");
  expect(coreLog).toContain("log.installConsoleHook({ echo: options.echo })");
  expect(ENTRY).toContain("openCoreLog({ home: boot.home, echo: true })");
  expect(HEADLESS).toContain("openCoreLog({ home, echo: false })");
  // Main builds its own log over the forwarder to the core's ring: each row
  // waits on its queue until main's client of the core sends it.
  expect(read("src/app/observability/main-log.ts")).toContain("createLogger({");
  expect(read("src/app/observability/main-log.ts")).toContain("Queue.offerUnsafe(mainRows, entry)");
  expect(read("src/app/observability/ipc.ts")).toContain("observability.ObservabilityAppend({ entry })");
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
