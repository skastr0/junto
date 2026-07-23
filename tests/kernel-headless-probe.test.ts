import { beforeAll, describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { isCanonicalCanvasName } from "../src/shared/canvas-name";
import { agentKeysForExecutableSource } from "../src/shared/station";
import {
  createProbeProcessSupervisor,
  type ProbeProcessClose,
} from "../scripts/probe-process-supervisor";
import {
  KERNEL_PROBE_AGENT_KEY,
  KERNEL_PROBE_CANVAS,
  KERNEL_PROBE_TIMER_ID,
  makeKernelHeadlessFixture,
} from "../scripts/kernel-headless-fixture";

const REPO_ROOT = process.cwd();
const BUN_BINARY = "bun";
const canLaunchElectron =
  process.platform !== "linux" || Boolean(process.env.DISPLAY?.trim());

const runOwnedCommand = async (
  purpose: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<ProbeProcessClose> => {
  const supervisor = createProbeProcessSupervisor({
    maxLogBytes: 512 * 1024,
    termGraceMs: 1_000,
    killGraceMs: 1_500,
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
  it("is a valid canvas with an executable timer routed to the local agent", () => {
    const doc = makeKernelHeadlessFixture();
    const timer = doc.nodes.find((node) => node.id === KERNEL_PROBE_TIMER_ID);

    expect(isCanonicalCanvasName(KERNEL_PROBE_CANVAS)).toBe(true);
    expect(decodeCanvasDoc(doc)._tag).toBe("Right");
    expect(timer?.ether?.entity?.kind).toBe("timer");
    expect(
      agentKeysForExecutableSource(
        doc,
        KERNEL_PROBE_TIMER_ID,
        "remote",
        "local",
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
        "local",
      ),
    ).toEqual([]);
  });
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
      60_000,
    );
    const output = `${probe.stdout}\n${probe.stderr}`;

    expect(
      { exitCode: probe.exitCode, signal: probe.signal },
      output,
    ).toEqual({ exitCode: 0, signal: null });
    expect(output).toContain("startup wiring PulseRecord");
    expect(output).toContain("kernel-headless-probe: STARTUP SMOKE GREEN");
    expect(output).not.toContain("trusted renderer protocol setup failed");
  }, 65_000);
});
