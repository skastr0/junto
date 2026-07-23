import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchctlRunResult,
  VellumLaunchAgentTarget,
} from "../src/main/vellum/settings/launchctl-runner";

const mocks = vi.hoisted(() => ({
  target: Object.freeze({}) as VellumLaunchAgentTarget,
  launchAgentTargetForCurrentUser: vi.fn(),
  printLaunchAgent: vi.fn(),
  kickstartLaunchAgent: vi.fn(),
}));

vi.mock("../src/main/vellum/settings/launchctl-runner", () => ({
  VELLUM_LAUNCHD_LABEL: "skastr0.vellum",
  launchAgentTargetForCurrentUser: mocks.launchAgentTargetForCurrentUser,
  printLaunchAgent: mocks.printLaunchAgent,
  kickstartLaunchAgent: mocks.kickstartLaunchAgent,
}));

import { createDarwinStationSupervisor } from "../src/main/vellum/supervision/darwin";

const successful = (stdout = ""): LaunchctlRunResult => ({
  action: "print",
  target: "gui/501/skastr0.vellum",
  stdout,
  stderr: "",
  clean: true,
  ok: true,
  close: { code: 0, signal: null },
});

const failed = (
  kind: "exit-nonzero" | "process-error" | "deadline" | "close-timeout",
  code: number | null = null,
): LaunchctlRunResult => ({
  action: "print",
  target: "gui/501/skastr0.vellum",
  stdout: "",
  stderr: "bounded diagnostic",
  clean: kind !== "close-timeout",
  ok: false,
  ...(kind === "close-timeout" ? {} : { close: { code, signal: null } }),
  failure: { kind, diagnostic: "bounded diagnostic" },
});

beforeEach(() => {
  mocks.launchAgentTargetForCurrentUser.mockReset();
  mocks.printLaunchAgent.mockReset();
  mocks.kickstartLaunchAgent.mockReset();
  mocks.launchAgentTargetForCurrentUser.mockReturnValue(mocks.target);
});

describe("Darwin station supervisor observation", () => {
  it("identifies the current launchd-owned process without exposing its pid", async () => {
    mocks.printLaunchAgent.mockResolvedValue(
      successful(`state = running\n\tpid = ${process.pid}\n`),
    );
    const supervisor = createDarwinStationSupervisor();

    const observation = await supervisor.observe();

    expect(supervisor.metadata).toMatchObject({
      provider: "launchd",
      serviceLabel: "skastr0.vellum",
    });
    expect(observation).toEqual({
      provider: "launchd",
      state: "active",
      ownership: "current",
    });
    expect(observation).not.toHaveProperty("pid");
    expect(mocks.printLaunchAgent).toHaveBeenCalledWith(mocks.target);
  });

  it("distinguishes a foreign supervised process and an inactive job", async () => {
    mocks.printLaunchAgent.mockResolvedValueOnce(
      successful(`\tpid = ${process.pid + 1}\n`),
    );
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.observe()).resolves.toEqual({
      provider: "launchd",
      state: "active",
      ownership: "other",
    });

    mocks.printLaunchAgent.mockResolvedValueOnce(
      successful("state = waiting\n"),
    );
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "launchd",
      state: "inactive",
      ownership: "none",
    });
  });

  it.each([
    "pid = nope",
    "pid = 0",
    "pid = 2147483648",
    "pid = 7\npid = 8",
  ])("degrades on an ambiguous launchctl pid field: %s", async (stdout) => {
    mocks.printLaunchAgent.mockResolvedValue(successful(stdout));
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "launchd",
      state: "degraded",
      ownership: "unknown",
      failure: { kind: "invalid-output" },
    });
  });

  it("recognizes only launchctl's known missing-service exit as absent", async () => {
    mocks.printLaunchAgent.mockResolvedValueOnce(failed("exit-nonzero", 113));
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.observe()).resolves.toEqual({
      provider: "launchd",
      state: "absent",
      ownership: "none",
    });

    mocks.printLaunchAgent.mockResolvedValueOnce(failed("exit-nonzero", 5));
    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "launchd",
      state: "unknown",
      ownership: "unknown",
      failure: { kind: "command-failed" },
    });
  });

  it.each([
    ["process-error", "process-error"],
    ["deadline", "deadline"],
    ["close-timeout", "close-unconfirmed"],
  ] as const)("maps %s to a typed unknown observation", async (kind, expected) => {
    mocks.printLaunchAgent.mockResolvedValue(failed(kind));
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "launchd",
      state: "unknown",
      ownership: "unknown",
      failure: { kind: expected, diagnostic: "bounded diagnostic" },
    });
  });

  it("fails closed when current-user target authority cannot be minted", async () => {
    mocks.launchAgentTargetForCurrentUser.mockReturnValue(undefined);
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "launchd",
      state: "unknown",
      ownership: "unknown",
      failure: { kind: "target-unavailable" },
    });
    expect(mocks.printLaunchAgent).not.toHaveBeenCalled();
  });
});

describe("Darwin station supervisor handoff", () => {
  it("reports only request acceptance, not eventual service state", async () => {
    mocks.kickstartLaunchAgent.mockResolvedValue({
      ...successful(),
      action: "kickstart",
    });
    const supervisor = createDarwinStationSupervisor();

    const result = await supervisor.requestHandoff();

    expect(result).toEqual({ provider: "launchd", accepted: true });
    expect(result).not.toHaveProperty("state");
    expect(mocks.kickstartLaunchAgent).toHaveBeenCalledWith(mocks.target);
  });

  it("returns bounded typed failure when launchd rejects handoff", async () => {
    mocks.kickstartLaunchAgent.mockResolvedValue({
      ...failed("process-error"),
      action: "kickstart",
    });
    const supervisor = createDarwinStationSupervisor();

    await expect(supervisor.requestHandoff()).resolves.toEqual({
      provider: "launchd",
      accepted: false,
      failure: {
        kind: "process-error",
        diagnostic: "bounded diagnostic",
      },
    });
  });
});
