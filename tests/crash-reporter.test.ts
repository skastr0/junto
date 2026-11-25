import { describe, expect, it } from "vitest";
import { crashReporterOptions, startCrashReporter, type CrashReporterStartOptions } from "../src/app/observability/crash-reporter";

describe("the local crash reporter", () => {
  it("starts for local dumps only, with no server to send to", () => {
    const options = crashReporterOptions("0.11.15");
    expect(options).toEqual({ uploadToServer: false, compress: false, extra: { juntoVersion: "0.11.15" } });
    // A submitURL is what Electron would upload to; its absence is the promise
    // that a minidump never leaves this machine.
    expect("submitURL" in options).toBe(false);
  });

  it("names the dump directory in the log and returns it", () => {
    const rows: Array<[string, string]> = [];
    let received: CrashReporterStartOptions | undefined;
    const boot = startCrashReporter({
      start: (options) => {
        received = options;
      },
      crashDumps: () => "/tmp/Crashpad",
      version: "0.11.15",
      write: (level, message) => rows.push([level, message]),
    });
    expect(received).toEqual(crashReporterOptions("0.11.15"));
    expect(boot.crashDumps).toBe("/tmp/Crashpad");
    expect(rows).toEqual([["info", "[crash] local minidumps land in /tmp/Crashpad"]]);
  });

  it("never throws when the reporter cannot start", () => {
    const rows: Array<[string, string]> = [];
    const boot = startCrashReporter({
      start: () => {
        throw new Error("crashpad is not there");
      },
      crashDumps: () => "/tmp/Crashpad",
      version: "0.11.15",
      write: (level, message) => rows.push([level, message]),
    });
    expect(boot.crashDumps).toBeUndefined();
    expect(rows).toEqual([["warn", "[crash] crash reporter did not start: crashpad is not there"]]);
  });

  it("keeps the started reporter when only the dump path is unreadable", () => {
    const rows: Array<[string, string]> = [];
    const boot = startCrashReporter({
      start: () => undefined,
      crashDumps: () => {
        throw new Error("no such path");
      },
      version: "0.11.15",
      write: (level, message) => rows.push([level, message]),
    });
    expect(boot.crashDumps).toBeUndefined();
    expect(rows).toEqual([["warn", "[crash] crash reporter started but its dump path is unreadable: no such path"]]);
  });
});
