import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { isCanonicalCanvasName } from "../src/shared/canvas-name";
import { actorDeliverySurfaceOf } from "../src/shared/actor-surface";
import { agentKeysForExecutableSource } from "../src/shared/station";
import { readFullProcessEpochSnapshot } from "../src/main/vellum/process-epoch";
import {
  createProbeProcessSupervisor,
  type ProbeProcessClose,
  type ProbeProcessHandle,
} from "../scripts/probe-process-supervisor";
import {
  KERNEL_PROBE_AGENT_KEY,
  KERNEL_PROBE_AGENT_ID,
  KERNEL_PROBE_CANVAS,
  KERNEL_PROBE_HOST_ID,
  KERNEL_PROBE_TIMER_ID,
  makeKernelHeadlessFixture,
} from "../scripts/kernel-headless-fixture";

const REPO_ROOT = process.cwd();
const BUN_BINARY = "bun";
const canLaunchElectron =
  process.platform !== "linux" || Boolean(process.env.DISPLAY?.trim());

const waitForOutput = async (
  child: ProbeProcessHandle,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = child.output().stdout.match(pattern);
    if (match !== null) return match;
    if (child.exited()) {
      const close = await child.closed;
      throw new Error(
        `probe containment parent exited before marker (code ${String(close.exitCode)}, signal ${String(close.signal)})\n${close.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`probe containment marker exceeded ${timeoutMs}ms`);
};

const runOwnedCommand = async (
  purpose: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<ProbeProcessClose> => {
  const supervisor = createProbeProcessSupervisor({
    maxLogBytes: 512 * 1024,
    // The nested probe drains its guardian, which drains the separately-owned
    // Electron group. Leave both bounded shutdown layers real cleanup margin.
    termGraceMs: 10_000,
    killGraceMs: 5_000,
  });
  const child = supervisor.spawnGroup({
    source: "test.kernel-headless-probe",
    purpose,
    command: BUN_BINARY,
    args,
    cwd: REPO_ROOT,
    env: process.env,
  });
  try {
    return await supervisor.waitForClose(
      child,
      timeoutMs,
      `${purpose} exceeded ${timeoutMs}ms`,
    );
  } finally {
    const drained = await supervisor.shutdown(`${purpose}:test-finalize`);
    if (!drained.clean) {
      throw new Error(`${purpose} left a process group behind`);
    }
  }
};

describe("kernel headless proof fixture", () => {
  it("keeps SQLite seeding outside the Bun-facing probe process", async () => {
    const probeSource = await readFile(
      join(REPO_ROOT, "scripts", "kernel-headless-probe.ts"),
      "utf8",
    );
    const seedSource = await readFile(
      join(REPO_ROOT, "scripts", "kernel-headless-seed.ts"),
      "utf8",
    );

    expect(probeSource).not.toContain('from "../src/main/vellum/state/engine"');
    expect(probeSource).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(probeSource.match(/VELLUM_E2E: "1"/gu)).toHaveLength(1);
    expect(probeSource).toContain(
      'join(root, ".vellum", "state", "vellum.db")',
    );
    expect(probeSource).toContain("ELECTRON_GUARDIAN_FLAG");
    expect(probeSource).toContain("kernel-headless-probe-parent-eof");
    expect(probeSource).toContain('process.stdin.once("end", onParentEnd)');
    expect(seedSource).toContain(
      'from "../src/main/vellum/state/engine"',
    );
    expect(seedSource).toContain("KernelStateRepository");
    expect(seedSource).toContain("CanvasesService");
    expect(seedSource).toContain("StationRepository");
    expect(seedSource).toContain("SettingsService");
    expect(seedSource).toContain("setStationTopology");
    expect(seedSource).not.toContain("station_configuration");
    expect(seedSource).not.toContain("station_installation");
    expect(seedSource).not.toContain("node:fs");
    expect(seedSource).not.toContain("writeFile");
    expect(seedSource).not.toMatch(/\.canvas\b/u);
  });

  it("is a valid canvas with an executable timer routed to the local agent", () => {
    const doc = makeKernelHeadlessFixture();
    const timer = doc.nodes.find((node) => node.id === KERNEL_PROBE_TIMER_ID);
    const agent = doc.nodes.find((node) => node.id === KERNEL_PROBE_AGENT_ID);

    expect(isCanonicalCanvasName(KERNEL_PROBE_CANVAS)).toBe(true);
    expect(decodeCanvasDoc(doc)._tag).toBe("Right");
    expect(timer?.ether?.entity?.kind).toBe("timer");
    expect(agent && actorDeliverySurfaceOf(agent)).toMatchObject({
      _tag: "managedAgent",
      agentKey: KERNEL_PROBE_AGENT_KEY,
      bindingId: "kernel-probe-agent-seat",
      harness: "hermes",
      hostId: KERNEL_PROBE_HOST_ID,
    });
    expect(
      agentKeysForExecutableSource(
        doc,
        KERNEL_PROBE_TIMER_ID,
        "remote",
        KERNEL_PROBE_HOST_ID,
      ),
    ).toEqual([KERNEL_PROBE_AGENT_KEY]);
  });

  it("does not treat shared region membership as automatic delivery", () => {
    const doc = makeKernelHeadlessFixture();
    const edgeFree = { ...doc, edges: [] };

    expect(
      agentKeysForExecutableSource(
        edgeFree,
        KERNEL_PROBE_TIMER_ID,
        "remote",
        KERNEL_PROBE_HOST_ID,
      ),
    ).toEqual([]);
  });
});

describe("kernel probe process containment", () => {
  it("drains the guarded Electron group when its parent pipe reaches EOF", async () => {
    const supervisor = createProbeProcessSupervisor({
      maxLogBytes: 64 * 1024,
      termGraceMs: 5_000,
      killGraceMs: 3_000,
    });
    const guardedSource = [
      'process.stdout.write(`guarded-electron:${process.pid}\\n`);',
      "setTimeout(() => process.exit(3), 5_000);",
      "setInterval(() => undefined, 1_000);",
    ].join("\n");
    const guardian = supervisor.spawnGroup({
      source: "test.kernel-headless-probe.eof-guardian",
      purpose: "prove parent EOF drains guarded Electron",
      command: BUN_BINARY,
      args: [
        "scripts/kernel-headless-probe.ts",
        "--electron-guardian",
        "--eval",
        guardedSource,
      ],
      cwd: REPO_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    try {
      const marker = await waitForOutput(
        guardian,
        /guarded-electron:([1-9][0-9]*)/u,
        5_000,
      );
      const guardedPid = Number(marker[1]);
      const snapshot = readFullProcessEpochSnapshot();
      expect(snapshot).toBeDefined();
      const guardedEpoch = snapshot?.find((row) => row.pid === guardedPid);
      expect(guardedEpoch).toBeDefined();

      guardian.endInput();
      const close = await supervisor.waitForClose(
        guardian,
        10_000,
        "Electron guardian did not exit after parent EOF",
      );
      expect(close).toMatchObject({ exitCode: 0, signal: null });
      const drained = await supervisor.shutdown("guardian-eof-regression-finished");
      expect(drained).toEqual({
        clean: true,
        groupDrain: { clean: true, stragglers: [] },
        refusedSignals: [],
        active: [],
      });
      expect(
        readFullProcessEpochSnapshot()?.some(
          (row) =>
            row.pid === guardedPid &&
            row.startKey === guardedEpoch?.startKey,
        ),
      ).toBe(false);
    } finally {
      guardian.endInput();
      await supervisor.shutdown("kernel-probe-guardian-test-finalize");
    }
  }, 15_000);
});

describe.runIf(canLaunchElectron)("kernel headless real startup wiring", () => {
  beforeAll(async () => {
    const build = await runOwnedCommand(
      "build Electron artifacts for kernel startup smoke",
      ["x", "electron-vite", "build"],
      60_000,
    );
    expect(
      { exitCode: build.exitCode, signal: build.signal, stderr: build.stderr },
      build.stderr,
    ).toMatchObject({ exitCode: 0, signal: null });
  }, 65_000);

  it("boots the real headless app through its trusted renderer authority", async () => {
    const probe = await runOwnedCommand(
      "run kernel headless startup smoke",
      ["scripts/kernel-headless-probe.ts", "--startup-smoke"],
      140_000,
    );
    const output = `${probe.stdout}\n${probe.stderr}`;

    expect(
      { exitCode: probe.exitCode, signal: probe.signal },
      output,
    ).toEqual({ exitCode: 0, signal: null });
    expect(output).toContain("startup wiring PulseRecord");
    expect(output).toContain("kernel-headless-probe: STARTUP SMOKE GREEN");
    expect(output).not.toContain("trusted renderer protocol setup failed");
  }, 150_000);
});
