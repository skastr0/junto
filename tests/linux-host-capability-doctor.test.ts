import { describe, expect, it } from "vitest";
import {
  observeLinuxHostCapabilityDoctor,
  parseLinuxHostCapabilityFacts,
  projectLinuxHostCapabilityObservation,
} from "../src/shared/linux-host-capability-doctor";
import type { LinuxHostCapabilityFacts } from "../src/shared/linux-host-capabilities";

const emit = (rows: ReadonlyArray<readonly [string, string]>): string =>
  rows.map(([key, value]) => `${key}=${value}`).join("\n") + "\n";

const readyProbeRows = (): Array<[string, string]> => [
  ["probe_version", "1"],
  ["platform", "linux"],
  ["architecture", "x86_64"],
  ["os_id", "ubuntu"],
  ["os_version", "24.04"],
  ["glibc_version", "2.39"],
  ["home", "safe-writable"],
  ["home_exec", "ready"],
  ["disk_free_mib", "16384"],
  ["core_userland", "ready"],
  ["missing_binaries", "none"],
  ["runtime_libraries", "ready"],
  ["missing_libraries", "none"],
  ["user_systemd", "ready"],
  ["remote_service", "active"],
  ["linger", "enabled"],
  ["ptmx", "ready"],
  ["devpts", "ready"],
  ["native_pty", "ready"],
  ["xvfb", "present"],
  ["xauth", "present"],
  ["mcookie", "present"],
  ["apparmor", "enforcing"],
  ["apparmor_profile", "loaded"],
  ["userns", "ready"],
  ["sandbox", "ready"],
  ["secret_storage", "ready"],
];

const readyStdout = (): string => emit(readyProbeRows());

const withRows = (
  overrides: ReadonlyArray<readonly [string, string]>,
): string => {
  const map = new Map(readyProbeRows());
  for (const [key, value] of overrides) map.set(key, value);
  return emit([...map.entries()]);
};

describe("parseLinuxHostCapabilityFacts", () => {
  it("parses a full closed probe record", () => {
    const facts = parseLinuxHostCapabilityFacts(readyStdout());
    expect(facts).toMatchObject({
      probeVersion: 1,
      platform: "linux",
      architecture: "x86_64",
      osId: "ubuntu",
      osVersion: "24.04",
      glibcVersion: "2.39",
      home: "safe-writable",
      diskFreeMiB: 16_384,
      coreUserland: "ready",
      missingBinaries: [],
      runtimeLibraries: "ready",
      missingLibraries: [],
      userSystemd: "ready",
      linger: "enabled",
      nativePty: "ready",
      xvfb: "present",
      chromiumSandbox: "ready",
      secretStorage: "ready",
    } satisfies Partial<LinuxHostCapabilityFacts>);
  });

  it("rejects incomplete or open-shape stdout", () => {
    expect(parseLinuxHostCapabilityFacts("")).toBeNull();
    expect(parseLinuxHostCapabilityFacts("platform=linux\n")).toBeNull();
    expect(
      parseLinuxHostCapabilityFacts(
        readyStdout().replace("probe_version=1", "probe_version=2"),
      ),
    ).toBeNull();
    expect(
      parseLinuxHostCapabilityFacts(
        readyStdout() + "evil_path=/home/user/secret\n",
      ),
    ).not.toBeNull(); // unknown keys are ignored; closed required set still holds
    expect(
      parseLinuxHostCapabilityFacts(
        withRows([["missing_binaries", "rm,-rf"]]),
      ),
    ).toBeNull();
  });

  it("accepts missing optional display binaries without failing parse", () => {
    const facts = parseLinuxHostCapabilityFacts(
      withRows([
        ["missing_binaries", "xvfb,xauth,mcookie"],
        ["xvfb", "missing"],
        ["xauth", "missing"],
        ["mcookie", "missing"],
      ]),
    );
    expect(facts?.missingBinaries).toEqual(["xvfb", "xauth", "mcookie"]);
    expect(facts?.xvfb).toBe("missing");
  });
});

describe("projectLinuxHostCapabilityObservation", () => {
  it("marks core ready without Xvfb and keeps browser unavailable", () => {
    const observation = observeLinuxHostCapabilityDoctor(
      withRows([
        ["missing_binaries", "xvfb,xauth,mcookie"],
        ["xvfb", "missing"],
        ["xauth", "missing"],
        ["mcookie", "missing"],
        ["sandbox", "unavailable"],
        ["secret_storage", "unavailable"],
        ["apparmor", "unavailable"],
        ["apparmor_profile", "not-required"],
        ["userns", "unavailable"],
      ]),
    );
    expect(observation).not.toBeNull();
    expect(observation!.status).toBe("ready");
    expect(observation!.summary).toMatch(/Core Station runtime is ready/i);
    expect(observation!.browser.status).toBe("unavailable");
    expect(observation!.browser.summary).toMatch(/not supported/i);
    expect(
      observation!.checks.find((check) => check.id === "display")?.status,
    ).toBe("requires-admin");
    expect(
      observation!.checks.find((check) => check.id === "sandbox")?.status,
    ).toBe("unavailable");
    expect(
      observation!.checks.find((check) => check.id === "secret-storage")
        ?.status,
    ).toBe("unavailable");
  });

  it("fails core when home is not safe-writable", () => {
    const observation = observeLinuxHostCapabilityDoctor(
      withRows([["home", "read-only"]]),
    );
    expect(observation!.status).toBe("requires-admin");
    expect(
      observation!.checks.find((check) => check.id === "storage")?.status,
    ).toBe("requires-admin");
    // Optional browser remains non-ready and must not be the core status.
    expect(observation!.browser.status).toBe("unavailable");
  });

  it("fails core on unsupported platform / distro / arch / glibc", () => {
    expect(
      observeLinuxHostCapabilityDoctor(
        withRows([["platform", "non-linux"]]),
      )!.status,
    ).toBe("unavailable");
    expect(
      observeLinuxHostCapabilityDoctor(
        withRows([
          ["os_id", "other"],
          ["os_version", "other"],
        ]),
      )!.status,
    ).toBe("unavailable");
    expect(
      observeLinuxHostCapabilityDoctor(
        withRows([["architecture", "aarch64"]]),
      )!.status,
    ).toBe("unavailable");
    expect(
      observeLinuxHostCapabilityDoctor(
        withRows([["glibc_version", "2.35"]]),
      )!.status,
    ).toBe("unavailable");
  });

  it("does not let disabled linger block core", () => {
    const observation = observeLinuxHostCapabilityDoctor(
      withRows([["linger", "disabled"]]),
    );
    expect(observation!.status).toBe("ready");
    const persistence = observation!.checks.find(
      (check) => check.id === "persistence",
    );
    expect(persistence?.status).toBe("requires-admin");
  });

  it("projects native-pty from ptmx/devpts without blocking core", () => {
    const observation = observeLinuxHostCapabilityDoctor(
      withRows([
        ["ptmx", "unavailable"],
        ["devpts", "unavailable"],
        ["native_pty", "unavailable"],
      ]),
    );
    expect(observation!.status).toBe("ready");
    expect(observation!.terminal.status).toBe("unavailable");
    expect(
      observation!.checks.find((check) => check.id === "native-pty")?.status,
    ).toBe("unavailable");
  });

  it("fails closed on sandbox and secret-storage for browser only", () => {
    const observation = projectLinuxHostCapabilityObservation(
      parseLinuxHostCapabilityFacts(
        withRows([
          ["sandbox", "misconfigured"],
          ["secret_storage", "headless"],
        ]),
      )!,
    );
    expect(observation.status).toBe("ready");
    expect(
      observation.checks.find((check) => check.id === "sandbox")?.status,
    ).toBe("misconfigured");
    expect(
      observation.checks.find((check) => check.id === "secret-storage")
        ?.status,
    ).toBe("unavailable");
    expect(observation.browser.status).toBe("unavailable");
  });

  it("requires user systemd for core readiness", () => {
    const observation = observeLinuxHostCapabilityDoctor(
      withRows([["user_systemd", "not-running"]]),
    );
    expect(observation!.status).toBe("requires-admin");
    expect(
      observation!.checks.find((check) => check.id === "user-systemd")
        ?.status,
    ).toBe("requires-admin");
  });

  it("emits exactly eight checks in the closed order", () => {
    const observation = observeLinuxHostCapabilityDoctor(readyStdout());
    expect(observation!.checks.map((check) => check.id)).toEqual([
      "core",
      "storage",
      "user-systemd",
      "persistence",
      "native-pty",
      "display",
      "sandbox",
      "secret-storage",
    ]);
  });
});
