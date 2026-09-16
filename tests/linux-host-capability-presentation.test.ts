import { describe, expect, it } from "vitest";
import type {
  LinuxHostCapabilityCheck,
  LinuxHostCapabilityFacts,
  LinuxHostCapabilityId,
  LinuxHostCapabilityObservation,
  LinuxHostCapabilityStatus,
  LinuxHostRemediation,
  LinuxHostRemediationAnchor,
} from "../src/shared/linux-host-capabilities";
import {
  LINUX_HOST_PREPARATION_URL,
  linuxHostCapabilityStatusLabel,
  linuxHostPreparationHref,
  presentLinuxHostCapabilities,
} from "../src/renderer/lib/linux-host-capability-presentation";

const findings =
  "docs/linux-host-preparation.md#how-are-host-findings-reported" as const;
const missingPackages =
  "docs/linux-host-preparation.md#missing-operating-system-packages" as const;
const sandbox =
  "docs/linux-host-preparation.md#apparmor-and-unprivileged-user-namespaces" as const;
const lingering =
  "docs/linux-host-preparation.md#user-lingering" as const;
const verification =
  "docs/linux-host-preparation.md#how-are-preparation-changes-verified-and-removed" as const;

const remediation = (
  anchor: LinuxHostRemediationAnchor,
  authority: LinuxHostRemediation["authority"] = "operator",
): LinuxHostRemediation => ({
  authority,
  anchor,
  summary: `Review ${anchor.slice(anchor.indexOf("#") + 1)}.`,
});

const readyCheck = (id: LinuxHostCapabilityId): LinuxHostCapabilityCheck => ({
  id,
  status: "ready",
  summary: `${id} ready`,
});

const nonReadyCheck = (
  id: LinuxHostCapabilityId,
  status: Exclude<LinuxHostCapabilityStatus, "ready">,
  anchor: LinuxHostRemediationAnchor,
): LinuxHostCapabilityCheck => ({
  id,
  status,
  summary: `${id} ${status}`,
  remediation: remediation(
    anchor,
    status === "requires-admin" ? "administrator" : "operator",
  ),
});

const readyChecks = (): ReadonlyArray<LinuxHostCapabilityCheck> => [
  readyCheck("core"),
  readyCheck("storage"),
  readyCheck("user-systemd"),
  readyCheck("persistence"),
  readyCheck("native-pty"),
  readyCheck("display"),
  readyCheck("sandbox"),
  readyCheck("secret-storage"),
];

const facts: LinuxHostCapabilityFacts = {
  probeVersion: 1,
  platform: "linux",
  osId: "ubuntu",
  osVersion: "24.04",
  architecture: "x64",
  glibcVersion: "2.39",
  home: "safe-writable",
  diskFreeMiB: 16_384,
  coreUserland: "ready",
  missingBinaries: [],
  runtimeLibraries: "ready",
  missingLibraries: [],
  userSystemd: "ready",
  remoteService: "active",
  linger: "enabled",
  ptmx: "ready",
  devpts: "ready",
  nativePty: "ready",
  xvfb: "present",
  xauth: "present",
  appArmor: "enforcing",
  appArmorProfile: "loaded",
  unprivilegedUserNamespaces: "ready",
  chromiumSandbox: "ready",
  secretStorage: "ready",
};

const readyObservation = (): LinuxHostCapabilityObservation => ({
  status: "ready",
  summary: "Core Station runtime is ready.",
  terminal: { status: "ready", summary: "Native PTY is ready." },
  browser: { status: "ready", summary: "Browser sandbox is ready." },
  checks: readyChecks(),
  facts,
});

describe("Linux host capability presentation", () => {
  it("keeps the five operator-facing capabilities ordered and fully ready", () => {
    const presentation = presentLinuxHostCapabilities(readyObservation());
    expect(presentation.summary).toBe(
      "Core Station ready - all requested host capabilities ready",
    );
    expect(presentation.optionalLimitCount).toBe(0);
    expect(
      presentation.capabilities.map(({ id, status }) => [id, status]),
    ).toEqual([
      ["core-station", "ready"],
      ["browser", "ready"],
      ["reboot-persistence", "ready"],
      ["native-pty", "ready"],
      ["secure-browser-credentials", "ready"],
    ]);
    expect(
      presentation.capabilities.every(
        (capability) =>
          capability.consequence === undefined &&
          capability.remediation === undefined,
      ),
    ).toBe(true);
  });

  it("does not turn optional limits into a generic Station failure", () => {
    const checks = readyChecks().map((check) => {
      switch (check.id) {
        case "persistence":
          return nonReadyCheck("persistence", "declined", lingering);
        case "native-pty":
          return nonReadyCheck("native-pty", "requires-admin", missingPackages);
        case "sandbox":
          return nonReadyCheck("sandbox", "unavailable", sandbox);
        case "secret-storage":
          return nonReadyCheck(
            "secret-storage",
            "misconfigured",
            verification,
          );
        default:
          return check;
      }
    });
    const observation: LinuxHostCapabilityObservation = {
      ...readyObservation(),
      terminal: {
        status: "requires-admin",
        summary: "Native PTY package is missing.",
        remediation: remediation(missingPackages, "administrator"),
      },
      browser: {
        status: "unavailable",
        summary: "No qualified Chromium sandbox is available.",
        remediation: remediation(sandbox),
      },
      checks,
    };

    const presentation = presentLinuxHostCapabilities(observation);
    expect(presentation.coreStatus).toBe("ready");
    expect(presentation.summary).toBe("Core Station ready - 4 optional limits");
    expect(presentation.summary).not.toMatch(/failed|not ready/iu);

    const nonReady = presentation.capabilities.filter(
      (capability) => capability.status !== "ready",
    );
    expect(nonReady).toHaveLength(4);
    for (const capability of nonReady) {
      expect(capability.consequence).toMatch(/\S/u);
      expect(capability.remediation?.summary).toMatch(/\S/u);
      expect(capability.remediation?.reference).toMatch(
        /^docs\/linux-host-preparation\.md#/u,
      );
      expect(capability.remediation?.href).toBe(
        `https://github.com/skastr0/junto/blob/main/${capability.remediation?.reference}`,
      );
    }
  });

  it("uses the core projection's exact remediation without inferring from checks", () => {
    const coreRemediation = remediation(findings);
    const observation: LinuxHostCapabilityObservation = {
      ...readyObservation(),
      status: "unavailable",
      summary: "Core Station cannot start on this host.",
      remediation: coreRemediation,
    };
    const core = presentLinuxHostCapabilities(observation).capabilities[0];
    expect(core).toMatchObject({
      id: "core-station",
      status: "unavailable",
      statusLabel: "Unavailable",
      consequence:
        "Install, update, and core Remote work remain unavailable on this host.",
      remediation: {
        authority: "operator",
        reference: findings,
      },
    });
  });

  it.each([
    ["ready", "Ready"],
    ["requires-admin", "Needs administrator"],
    ["declined", "Declined"],
    ["unavailable", "Unavailable"],
    ["misconfigured", "Misconfigured"],
  ] as const)("labels %s as %s", (status, label) => {
    expect(linuxHostCapabilityStatusLabel(status)).toBe(label);
  });

  it("turns only typed preparation references into the exact public docs URL", () => {
    expect(LINUX_HOST_PREPARATION_URL).toBe(
      "https://github.com/skastr0/junto/blob/main/docs/linux-host-preparation.md",
    );
    expect(linuxHostPreparationHref(sandbox)).toBe(
      `${LINUX_HOST_PREPARATION_URL}#apparmor-and-unprivileged-user-namespaces`,
    );
  });
});
