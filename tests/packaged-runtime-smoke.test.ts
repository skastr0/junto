import { describe, expect, it } from "vitest";
import {
  DARWIN_UNIX_SOCKET_PATH_MAX_BYTES,
  assertDarwinUnixSocketPathFits,
  assertNoLiveVellumRuntime,
  assertNoTcpListeners,
  boundedProcessKind,
  descendantRows,
  hasDebugAuthority,
  modeString,
  parseDoctorReceipt,
  parseProcessRows,
  processRoles,
  survivingProcessRows,
} from "../scripts/packaged-runtime-smoke";

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
