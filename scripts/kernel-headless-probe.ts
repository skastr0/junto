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
//      closes every window over CDP (window-all-closed does not quit on
//      darwin — the app + kernel keep running with zero windows, exactly
//      the packaged/launchd shape), and waits for a rising-edge TIMER pulse
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
// process outside itself, and CDP is only used here to close windows, not to
// drive kernel state.
//
// Exit 0 if both passes hold; exit 2 with a diagnosis otherwise.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scripts in this repo are always invoked from the repo root (`bun run
// scripts/...` / `bun scripts/...`), matching every other script here — no
// bun-specific import.meta.dir needed.
const REPO_ROOT = process.cwd();
const ELECTRON_BIN = join(REPO_ROOT, "node_modules", ".bin", "electron");
const MAIN_ENTRY = join(REPO_ROOT, "out", "main", "index.js");

// index.ts hardcodes 9223 for !app.isPackaged — a plain `electron <path>`
// launch (not an electron-builder .app) is always unpackaged, so this is
// live without any extra flag.
const CDP_PORT = 9223;

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
const CDP_ATTACH_TIMEOUT_MS = 20_000;
const ARMED_DELIVERY_TIMEOUT_MS = 90_000; // headroom for a real model turn
const DRY_PULSE_TIMEOUT_MS = 15_000;

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
      ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: AGENT_KEY } }] },
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
  const root = await mkdtemp(join(tmpdir(), "vellum-kernel-probe-"));
  const userDataDir = join(root, "userData");
  const canvasesDir = join(root, "canvases");
  await mkdir(canvasesDir, { recursive: true });
  await writeFile(join(canvasesDir, `${FIXTURE_CANVAS}.canvas`), JSON.stringify(fixtureDoc(), null, 2), "utf8");
  if (armed) {
    await writeStore(userDataDir, { "kernel.armed": { [`${FIXTURE_CANVAS}::${REGION_ID}`]: true } });
  }
  return { userDataDir, canvasesDir };
};

const spawnApp = (fixture: Fixture): ChildProcess => {
  const child = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--user-data-dir=${fixture.userDataDir}`], {
    env: { ...process.env, VELLUM_CANVASES_DIR: fixture.canvasesDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk}`));
  return child;
};

interface CdpTarget {
  readonly id: string;
  readonly type: string;
}

// Hand-rolled HTTP calls against the CDP JSON endpoint rather than a CDP
// client library: /json/list and /json/close/{id} are plain HTTP (no
// WebSocket handshake needed to close a target), which sidesteps
// playwright-core's connectOverCDP hanging indefinitely against this
// Electron/Chrome build in practice (verified live against this exact app).
const cdpBase = () => `http://127.0.0.1:${CDP_PORT}`;

const listCdpTargets = async (): Promise<ReadonlyArray<CdpTarget>> => {
  const res = await fetch(`${cdpBase()}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list: HTTP ${res.status}`);
  return (await res.json()) as ReadonlyArray<CdpTarget>;
};

// Closes every open window via the CDP HTTP endpoint, then verifies zero
// windows remain — mirrors a packaged/launchd instance whose window the
// operator closed. window-all-closed does NOT quit on darwin
// (src/main/index.ts), so the app + kernel keep running underneath.
const closeAllWindowsAndVerify = async (): Promise<void> => {
  const deadline = Date.now() + CDP_ATTACH_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets();
      for (const target of targets.filter((t) => t.type === "page")) {
        await fetch(`${cdpBase()}/json/close/${target.id}`).catch(() => undefined);
      }
      await sleep(300);
      const remaining = (await listCdpTargets()).filter((t) => t.type === "page");
      if (remaining.length > 0) throw new Error(`${remaining.length} window(s) still open after close`);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`could not close windows over CDP within ${CDP_ATTACH_TIMEOUT_MS}ms: ${String(lastErr)}`);
};

const waitForPulse = async (
  fixture: Fixture,
  predicate: (record: PulseRecordLike) => boolean,
  timeoutMs: number,
): Promise<PulseRecordLike> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = await readStore(fixture.userDataDir);
    const debug = store["kernel.debug"] as { pulseLog?: ReadonlyArray<PulseRecordLike> } | undefined;
    const match = debug?.pulseLog?.find((record) => record.canvasName === FIXTURE_CANVAS && predicate(record));
    if (match) return match;
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`no matching PulseRecord landed within ${timeoutMs}ms`);
};

const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
    await closeAllWindowsAndVerify();
    console.log("[probe] windows closed, BrowserWindow.getAllWindows().length === 0 confirmed via CDP");
    await assert(fixture);
    console.log(`[probe] ${label}: PASS`);
  } finally {
    await killChild(child);
    await rm(join(fixture.userDataDir, ".."), { recursive: true, force: true }).catch(() => undefined);
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

  console.log("\nkernel-headless-probe: ALL PASSES GREEN");
};

main().catch((err) => {
  console.error("\nkernel-headless-probe: FAILED");
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
