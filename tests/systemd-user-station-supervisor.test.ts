import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SystemctlRunResult,
  VellumSystemdUserUnitTarget,
} from "../src/main/vellum-command/supervision/systemctl-runner";

const mocks = vi.hoisted(() => ({
  target: Object.freeze({}) as VellumSystemdUserUnitTarget,
  systemdUserUnitTarget: vi.fn(),
  showVellumSystemdUserUnit: vi.fn(),
  startVellumSystemdUserUnit: vi.fn(),
}));

vi.mock("../src/main/vellum-command/supervision/systemctl-runner", () => ({
  VELLUM_COMMAND_SYSTEMD_USER_UNIT: "vellum-command-remote.service",
  systemdUserUnitTarget: mocks.systemdUserUnitTarget,
  showVellumSystemdUserUnit: mocks.showVellumSystemdUserUnit,
  startVellumSystemdUserUnit: mocks.startVellumSystemdUserUnit,
}));

import {
  createSystemdUserStationSupervisor,
  renderUserlandLinuxService,
  USERLAND_LINUX_SERVICE_PATH,
} from "../src/main/vellum-command/supervision/systemd-user";

const showOutput = (overrides: Partial<Record<
  "LoadState" | "ActiveState" | "SubState" | "MainPID" | "ControlGroup" | "InvocationID",
  string
>> = {}): string => {
  const fields = {
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    MainPID: String(process.pid),
    ControlGroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/vellum-command-remote.service",
    InvocationID: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(
    "\n",
  ) + "\n";
};

const successful = (stdout = showOutput()): SystemctlRunResult => ({
  action: "show",
  unit: "vellum-command-remote.service",
  stdout,
  stderr: "",
  clean: true,
  ok: true,
  close: { code: 0, signal: null },
});

const failed = (
  kind: "exit-nonzero" | "process-error" | "deadline" | "close-timeout",
  stdout = "",
): SystemctlRunResult => ({
  action: "show",
  unit: "vellum-command-remote.service",
  stdout,
  stderr: "bounded diagnostic",
  clean: kind !== "close-timeout",
  ok: false,
  ...(kind === "close-timeout"
    ? {}
    : { close: { code: 1, signal: null } }),
  failure: { kind, diagnostic: "bounded diagnostic" },
});

beforeEach(() => {
  mocks.systemdUserUnitTarget.mockReset();
  mocks.showVellumSystemdUserUnit.mockReset();
  mocks.startVellumSystemdUserUnit.mockReset();
  mocks.systemdUserUnitTarget.mockReturnValue(mocks.target);
});

describe("userland Linux service rendering", () => {
  const release = "/home/remote/.vellum-command/runtime/releases/1.2.3-" + "a".repeat(64);

  it("pins the unit to one immutable release without a shell or current link", () => {
    const service = renderUserlandLinuxService({ releaseDirectory: release });
    expect(USERLAND_LINUX_SERVICE_PATH).toBe(
      ".config/systemd/user/vellum-command-remote.service",
    );
    expect(service).toContain(
      `ConditionFileIsExecutable=${release}/resources/bin/vellum-command-remote`,
    );
    expect(service).toContain(
      `ExecStart=${release}/resources/systemd/vellum-command-remote-launch`,
    );
    expect(service).toContain("Type=notify");
    expect(service).toContain("RuntimeDirectoryMode=0700");
    expect(service).not.toMatch(/\/opt\/|current|\/bin\/sh|User=|loginctl|linger/u);
    expect(service).not.toMatch(/^Environment=ELECTRON_OZONE/mu);
    expect(service).not.toMatch(/^Environment=OZONE_PLATFORM=/mu);
    expect(service).not.toMatch(/^Environment=XDG_SESSION_TYPE=/mu);
    expect(service).not.toMatch(/^ConditionFileIsExecutable=.*\/vellum$/mu);
  });

  it("escapes a safe home path and rejects paths outside the immutable layout", () => {
    expect(renderUserlandLinuxService({
      releaseDirectory: "/home/remote station/.vellum-command/runtime/releases/1.2.3-" + "b".repeat(64),
    })).toContain("/home/remote\\x20station/.vellum-command/runtime/releases/");
    expect(() => renderUserlandLinuxService({
      releaseDirectory: "/home/remote/.vellum-command/runtime/current",
    })).toThrow(/canonical immutable/u);
    expect(() => renderUserlandLinuxService({
      releaseDirectory: "/home/remote/.vellum-command/runtime/releases/1.2.3-" + "A".repeat(64),
    })).toThrow(/canonical immutable/u);
  });
});

describe("systemd user station supervisor observation", () => {
  it("does not derive Electron ownership from systemd wrapper MainPID", async () => {
    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(successful());
    const supervisor = createSystemdUserStationSupervisor();

    const current = await supervisor.observe();
    expect(supervisor.metadata).toMatchObject({
      provider: "systemd-user",
      serviceLabel: "vellum-command-remote.service",
    });
    expect(current).toEqual({
      provider: "systemd-user",
      state: "active",
      ownership: "other",
    });
    expect(current).not.toHaveProperty("pid");
    expect(current).not.toHaveProperty("MainPID");

    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(successful(
      showOutput({ MainPID: String(process.pid + 1) }),
    ));
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "systemd-user",
      state: "active",
      ownership: "other",
    });
  });

  it("distinguishes installed inactive and canonical absent units", async () => {
    const supervisor = createSystemdUserStationSupervisor();
    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(successful(
      showOutput({ ActiveState: "inactive", SubState: "dead", MainPID: "0" }),
    ));
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "systemd-user",
      state: "inactive",
      ownership: "none",
    });

    const absent = showOutput({
      LoadState: "not-found",
      ActiveState: "inactive",
      SubState: "dead",
      MainPID: "0",
      ControlGroup: "",
      InvocationID: "",
    });
    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(successful(absent));
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "systemd-user",
      state: "absent",
      ownership: "none",
    });

    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(successful(
      showOutput({ ActiveState: "inactive", SubState: "dead", MainPID: "0", ControlGroup: "", InvocationID: "" }),
    ));
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "systemd-user",
      state: "inactive",
      ownership: "none",
    });

    mocks.showVellumSystemdUserUnit.mockResolvedValueOnce(
      failed("exit-nonzero", absent),
    );
    await expect(supervisor.observe()).resolves.toEqual({
      provider: "systemd-user",
      state: "absent",
      ownership: "none",
    });
  });

  it.each([
    "",
    "LoadState=loaded\nActiveState=active\nSubState=running\n",
    showOutput() + "Description=unexpected\n",
    "LoadState=loaded\nLoadState=loaded\nSubState=running\nMainPID=3\n",
    showOutput({ MainPID: "-1" }),
    showOutput({ MainPID: "2147483648" }),
    showOutput({ ActiveState: "active now" }),
  ])("degrades on malformed systemctl properties", async (stdout) => {
    mocks.showVellumSystemdUserUnit.mockResolvedValue(successful(stdout));
    const supervisor = createSystemdUserStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "systemd-user",
      state: "degraded",
      ownership: "unknown",
      failure: { kind: "invalid-output" },
    });
  });

  it.each([
    showOutput({ ActiveState: "failed", SubState: "failed", MainPID: "0" }),
    showOutput({ ActiveState: "active", SubState: "exited", MainPID: "0" }),
    showOutput({ LoadState: "masked", ActiveState: "inactive", MainPID: "0" }),
    showOutput({ LoadState: "not-found", MainPID: "9" }),
  ])("reports valid but unhealthy service state as degraded", async (stdout) => {
    mocks.showVellumSystemdUserUnit.mockResolvedValue(successful(stdout));
    const supervisor = createSystemdUserStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "systemd-user",
      state: "degraded",
      failure: { kind: "service-degraded" },
    });
  });

  it.each([
    ["process-error", "process-error"],
    ["deadline", "deadline"],
    ["close-timeout", "close-unconfirmed"],
    ["exit-nonzero", "command-failed"],
  ] as const)("maps %s to a typed unknown observation", async (kind, expected) => {
    mocks.showVellumSystemdUserUnit.mockResolvedValue(failed(kind));
    const supervisor = createSystemdUserStationSupervisor();

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "systemd-user",
      state: "unknown",
      ownership: "unknown",
      failure: { kind: expected, diagnostic: "bounded diagnostic" },
    });
  });
});

describe("systemd user station supervisor handoff", () => {
  it("reports only request acceptance", async () => {
    mocks.startVellumSystemdUserUnit.mockResolvedValue({
      ...successful(""),
      action: "start",
    });
    const supervisor = createSystemdUserStationSupervisor();

    const result = await supervisor.requestHandoff();

    expect(result).toEqual({ provider: "systemd-user", accepted: true });
    expect(result).not.toHaveProperty("state");
    expect(mocks.startVellumSystemdUserUnit).toHaveBeenCalledWith(mocks.target);
  });

  it("returns a typed failure when systemd rejects the request", async () => {
    mocks.startVellumSystemdUserUnit.mockResolvedValue({
      ...failed("process-error"),
      action: "start",
    });
    const supervisor = createSystemdUserStationSupervisor();

    await expect(supervisor.requestHandoff()).resolves.toEqual({
      provider: "systemd-user",
      accepted: false,
      failure: {
        kind: "process-error",
        diagnostic: "bounded diagnostic",
      },
    });
  });
});
