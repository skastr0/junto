import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({
  spawnDetachedProcessGroup: vi.fn(),
  signalOwned: vi.fn(),
  releaseOwned: vi.fn(),
}));

vi.mock("../src/main/vellum/process-signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/vellum/process-signal")>()),
  spawnDetachedProcessGroup: processMocks.spawnDetachedProcessGroup,
  signalOwned: processMocks.signalOwned,
  releaseOwned: processMocks.releaseOwned,
}));

import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  assertDarwinUnixSocketPathFits,
  assertNoLiveVellumRuntime,
  assertNoTcpListeners,
  boundedProcessKind,
  descendantRows,
  finalizePackagedRuntimeSandbox,
  hasDebugAuthority,
  modeString,
  observeSpawnedRuntimeLease,
  parseDoctorReceipt,
  parsePackagedStationStatus,
  parseProcessRows,
  processRoles,
  survivingProcessRows,
  terminateSpawnedRuntime,
} from "../scripts/packaged-runtime-smoke";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import {
  createAppProcessPlane,
  type AppProcessLease,
} from "../src/main/vellum/app-process-plane";
import {
  setProcessEpochReaderForTests,
  type ProcessEpochRow,
} from "../src/main/vellum/process-epoch";

class FakeRuntimeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 42_900;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  onSignal: ((signal: NodeJS.Signals) => void) | undefined;

  readonly kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
    this.signals.push(signal);
    this.onSignal?.(signal);
    return true;
  };

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

interface FakeOwned {
  readonly child: FakeRuntimeChild;
  released: boolean;
}

const tempRoots = new Set<string>();

const epochRow = (
  pid: number,
  processGroupId: number,
  sessionId: number,
  startKey: string,
): ProcessEpochRow => ({ pid, processGroupId, sessionId, startKey });

const spawnGroupLease = (
  child: FakeRuntimeChild,
  mode: "group" | "child" = "group",
): { readonly plane: ReturnType<typeof createAppProcessPlane>; readonly lease: AppProcessLease } => {
  const owned: FakeOwned = { child, released: false };
  processMocks.spawnDetachedProcessGroup.mockReturnValue({
    child: child.asChild(),
    process: owned,
    mode,
  });
  const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
  const lease = plane.spawnGroup({
    source: "packaged-runtime-smoke-test",
    purpose: "test packaged runtime",
    command: "/Applications/Vellum Command.app/Contents/MacOS/Vellum Command",
  });
  return { plane, lease };
};

beforeEach(() => {
  processMocks.spawnDetachedProcessGroup.mockReset();
  processMocks.signalOwned.mockReset();
  processMocks.releaseOwned.mockReset();
  processMocks.releaseOwned.mockImplementation((owned: FakeOwned) => {
    owned.released = true;
  });
  setProcessEpochReaderForTests({
    snapshot: () => [epochRow(42_900, 42_900, 77, "runtime-a")],
  });
});

afterEach(async () => {
  setProcessEpochReaderForTests(undefined);
  vi.useRealTimers();
  await Promise.all([...tempRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }));
});

const processFixture = `
  900 1 /release/Vellum Command.app/Contents/MacOS/Vellum Command --user-data-dir=/tmp/isolated
  904 900 /release/Vellum Command.app/Contents/Frameworks/Vellum Command Helper.app/Contents/MacOS/Vellum Command Helper --type=utility
  902 900 /release/Vellum Command.app/Contents/Frameworks/Vellum Command Helper.app/Contents/MacOS/Vellum Command Helper --type=gpu-process
  906 1 /usr/bin/unrelated
  903 900 /release/Vellum Command.app/Contents/Frameworks/Vellum Command Helper (Renderer).app/Contents/MacOS/Vellum Command Helper (Renderer) --type=renderer
  905 904 /release/Vellum Command.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler
`;

describe("packaged runtime smoke process qualification", () => {
  it("finds the complete descendant closure and exact normalized roles", () => {
    const rows = parseProcessRows(processFixture);
    expect(descendantRows(900, rows).map((row) => row.pid).sort()).toEqual([
      900, 902, 903, 904, 905,
    ]);
    expect(processRoles(900, rows)).toEqual([
      "gpu-process",
      "main",
      "renderer",
      "utility",
    ]);
  });

  it("pins descendant identity so a reused PID cannot become a false survivor", () => {
    const original = parseProcessRows(processFixture);
    const current = [
      { ...original[0] },
      { pid: original[1].pid, ppid: 1, command: "/usr/bin/unrelated-reused-pid" },
    ];
    expect(survivingProcessRows(original, current)).toEqual([original[0]]);
  });

  it("reports only an allowlisted kind for a surviving codexbar adapter", () => {
    expect(
      boundedProcessKind(
        "/private/tool/codexbar usage --json --provider secret-provider-material",
      ),
    ).toBe("codexbar");
  });

  it("rejects live Vellum Command and debugger/CDP authority", () => {
    expect(() =>
      assertNoLiveVellumRuntime(parseProcessRows(processFixture), ["/release/Vellum Command.app"]),
    ).toThrow(/already running/u);
    expect(() =>
      assertNoLiveVellumRuntime([
        { pid: 1, ppid: 0, command: "/Applications/Other.app/Contents/MacOS/Other" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoLiveVellumRuntime([
        {
          pid: 2,
          ppid: 1,
          command: "/usr/bin/codesign -d /Applications/Vellum Command.app/Contents/MacOS/Vellum Command",
        },
      ]),
    ).not.toThrow();
    expect(
      hasDebugAuthority([
        { pid: 1, ppid: 0, command: "Vellum Command --remote-debugging-port=9222" },
      ]),
    ).toBe(true);
    expect(
      hasDebugAuthority([{ pid: 1, ppid: 0, command: "Vellum Command --inspect-brk=0" }]),
    ).toBe(true);
    expect(hasDebugAuthority(parseProcessRows(processFixture))).toBe(false);
  });

  it("rejects malformed ps rows", () => {
    expect(() => parseProcessRows("not-a-row")).toThrow(/malformed/u);
    expect(() => parseProcessRows("0 1 command")).toThrow(/invalid/u);
  });
});

describe("packaged runtime smoke receipts", () => {
  it("accepts only the exact doctor envelope", () => {
    expect(parseDoctorReceipt('{"ok":true,"data":{"status":"ok"}}')).toEqual({
      ok: true,
      data: { status: "ok" },
    });
    expect(() => parseDoctorReceipt("not-json")).toThrow(/non-JSON/u);
    expect(() =>
      parseDoctorReceipt('{"ok":true,"data":{"status":"ok","token":"leak"}}'),
    ).toThrow(/wrong doctor payload/u);
    expect(() =>
      parseDoctorReceipt('{"ok":true,"data":{"status":"ok"},"extra":true}'),
    ).toThrow(/wrong doctor envelope/u);
  });

  it("accepts one correlated owner-local Station status response", () => {
    const response = `${JSON.stringify({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId: "packaged-runtime-status",
      envelope: {
        protocol: STATION_CONTROL_PROTOCOL,
        ok: true,
        response: {
          protocol: STATION_API_PROTOCOL,
          op: "status",
          installationId: "remote-01",
          state: "unenrolled",
          receivedThrough: [],
          peerAcknowledgedThrough: [],
          readiness: {
            database: true,
            workControl: true,
            simulation: false,
            session: true,
          },
          observedAt: "2026-07-28T12:00:00.000Z",
        },
      },
    })}\n`;

    expect(parsePackagedStationStatus(response)).toMatchObject({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: "remote-01",
      state: "unenrolled",
    });
    expect(() =>
      parsePackagedStationStatus(
        response.replace(
          '"packaged-runtime-status"',
          '"another-request"',
        ),
      )
    ).toThrow(/wrong status response/u);
    expect(() =>
      parsePackagedStationStatus(
        response.replace('"ok":true', '"ok":false'),
      )
    ).toThrow();
  });

  it("normalizes owner-only modes and treats lsof exit 1 plus empty output as no listener", () => {
    expect(modeString(0o40700)).toBe("0700");
    expect(modeString(0o100600)).toBe("0600");
    expect(() => assertNoTcpListeners(1, "")).not.toThrow();
    expect(() => assertNoTcpListeners(0, "COMMAND PID ...")).toThrow(/TCP listener/u);
    expect(() => assertNoTcpListeners(2, "")).toThrow(/TCP listener/u);
  });

  it("fails before launch when an isolated Unix socket exceeds Darwin sun_path", () => {
    const exact = `/${"a".repeat(DARWIN_UNIX_SOCKET_PATH_MAX_BYTES - 1)}`;
    const tooLong = `${exact}a`;
    expect(Buffer.byteLength(exact)).toBe(DARWIN_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(Buffer.byteLength(tooLong)).toBe(DARWIN_UNIX_SOCKET_PATH_MAX_BYTES + 1);
    expect(() => assertDarwinUnixSocketPathFits(exact)).not.toThrow();
    expect(() => assertDarwinUnixSocketPathFits(tooLong)).toThrow(/Darwin 103-byte limit/u);
    expect(() =>
      assertDarwinUnixSocketPathFits(
        "/private/tmp/vellum-smoke-XXXXXX/home/.vellum-command/browser/control.sock",
      ),
    ).not.toThrow();
  });
});

describe("packaged runtime smoke child lifecycle", () => {
  it("records error-before-close without treating the error as terminal", async () => {
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { lease } = spawnGroupLease(child);
    const lifecycle = observeSpawnedRuntimeLease(lease);
    let settled = false;
    const terminal = lifecycle.waitForClose(1_000).then((result) => {
      settled = true;
      return result;
    });

    child.emit("error", new Error("spawn failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(lifecycle.terminal()).toBeUndefined();
    expect(lifecycle.error()?.message).toBe("spawn failed");

    child.close(null, null);
    await expect(terminal).resolves.toMatchObject({
      code: null,
      signal: null,
      error: expect.objectContaining({ message: "spawn failed" }),
    });
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains an error during TERM and still waits for close", async () => {
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { plane, lease } = spawnGroupLease(child);
    const lifecycle = observeSpawnedRuntimeLease(lease);
    processMocks.signalOwned.mockImplementation((owned: FakeOwned, signal: NodeJS.Signals) => {
      owned.child.kill(signal);
      return {
        attempted: true,
        decision: { ok: true, mode: "group" },
        via: "process.kill-group",
      };
    });
    child.onSignal = (signal) => {
      if (signal === "SIGTERM") child.emit("error", new Error("TERM delivery failed"));
    };

    const cleanup = terminateSpawnedRuntime(plane, lifecycle, lease, 1_000);
    await Promise.resolve();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(lifecycle.terminal()).toBeUndefined();
    expect(lifecycle.error()?.message).toBe("TERM delivery failed");
    expect(vi.getTimerCount()).toBe(1);

    child.close(0, null);
    await cleanup;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces a TERM-resistant runtime only through its central group lease", async () => {
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { plane, lease } = spawnGroupLease(child);
    const lifecycle = observeSpawnedRuntimeLease(lease);
    processMocks.signalOwned.mockImplementation((owned: FakeOwned, signal: NodeJS.Signals) => {
      owned.child.kill(signal);
      return {
        attempted: true,
        decision: { ok: true, mode: "group" },
        via: "process.kill-group",
      };
    });
    child.onSignal = (signal) => {
      if (signal === "SIGKILL") child.close(null, "SIGKILL");
    };

    const cleanup = terminateSpawnedRuntime(plane, lifecycle, lease, 100);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lifecycle.terminal()).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the sandbox and returns a bounded straggler when group admission was refused", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "vellum-smoke-refused-"));
    tempRoots.add(tempRoot);
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { plane, lease } = spawnGroupLease(child, "child");
    processMocks.signalOwned.mockReturnValue({
      attempted: false,
      decision: { ok: false, reason: "child-epoch-unavailable" },
      via: "none",
    });

    const finalizing = finalizePackagedRuntimeSandbox(plane, lease, tempRoot);
    await vi.advanceTimersByTimeAsync(25);
    const result = await finalizing;

    expect(result).toMatchObject({
      proof: {
        clean: false,
        reason: "group-admission-refused",
        groupAdmission: "refused",
        descendants: "unproven",
      },
      tempRootRemoved: false,
      drain: {
        clean: false,
        stragglers: [{
          mode: "child",
          state: "refused",
          term: { attempted: false, decision: { reason: "child-epoch-unavailable" } },
          kill: { attempted: false, decision: { reason: "child-epoch-unavailable" } },
        }],
      },
    });
    await expect(lstat(tempRoot)).resolves.toBeDefined();
    expect(child.signals).toEqual([]);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the sandbox when a fallback root closes but descendants remain unproven", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "vellum-smoke-root-only-"));
    tempRoots.add(tempRoot);
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { plane, lease } = spawnGroupLease(child, "child");
    processMocks.signalOwned.mockImplementation((owned: FakeOwned, signal: NodeJS.Signals) => {
      owned.child.kill(signal);
      owned.child.close(0, null);
      return {
        attempted: true,
        decision: { ok: true, mode: "child" },
        via: "child.kill",
      };
    });

    const finalizing = finalizePackagedRuntimeSandbox(plane, lease, tempRoot);
    await vi.advanceTimersByTimeAsync(10);
    const result = await finalizing;

    expect(result).toEqual({
      proof: {
        clean: false,
        reason: "group-admission-refused",
        groupAdmission: "refused",
        descendants: "unproven",
      },
      drain: { clean: true, stragglers: [] },
      tempRootRemoved: false,
    });
    await expect(lstat(tempRoot)).resolves.toBeDefined();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an unclosed runtime after epoch revalidation refuses both signal phases", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "vellum-smoke-epoch-"));
    tempRoots.add(tempRoot);
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const { plane, lease } = spawnGroupLease(child);
    processMocks.signalOwned.mockReturnValue({
      attempted: false,
      decision: { ok: false, reason: "group-epoch-mismatch" },
      via: "none",
    });

    const finalizing = finalizePackagedRuntimeSandbox(plane, lease, tempRoot);
    await vi.advanceTimersByTimeAsync(25);
    const result = await finalizing;

    expect(result).toMatchObject({
      proof: {
        clean: false,
        reason: "descendants-unproven",
        groupAdmission: "verified",
        descendants: "unproven",
      },
      tempRootRemoved: false,
      drain: {
        clean: false,
        stragglers: [{
          mode: "group",
          state: "refused",
          term: { attempted: false, decision: { reason: "group-epoch-mismatch" } },
          kill: { attempted: false, decision: { reason: "group-epoch-mismatch" } },
        }],
      },
    });
    await expect(lstat(tempRoot)).resolves.toBeDefined();
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the sandbox only after a clean central group drain", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "vellum-smoke-clean-"));
    tempRoots.add(tempRoot);
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    let snapshot: readonly ProcessEpochRow[] = [
      epochRow(child.pid!, child.pid!, 77, "runtime-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const { plane, lease } = spawnGroupLease(child);
    processMocks.signalOwned.mockImplementation((owned: FakeOwned, signal: NodeJS.Signals) => {
      owned.child.kill(signal);
      snapshot = [];
      owned.child.close(null, signal);
      return {
        attempted: true,
        decision: { ok: true, mode: "group" },
        via: "process.kill-group",
      };
    });

    const finalizing = finalizePackagedRuntimeSandbox(plane, lease, tempRoot);
    await vi.advanceTimersByTimeAsync(10);
    const result = await finalizing;

    expect(result).toEqual({
      proof: {
        clean: true,
        groupAdmission: "verified",
        descendants: "proven-gone",
      },
      drain: { clean: true, stragglers: [] },
      tempRootRemoved: true,
    });
    await expect(lstat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.delete(tempRoot);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
