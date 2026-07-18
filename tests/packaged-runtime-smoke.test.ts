import { describe, expect, it } from "vitest";
import {
  assertNoLiveVellumRuntime,
  assertNoTcpListeners,
  descendantRows,
  hasDebugAuthority,
  modeString,
  parseDoctorReceipt,
  parseProcessRows,
  processRoles,
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

  it("rejects live Vellum and debugger/CDP authority", () => {
    expect(() => assertNoLiveVellumRuntime(parseProcessRows(processFixture))).toThrow(
      /already running/u,
    );
    expect(() =>
      assertNoLiveVellumRuntime([
        { pid: 1, ppid: 0, command: "/Applications/Other.app/Contents/MacOS/Other" },
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
});
