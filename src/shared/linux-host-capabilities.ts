import { Schema } from "effect";

const Summary = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(240)),
);
const BoundedFact = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(32)),
);
const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);

/**
 * Product-facing capability state. These values describe what Vellum Command can
 * safely do now; they are not aliases for shell exit codes.
 */
export const LinuxHostCapabilityStatus = Schema.Literals(["ready", "requires-admin",
"declined",
"unavailable",
"misconfigured",]);
export type LinuxHostCapabilityStatus =
  typeof LinuxHostCapabilityStatus.Type;

export const LinuxHostCapabilityId = Schema.Literals(["core", "storage",
"user-systemd",
"persistence",
"native-pty",
"display",
"sandbox",
"secret-storage",]);
export type LinuxHostCapabilityId = typeof LinuxHostCapabilityId.Type;

/**
 * Frozen documentation destinations for operator-facing findings. Keeping
 * this closed prevents a renderer from guessing a nearby but incorrect page.
 */
export const LinuxHostRemediationAnchor = Schema.Literals(["docs/linux-host-preparation.md#how-are-host-findings-reported", "docs/linux-host-preparation.md#apparmor-and-unprivileged-user-namespaces",
"docs/linux-host-preparation.md#user-lingering",
"docs/linux-host-preparation.md#missing-operating-system-packages",
"docs/linux-host-preparation.md#remote-display-driver-xvfb-xauth-and-mcookie",
"docs/linux-host-preparation.md#what-must-remediation-guidance-contain",
"docs/linux-host-preparation.md#how-are-preparation-changes-verified-and-removed",
"docs/linux-host-preparation.md#no-go-list",]);
export type LinuxHostRemediationAnchor =
  typeof LinuxHostRemediationAnchor.Type;

export const LinuxHostRemediation = Schema.Struct({
  authority: Schema.Literals(["operator", "administrator"]),
  anchor: LinuxHostRemediationAnchor,
  summary: Summary,
});
export type LinuxHostRemediation = typeof LinuxHostRemediation.Type;

const ReadyProjection = Schema.Struct({
  status: Schema.Literal("ready"),
  summary: Summary,
});
const NonReadyProjection = Schema.Struct({
  status: Schema.Literals(["requires-admin", "declined",
  "unavailable",
  "misconfigured",]),
  summary: Summary,
  remediation: LinuxHostRemediation,
});

/** A renderer-ready terminal/browser consequence, with no detail parsing. */
export const LinuxHostCapabilityProjection = Schema.Union([ReadyProjection,
NonReadyProjection,]);
export type LinuxHostCapabilityProjection =
  typeof LinuxHostCapabilityProjection.Type;

const ReadyCheck = Schema.Struct({
  id: LinuxHostCapabilityId,
  status: Schema.Literal("ready"),
  summary: Summary,
});
const NonReadyCheck = Schema.Struct({
  id: LinuxHostCapabilityId,
  status: Schema.Literals(["requires-admin", "declined",
  "unavailable",
  "misconfigured",]),
  summary: Summary,
  remediation: LinuxHostRemediation,
});

export const LinuxHostCapabilityCheck = Schema.Union([ReadyCheck,
NonReadyCheck,]);
export type LinuxHostCapabilityCheck =
  typeof LinuxHostCapabilityCheck.Type;

export const LinuxHostCapabilityFacts = Schema.Struct({
  probeVersion: Schema.Literal(1),
  platform: Schema.Literals(["linux", "non-linux", "unknown"]),
  osId: Schema.optionalKey(BoundedFact),
  osVersion: Schema.optionalKey(BoundedFact),
  architecture: Schema.optionalKey(BoundedFact),
  glibcVersion: Schema.optionalKey(BoundedFact),
  home: Schema.Literals(["safe-writable", "read-only",
  "unsafe",
  "unknown",]),
  diskFreeMiB: Schema.optionalKey(NonNegativeInteger),
  coreUserland: Schema.Literals(["ready", "incomplete", "unknown"]),
  missingBinaries: Schema.Array(
    Schema.Literals(["sh", "env",
    "uname",
    "id",
    "stat",
    "df",
    "findmnt",
    "systemctl",
    "loginctl",
    "getconf",
    "ldconfig",
    "ssh",
    "xvfb",
    "xauth",
    "mcookie",
    "unshare",
    "secret-tool",]),
  ).pipe(Schema.check(Schema.isMaxSize(17))),
  runtimeLibraries: Schema.Literals(["ready", "incomplete", "unknown"]),
  missingLibraries: Schema.Array(
    Schema.Literals(["libc", "libstdc++",
    "libgcc",
    "libnss3",
    "libatk",
    "libatk-bridge",
    "libcups",
    "libdrm",
    "libgbm",
    "libgtk-3",
    "libasound",
    "libx11-xcb",
    "libxcomposite",
    "libxdamage",
    "libxfixes",
    "libxrandr",
    "libxshmfence",
    "libxkbcommon",]),
  ).pipe(Schema.check(Schema.isMaxSize(18))),
  userSystemd: Schema.Literals(["ready", "not-running",
  "missing",
  "unknown",]),
  remoteService: Schema.Literals(["active", "inactive",
  "failed",
  "missing",
  "unknown",]),
  linger: Schema.Literals(["enabled", "disabled", "unknown"]),
  ptmx: Schema.Literals(["ready", "unavailable",
  "misconfigured",
  "unknown",]),
  devpts: Schema.Literals(["ready", "unavailable",
  "misconfigured",
  "unknown",]),
  nativePty: Schema.Literals(["ready", "unavailable",
  "misconfigured",
  "unknown",]),
  xvfb: Schema.Literals(["present", "missing", "unknown"]),
  xauth: Schema.Literals(["present", "missing", "unknown"]),
  appArmor: Schema.Literals(["enforcing", "available",
  "disabled",
  "unavailable",
  "unknown",]),
  appArmorProfile: Schema.Literals(["loaded", "missing",
  "unreadable",
  "not-required",
  "unknown",]),
  unprivilegedUserNamespaces: Schema.Literals(["ready", "disabled",
  "unavailable",
  "unknown",]),
  chromiumSandbox: Schema.Literals(["ready", "unavailable",
  "misconfigured",
  "unknown",]),
  secretStorage: Schema.Literals(["ready", "headless",
  "unavailable",
  "unknown",]),
});
export type LinuxHostCapabilityFacts =
  typeof LinuxHostCapabilityFacts.Type;

const ObservationDetails = {
  terminal: LinuxHostCapabilityProjection,
  browser: LinuxHostCapabilityProjection,
  checks: Schema.Array(LinuxHostCapabilityCheck).pipe(
    Schema.check(Schema.isMinSize(8)),
    Schema.check(Schema.isMaxSize(8)),
  ),
  facts: LinuxHostCapabilityFacts,
} as const;

/**
 * `status` summarizes only core Station readiness. Optional terminal/browser
 * limitations stay on their named projections and cannot erase a usable core.
 * A non-ready core summary always carries its exact remediation destination.
 */
export const LinuxHostCapabilityObservation = Schema.Union([Schema.Struct({
  status: Schema.Literal("ready"),
  summary: Summary,
  ...ObservationDetails,
}),
Schema.Struct({
  status: Schema.Literals(["requires-admin", "declined",
  "unavailable",
  "misconfigured",]),
  summary: Summary,
  remediation: LinuxHostRemediation,
  ...ObservationDetails,
}),]);
export type LinuxHostCapabilityObservation =
  typeof LinuxHostCapabilityObservation.Type;
