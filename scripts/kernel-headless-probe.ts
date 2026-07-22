#!/usr/bin/env bun
// Deterministic backstop for headless kernel delivery (kernel-design.md §7,
// consumed by the "headless-launchd-verify" batch).
//
// Spawns an ISOLATED instance of the app — its own --user-data-dir (own
// store.json) and its own VELLUM_CANVASES_DIR (canvases.ts's env override,
// added alongside this probe) — so nothing here ever touches the operator's
// real ~/.vellum/canvases or real store.json. Two passes:
//
//   1. ARMED   — pre-seeds store.json's kernel.armed (the "via store" arming
//      path, kernel-design.md §3) for a fixture region, boots the app,
//      boots the app in its explicit no-window mode (the app + kernel keep
//      running with zero windows, exactly the packaged/launchd shape), and
//      waits for a rising-edge TIMER pulse
//      to deliver: a real ChatService.chatOpen + chatPrompt against a local
//      hermes agent, landing a PulseRecord with delivered.length > 0.
//   2. DISARMED — same fixture, armed:false from boot. Asserts the resulting
//      PulseRecord is dry (delivered: [], dry: true) — no agent turn spent.
//
// A TIMER watcher (not a stat_threshold/glyphs_* watcher) is the deterministic
// trigger on purpose: it has no live tower/quasar/booth dependency, so this
// probe isolates exactly the claim it exists to back — headless delivery with
// zero windows — from watcher-edge correctness, which the ported unit tests
// (tests/kernel.test.ts, tests/b2-kernel-edge.test.ts) already cover.
//
// External control surface is file-based (store.json + the canvas file),
// matching AGENTS.md's headless contract — this app exposes no IPC to a
// process outside itself; the explicit headless argv has no control transport.
//
// Exit 0 if both passes hold; exit 2 with a diagnosis otherwise.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProbeSandbox,
  createProbeProcessSupervisor,
  removeProbeSandboxIfClean,
  type ProbeProcessHandle,
  type ProbeSandbox,
} from "./probe-process-supervisor";

// Scripts in this repo are always invoked from the repo root (`bun run
// scripts/...` / `bun scripts/...`), matching every other script here — no
// bun-specific import.meta.dir needed.
const REPO_ROOT = process.cwd();
const ELECTRON_BIN = join(REPO_ROOT, "node_modules", ".bin", "electron");
const MAIN_ENTRY = join(REPO_ROOT, "out", "main", "index.js");

const FIXTURE_CANVAS = "__kernel-probe-fixture__";
const REGION_ID = "probe-region";
const TIMER_NODE_ID = "probe-timer";
const AGENT_NODE_ID = "probe-agent";
// A real local hermes profile (not a fake/stub target) — this is the whole
// point: prove a genuine ChatService.chatOpen + chatPrompt fires headlessly,
// not just that the delivery seam was called.
const AGENT_KEY = "local:default";
const TIMER_EVERY_MINUTES = 0.02; // ~1.2s — fast enough for a probe, still a
// real interval scheduled one period out on first sight (never fires on
// discovery, per the kernel's re-baseline law).

const BOOT_POLL_MS = 500;
const ARMED_DELIVERY_TIMEOUT_MS = 90_000; // headroom for a real model turn
const DRY_PULSE_TIMEOUT_MS = 15_000;
const PROBE_RUNTIME_TIMEOUT_MS = 130_000;
const PROBE_LOG_BYTES = 256 * 1024;
const PROBE_TEMP_PREFIX = join(tmpdir(), "vellum-kernel-probe-");
const probeSupervisor = createProbeProcessSupervisor({ maxLogBytes: PROBE_LOG_BYTES });
const activeSandboxes = new Set<ProbeSandbox>();
let watchdogExitRequested = false;
let mainSucceeded = false;

interface PulseRecordLike {
  readonly kind: string;
  readonly dry: boolean;
  readonly delivered: ReadonlyArray<string>;
  readonly canvasName: string;
  readonly regionId?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fixtureDoc = () => ({
  nodes: [
    {
      id: REGION_ID,
      type: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      label: "probe region",
      ether: { region: { instruction: "[probe] reply with the single word ack" } },
    },
    {
      id: TIMER_NODE_ID,
      type: "text",
      x: 20,
      y: 20,
      width: 200,
      height: 80,
      text: "probe timer",
      ether: { timer: { everyMinutes: TIMER_EVERY_MINUTES } },
    },
    {
      id: AGENT_NODE_ID,
      type: "text",
      x: 20,
      y: 140,
      width: 200,
      height: 80,
      text: "probe agent",
      ether: { entity: { kind: "agent", name: AGENT_KEY } },
    },
  ],
  edges: [],
});

const storePath = (userDataDir: string): string => join(userDataDir, "store.json");

const readStore = async (userDataDir: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await readFile(storePath(userDataDir), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeStore = async (userDataDir: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(storePath(userDataDir), `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

interface Fixture {
  readonly userDataDir: string;
  readonly canvasesDir: string;
}

const setUpFixture = async (armed: boolean): Promise<Fixture> => {
  const sandbox = await createProbeSandbox(PROBE_TEMP_PREFIX);
  activeSandboxes.add(sandbox);
  const root = sandbox.root;
  const userDataDir = join(root, "userData");
  const canvasesDir = join(root, "canvases");
  await mkdir(canvasesDir, { recursive: true });
  await writeFile(join(canvasesDir, `${FIXTURE_CANVAS}.canvas`), JSON.stringify(fixtureDoc(), null, 2), "utf8");
  if (armed) {
    await writeStore(userDataDir, { "kernel.armed": { [`${FIXTURE_CANVAS}::${REGION_ID}`]: true } });
  }
  return { userDataDir, canvasesDir };
};

const spawnApp = (fixture: Fixture): ProbeProcessHandle => {
  const child = probeSupervisor.spawnGroup({
    source: "kernel-headless-probe",
    purpose: "run isolated headless Vellum fixture",
    command: ELECTRON_BIN,
    args: [MAIN_ENTRY, `--user-data-dir=${fixture.userDataDir}`, "--vellum-headless"],
    cwd: REPO_ROOT,
    env: { ...process.env, VELLUM_CANVASES_DIR: fixture.canvasesDir },
  });
  child.onOutput((source, _snapshot, chunk) => {
    const destination = source === "stdout" ? process.stdout : process.stderr;
    destination.write(`[app] ${chunk}`);
  });
  return child;
};

const waitForPulse = async (
  fixture: Fixture,
  predicate: (record: PulseRecordLike) => boolean,
  timeoutMs: number,
): Promise<PulseRecordLike> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (watchdogExitRequested) throw new Error("kernel probe watchdog expired");
    const store = await readStore(fixture.userDataDir);
    const debug = store["kernel.debug"] as { pulseLog?: ReadonlyArray<PulseRecordLike> } | undefined;
    const match = debug?.pulseLog?.find((record) => record.canvasName === FIXTURE_CANVAS && predicate(record));
    if (match) return match;
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`no matching PulseRecord landed within ${timeoutMs}ms`);
};

const runPass = async (
  label: string,
  armed: boolean,
  assert: (fixture: Fixture) => Promise<void>,
): Promise<void> => {
  console.log(`\n=== pass: ${label} ===`);
  const fixture = await setUpFixture(armed);
  const child = spawnApp(fixture);
  try {
    console.log("[probe] explicit headless mode started with zero renderer windows");
    await assert(fixture);
    console.log(`[probe] ${label}: PASS`);
  } finally {
    const receipt = await probeSupervisor.stop(
      child,
      `kernel-headless-pass-finalize:${label}`,
    );
    if (!receipt.closed) {
      throw new Error(
        `headless fixture did not close (${JSON.stringify(receipt)})`,
      );
    }
  }
};

const main = async (): Promise<void> => {
  await runPass("armed region delivers headlessly", true, async (fixture) => {
    const record = await waitForPulse(
      fixture,
      (r) => r.kind === "timer" && !r.dry && r.delivered.length > 0,
      ARMED_DELIVERY_TIMEOUT_MS,
    );
    console.log("[probe] delivered PulseRecord:", record);
  });

  await runPass("disarmed region yields a dry pulse", false, async (fixture) => {
    const record = await waitForPulse(
      fixture,
      (r) => r.kind === "timer" && r.dry && r.delivered.length === 0,
      DRY_PULSE_TIMEOUT_MS,
    );
    console.log("[probe] dry PulseRecord:", record);
  });

  mainSucceeded = true;
};

const finalize = async (reason: string): Promise<boolean> => {
  const drainReceipt = await probeSupervisor.shutdown(reason);
  let allRemoved = true;
  for (const sandbox of activeSandboxes) {
    const removed = await removeProbeSandboxIfClean({
      sandbox,
      receipt: drainReceipt,
      label: "kernel headless probe",
    });
    if (removed) activeSandboxes.delete(sandbox);
    else allRemoved = false;
  }
  return drainReceipt.clean && allRemoved;
};

const watchdog = setTimeout(() => {
  watchdogExitRequested = true;
  console.error("\nkernel-headless-probe: GLOBAL WATCHDOG EXPIRED");
  void (async () => {
    await finalize("kernel-headless-probe-watchdog").catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      return false;
    });
    process.exitCode = 124;
  })();
}, PROBE_RUNTIME_TIMEOUT_MS);
watchdog.unref();

try {
  await main();
} catch (err) {
  console.error("\nkernel-headless-probe: FAILED");
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  if (!watchdogExitRequested) process.exitCode = 2;
} finally {
  const clean = await finalize("kernel-headless-probe-finalize");
  if (!clean && !watchdogExitRequested && (process.exitCode ?? 0) === 0) {
    process.exitCode = 2;
  }
  if (
    mainSucceeded &&
    clean &&
    !watchdogExitRequested &&
    (process.exitCode ?? 0) === 0
  ) {
    console.log("\nkernel-headless-probe: ALL PASSES GREEN");
  }
  clearTimeout(watchdog);
}
