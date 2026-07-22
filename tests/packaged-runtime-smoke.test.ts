import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  assertDarwinUnixSocketPathFits,
  assertNoLiveVellumRuntime,
  assertNoTcpListeners,
  boundedProcessKind,
  descendantRows,
  hasDebugAuthority,
  modeString,
  observeSpawnedRuntimeChild,
  parseDoctorReceipt,
  parseProcessRows,
  processRoles,
  survivingProcessRows,
  terminateSpawnedRuntime,
} from "../scripts/packaged-runtime-smoke";
import { admitChildProcess, releaseOwned } from "../src/main/vellum/process-signal";

class FakeRuntimeChild extends EventEmitter {
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
    this.emit("close", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

const processFixture = `
  900 1 /release/Vellum.app/Contents/MacOS/Vellum --user-data-dir=/tmp/isolated
  904 900 /release/Vellum.app/Contents/Frameworks/Vellum Helper.app/Contents/MacOS/Vellum Helper --type=utility
  902 900 /release/Vellum.app/Contents/Frameworks/Vellum Helper.app/Contents/MacOS/Vellum Helper --type=gpu-process
  906 1 /usr/bin/unrelated
  903 900 /release/Vellum.app/Contents/Frameworks/Vellum Helper (Renderer).app/Contents/MacOS/Vellum Helper (Renderer) --type=renderer
  905 904 /release/Vellum.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler
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

  it("rejects live Vellum and debugger/CDP authority", () => {
    expect(() =>
      assertNoLiveVellumRuntime(parseProcessRows(processFixture), ["/release/Vellum.app"]),
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
          command: "/usr/bin/codesign -d /Applications/Vellum.app/Contents/MacOS/Vellum",
        },
      ]),
    ).not.toThrow();
    expect(
      hasDebugAuthority([
        { pid: 1, ppid: 0, command: "Vellum --remote-debugging-port=9222" },
      ]),
    ).toBe(true);
    expect(
      hasDebugAuthority([{ pid: 1, ppid: 0, command: "Vellum --inspect-brk=0" }]),
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
        "/private/tmp/vellum-smoke-XXXXXX/home/.vellum/browser/control.sock",
      ),
    ).not.toThrow();
  });
});

describe("packaged runtime smoke child lifecycle", () => {
  it("records error-before-close without treating the error as terminal", async () => {
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const lifecycle = observeSpawnedRuntimeChild(child.asChild());
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
    const lifecycle = observeSpawnedRuntimeChild(child.asChild());
    const owned = admitChildProcess({ source: "packaged-smoke-test", child });
    child.onSignal = (signal) => {
      if (signal === "SIGTERM") child.emit("error", new Error("TERM delivery failed"));
    };

    try {
      const cleanup = terminateSpawnedRuntime(lifecycle, owned, "child", 1_000);
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
    } finally {
      releaseOwned(owned);
    }
  });

  it("forces a TERM-resistant child fallback only through its exact handle", async () => {
    vi.useFakeTimers();
    const child = new FakeRuntimeChild();
    const lifecycle = observeSpawnedRuntimeChild(child.asChild());
    const owned = admitChildProcess({ source: "packaged-smoke-test", child });
    child.onSignal = (signal) => {
      if (signal === "SIGKILL") child.close(null, "SIGKILL");
    };

    try {
      const cleanup = terminateSpawnedRuntime(lifecycle, owned, "child", 100);
      expect(child.signals).toEqual(["SIGTERM"]);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await cleanup;
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(lifecycle.terminal()).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseOwned(owned);
    }
  });
});
