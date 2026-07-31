/**
 * Pure Linux host-capability Doctor: parse closed probe stdout → project
 * product observations.
 *
 * Core Station readiness is independent of display, Chromium sandbox, secret
 * storage, and optional lingering. Browser is never ready in this beta.
 */

import { Either, Schema } from "effect";
import {
  LinuxHostCapabilityFacts,
  type LinuxHostCapabilityCheck,
  type LinuxHostCapabilityFacts as Facts,
  type LinuxHostCapabilityObservation,
  type LinuxHostCapabilityProjection,
  type LinuxHostRemediation,
  type LinuxHostRemediationAnchor,
} from "./linux-host-capabilities";

const FINDINGS =
  "docs/linux-host-preparation.md#how-are-host-findings-reported" as const satisfies LinuxHostRemediationAnchor;
const PACKAGES =
  "docs/linux-host-preparation.md#missing-operating-system-packages" as const satisfies LinuxHostRemediationAnchor;
const LINGER =
  "docs/linux-host-preparation.md#user-lingering" as const satisfies LinuxHostRemediationAnchor;
const DISPLAY =
  "docs/linux-host-preparation.md#remote-display-driver-xvfb-xauth-and-mcookie" as const satisfies LinuxHostRemediationAnchor;
const SANDBOX =
  "docs/linux-host-preparation.md#apparmor-and-unprivileged-user-namespaces" as const satisfies LinuxHostRemediationAnchor;
const VERIFICATION =
  "docs/linux-host-preparation.md#how-are-preparation-changes-verified-and-removed" as const satisfies LinuxHostRemediationAnchor;
const NO_GO =
  "docs/linux-host-preparation.md#no-go-list" as const satisfies LinuxHostRemediationAnchor;

/** Minimum free home disk space for core storage readiness (MiB). */
const MIN_DISK_FREE_MIB = 256;

const REQUIRED_KEYS = [
  "probe_version",
  "platform",
  "home",
  "core_userland",
  "runtime_libraries",
  "user_systemd",
  "remote_service",
  "linger",
  "ptmx",
  "devpts",
  "native_pty",
  "xvfb",
  "xauth",
  "apparmor",
  "apparmor_profile",
  "userns",
  "sandbox",
  "secret_storage",
] as const;

const BINARY_NAMES = new Set([
  "sh",
  "env",
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
  "secret-tool",
] as const);

const LIBRARY_NAMES = new Set([
  "libc",
  "libstdc++",
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
  "libxkbcommon",
] as const);

/** Core runtime libraries required for the signed Node Remote payload. */
const CORE_LIBRARIES = new Set(["libc", "libstdc++", "libgcc"]);

const decodeFacts = Schema.decodeUnknownEither(LinuxHostCapabilityFacts, {
  errors: "all",
  onExcessProperty: "error",
});

const remediation = (
  authority: LinuxHostRemediation["authority"],
  anchor: LinuxHostRemediationAnchor,
  summary: string,
): LinuxHostRemediation => ({
  authority,
  anchor,
  summary,
});

const readyCheck = (
  id: LinuxHostCapabilityCheck["id"],
  summary: string,
): LinuxHostCapabilityCheck => ({
  id,
  status: "ready",
  summary,
});

const nonReadyCheck = (
  id: LinuxHostCapabilityCheck["id"],
  status: Exclude<LinuxHostCapabilityCheck["status"], "ready">,
  summary: string,
  rem: LinuxHostRemediation,
): LinuxHostCapabilityCheck => ({
  id,
  status,
  summary,
  remediation: rem,
});

const readyProjection = (summary: string): LinuxHostCapabilityProjection => ({
  status: "ready",
  summary,
});

const nonReadyProjection = (
  status: Exclude<LinuxHostCapabilityProjection["status"], "ready">,
  summary: string,
  rem: LinuxHostRemediation,
): LinuxHostCapabilityProjection => ({
  status,
  summary,
  remediation: rem,
});

const parseKeyValueMap = (
  stdout: string,
): ReadonlyMap<string, string> | null => {
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  if (stdout.length > 64 * 1024) return null;
  const map = new Map<string, string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[a-z][a-z0-9_]{0,47}$/u.test(key)) return null;
    if (value.length === 0 || value.length > 256) return null;
    if (value.includes("\0")) return null;
    // Last write wins; duplicates are closed-protocol noise, not open injection.
    map.set(key, value);
  }
  for (const key of REQUIRED_KEYS) {
    if (!map.has(key)) return null;
  }
  return map;
};

const parseClosedList = <T extends string>(
  raw: string | undefined,
  allowed: ReadonlySet<T>,
): T[] | null => {
  if (raw === undefined || raw === "none") return [];
  if (raw.length === 0) return null;
  const parts = raw.split(",");
  if (parts.length > 32) return null;
  const out: T[] = [];
  for (const part of parts) {
    if (!allowed.has(part as T)) return null;
    if (!out.includes(part as T)) out.push(part as T);
  }
  return out;
};

const parseNonNegativeInt = (raw: string): number | undefined | null => {
  if (raw === "unknown") return undefined;
  if (!/^(0|[1-9][0-9]{0,8})$/u.test(raw)) return null;
  return Number(raw);
};

const optionalBounded = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw === "unknown" || raw.length === 0) {
    return undefined;
  }
  if (raw.length > 32) return undefined;
  return raw;
};

/**
 * Parse closed key=value doctor probe stdout into typed facts.
 * Returns null when the record is incomplete, unknown-keyed, or out of shape.
 */
export const parseLinuxHostCapabilityFacts = (
  stdout: string,
): Facts | null => {
  const map = parseKeyValueMap(stdout);
  if (map === null) return null;

  if (map.get("probe_version") !== "1") return null;

  const platform = map.get("platform");
  if (
    platform !== "linux" &&
    platform !== "non-linux" &&
    platform !== "unknown"
  ) {
    return null;
  }

  const home = map.get("home");
  if (
    home !== "safe-writable" &&
    home !== "read-only" &&
    home !== "unsafe" &&
    home !== "unknown"
  ) {
    return null;
  }

  const coreUserland = map.get("core_userland");
  if (
    coreUserland !== "ready" &&
    coreUserland !== "incomplete" &&
    coreUserland !== "unknown"
  ) {
    return null;
  }

  const missingBinaries = parseClosedList(
    map.get("missing_binaries"),
    BINARY_NAMES as ReadonlySet<
      | "sh"
      | "env"
      | "uname"
      | "id"
      | "stat"
      | "df"
      | "findmnt"
      | "systemctl"
      | "loginctl"
      | "getconf"
      | "ldconfig"
      | "ssh"
      | "xvfb"
      | "xauth"
      | "mcookie"
      | "unshare"
      | "secret-tool"
    >,
  );
  if (missingBinaries === null) return null;

  const runtimeLibraries = map.get("runtime_libraries");
  if (
    runtimeLibraries !== "ready" &&
    runtimeLibraries !== "incomplete" &&
    runtimeLibraries !== "unknown"
  ) {
    return null;
  }

  const missingLibraries = parseClosedList(
    map.get("missing_libraries"),
    LIBRARY_NAMES as ReadonlySet<
      | "libc"
      | "libstdc++"
      | "libgcc"
      | "libnss3"
      | "libatk"
      | "libatk-bridge"
      | "libcups"
      | "libdrm"
      | "libgbm"
      | "libgtk-3"
      | "libasound"
      | "libx11-xcb"
      | "libxcomposite"
      | "libxdamage"
      | "libxfixes"
      | "libxrandr"
      | "libxshmfence"
      | "libxkbcommon"
    >,
  );
  if (missingLibraries === null) return null;

  const userSystemd = map.get("user_systemd");
  if (
    userSystemd !== "ready" &&
    userSystemd !== "not-running" &&
    userSystemd !== "missing" &&
    userSystemd !== "unknown"
  ) {
    return null;
  }

  const remoteService = map.get("remote_service");
  if (
    remoteService !== "active" &&
    remoteService !== "inactive" &&
    remoteService !== "failed" &&
    remoteService !== "missing" &&
    remoteService !== "unknown"
  ) {
    return null;
  }

  const linger = map.get("linger");
  if (
    linger !== "enabled" &&
    linger !== "disabled" &&
    linger !== "unknown"
  ) {
    return null;
  }

  const ptmx = map.get("ptmx");
  if (
    ptmx !== "ready" &&
    ptmx !== "unavailable" &&
    ptmx !== "misconfigured" &&
    ptmx !== "unknown"
  ) {
    return null;
  }

  const devpts = map.get("devpts");
  if (
    devpts !== "ready" &&
    devpts !== "unavailable" &&
    devpts !== "misconfigured" &&
    devpts !== "unknown"
  ) {
    return null;
  }

  const nativePty = map.get("native_pty");
  if (
    nativePty !== "ready" &&
    nativePty !== "unavailable" &&
    nativePty !== "misconfigured" &&
    nativePty !== "unknown"
  ) {
    return null;
  }

  const xvfb = map.get("xvfb");
  if (xvfb !== "present" && xvfb !== "missing" && xvfb !== "unknown") {
    return null;
  }

  const xauth = map.get("xauth");
  if (xauth !== "present" && xauth !== "missing" && xauth !== "unknown") {
    return null;
  }

  const appArmor = map.get("apparmor");
  if (
    appArmor !== "enforcing" &&
    appArmor !== "available" &&
    appArmor !== "disabled" &&
    appArmor !== "unavailable" &&
    appArmor !== "unknown"
  ) {
    return null;
  }

  const appArmorProfile = map.get("apparmor_profile");
  if (
    appArmorProfile !== "loaded" &&
    appArmorProfile !== "missing" &&
    appArmorProfile !== "unreadable" &&
    appArmorProfile !== "not-required" &&
    appArmorProfile !== "unknown"
  ) {
    return null;
  }

  const userns = map.get("userns");
  if (
    userns !== "ready" &&
    userns !== "disabled" &&
    userns !== "unavailable" &&
    userns !== "unknown"
  ) {
    return null;
  }

  const sandbox = map.get("sandbox");
  if (
    sandbox !== "ready" &&
    sandbox !== "unavailable" &&
    sandbox !== "misconfigured" &&
    sandbox !== "unknown"
  ) {
    return null;
  }

  const secretStorage = map.get("secret_storage");
  if (
    secretStorage !== "ready" &&
    secretStorage !== "headless" &&
    secretStorage !== "unavailable" &&
    secretStorage !== "unknown"
  ) {
    return null;
  }

  const diskRaw = map.get("disk_free_mib");
  const diskFreeMiB =
    diskRaw === undefined ? undefined : parseNonNegativeInt(diskRaw);
  if (diskFreeMiB === null) return null;

  const candidate: Record<string, unknown> = {
    probeVersion: 1,
    platform,
    home,
    coreUserland,
    missingBinaries,
    runtimeLibraries,
    missingLibraries,
    userSystemd,
    remoteService,
    linger,
    ptmx,
    devpts,
    nativePty,
    xvfb,
    xauth,
    appArmor,
    appArmorProfile,
    unprivilegedUserNamespaces: userns,
    chromiumSandbox: sandbox,
    secretStorage,
  };

  const osId = optionalBounded(map.get("os_id"));
  if (osId !== undefined) candidate.osId = osId;
  const osVersion = optionalBounded(map.get("os_version"));
  if (osVersion !== undefined) candidate.osVersion = osVersion;
  const architecture = optionalBounded(map.get("architecture"));
  if (architecture !== undefined) candidate.architecture = architecture;
  const glibcVersion = optionalBounded(map.get("glibc_version"));
  if (glibcVersion !== undefined) candidate.glibcVersion = glibcVersion;
  if (diskFreeMiB !== undefined) candidate.diskFreeMiB = diskFreeMiB;

  const decoded = decodeFacts(candidate);
  return Either.isRight(decoded) ? decoded.right : null;
};

const compareGlibc = (version: string): number | null => {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.exec(
    version,
  );
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 2) return major - 2;
  return minor - 39;
};

const isSupportedArchitecture = (architecture: string | undefined): boolean =>
  architecture === "x86_64" ||
  architecture === "amd64" ||
  architecture === "x64";

const projectCoreCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.platform !== "linux") {
    return nonReadyCheck(
      "core",
      "unavailable",
      "Host is not a Linux kernel; Linux Remote requires Ubuntu on Linux.",
      remediation(
        "operator",
        FINDINGS,
        "Use a supported Ubuntu 24.04 x86-64 host for the Linux Remote.",
      ),
    );
  }

  if (facts.osId !== "ubuntu" || facts.osVersion !== "24.04") {
    return nonReadyCheck(
      "core",
      "unavailable",
      "Host distribution is outside the Ubuntu 24.04 LTS support envelope.",
      remediation(
        "operator",
        FINDINGS,
        "Install or enroll only Ubuntu 24.04 LTS x86-64 for this beta.",
      ),
    );
  }

  if (!isSupportedArchitecture(facts.architecture)) {
    return nonReadyCheck(
      "core",
      "unavailable",
      "Host CPU architecture is outside the x86-64 support envelope.",
      remediation(
        "operator",
        FINDINGS,
        "Use an x86-64 (amd64) host; other architectures are unsupported.",
      ),
    );
  }

  if (facts.glibcVersion === undefined) {
    return nonReadyCheck(
      "core",
      "unavailable",
      "glibc version could not be observed on this host.",
      remediation(
        "operator",
        FINDINGS,
        "Confirm the host runs glibc 2.39 or newer before installing the Remote.",
      ),
    );
  }

  const glibcCmp = compareGlibc(facts.glibcVersion);
  if (glibcCmp === null || glibcCmp < 0) {
    return nonReadyCheck(
      "core",
      "unavailable",
      `glibc ${facts.glibcVersion} is below the 2.39 minimum.`,
      remediation(
        "operator",
        FINDINGS,
        "Upgrade to Ubuntu 24.04 LTS (glibc 2.39+) or use a supported host.",
      ),
    );
  }

  if (facts.coreUserland !== "ready") {
    const missingCore = facts.missingBinaries.filter(
      (name) =>
        name !== "xvfb" &&
        name !== "xauth" &&
        name !== "mcookie" &&
        name !== "unshare" &&
        name !== "secret-tool" &&
        name !== "loginctl",
    );
    return nonReadyCheck(
      "core",
      facts.coreUserland === "unknown" ? "unavailable" : "requires-admin",
      missingCore.length > 0
        ? `Core userland binaries are incomplete (missing ${missingCore.join(", ")}).`
        : "Core userland binaries are incomplete on this host.",
      remediation(
        "administrator",
        PACKAGES,
        "Install the missing core userland packages outside Vellum Command, then re-run Doctor.",
      ),
    );
  }

  const missingCoreLibs = facts.missingLibraries.filter((name) =>
    CORE_LIBRARIES.has(name),
  );
  if (
    facts.runtimeLibraries === "incomplete" &&
    missingCoreLibs.length > 0
  ) {
    return nonReadyCheck(
      "core",
      "requires-admin",
      `Core runtime libraries are missing (${missingCoreLibs.join(", ")}).`,
      remediation(
        "administrator",
        PACKAGES,
        "Install the missing core libraries outside Vellum Command, then re-run Doctor.",
      ),
    );
  }

  if (facts.runtimeLibraries === "unknown") {
    return nonReadyCheck(
      "core",
      "unavailable",
      "Core runtime libraries could not be inventoried on this host.",
      remediation(
        "operator",
        FINDINGS,
        "Ensure ldconfig is available and re-run Doctor before install.",
      ),
    );
  }

  return readyCheck("core", "Supported Ubuntu 24.04 x86-64 core is ready.");
};

const projectStorageCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.home !== "safe-writable") {
    const status =
      facts.home === "read-only"
        ? "requires-admin"
        : facts.home === "unsafe"
          ? "misconfigured"
          : "unavailable";
    return nonReadyCheck(
      "storage",
      status,
      facts.home === "read-only"
        ? "Station home is not writable by the Station user."
        : facts.home === "unsafe"
          ? "Station home ownership or layout is unsafe for install."
          : "Station home could not be observed as a safe writable path.",
      remediation(
        facts.home === "read-only" ? "administrator" : "operator",
        FINDINGS,
        "Provide a Station-user-owned writable home before install or Remote work.",
      ),
    );
  }

  if (
    facts.diskFreeMiB !== undefined &&
    facts.diskFreeMiB < MIN_DISK_FREE_MIB
  ) {
    return nonReadyCheck(
      "storage",
      "requires-admin",
      `Home disk free space is ${facts.diskFreeMiB} MiB; need at least ${MIN_DISK_FREE_MIB} MiB.`,
      remediation(
        "administrator",
        PACKAGES,
        "Free disk space under the Station home, then re-run Doctor.",
      ),
    );
  }

  return readyCheck(
    "storage",
    "Station home is safe and writable with sufficient free space.",
  );
};

const projectUserSystemdCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.userSystemd === "ready") {
    return readyCheck("user-systemd", "User systemd is available for this login.");
  }
  if (facts.userSystemd === "not-running") {
    return nonReadyCheck(
      "user-systemd",
      "requires-admin",
      "User systemd is installed but not running for this login.",
      remediation(
        "administrator",
        FINDINGS,
        "Start a user session with systemd --user available, then re-run Doctor.",
      ),
    );
  }
  if (facts.userSystemd === "missing") {
    return nonReadyCheck(
      "user-systemd",
      "requires-admin",
      "systemctl is missing; user systemd cannot supervise the Remote.",
      remediation(
        "administrator",
        PACKAGES,
        "Install systemd user tools on the supported distribution outside Vellum Command.",
      ),
    );
  }
  return nonReadyCheck(
    "user-systemd",
    "unavailable",
    "User systemd state could not be observed.",
    remediation(
      "operator",
      FINDINGS,
      "Confirm systemctl --user works for the Station user, then re-run Doctor.",
    ),
  );
};

const projectPersistenceCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.linger === "enabled") {
    return readyCheck(
      "persistence",
      "User lingering is enabled for reboot persistence.",
    );
  }
  if (facts.linger === "disabled") {
    return nonReadyCheck(
      "persistence",
      "requires-admin",
      "User lingering is disabled; unattended reboot return is off.",
      remediation(
        "administrator",
        LINGER,
        "Enable lingering outside Vellum Command only if unattended reboot return is required.",
      ),
    );
  }
  return nonReadyCheck(
    "persistence",
    "unavailable",
    "User lingering could not be observed.",
    remediation(
      "operator",
      LINGER,
      "Confirm loginctl is available, then re-run Doctor.",
    ),
  );
};

const projectNativePtyCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  // Prefer the probe's native_pty synthesis; fall back to ptmx∧devpts.
  const state =
    facts.nativePty !== "unknown"
      ? facts.nativePty
      : facts.ptmx === "ready" && facts.devpts === "ready"
        ? "ready"
        : facts.ptmx === "misconfigured" || facts.devpts === "misconfigured"
          ? "misconfigured"
          : facts.ptmx === "unavailable" || facts.devpts === "unavailable"
            ? "unavailable"
            : "unknown";

  if (state === "ready") {
    return readyCheck(
      "native-pty",
      "Native PTY is available via /dev/ptmx and devpts.",
    );
  }
  if (state === "misconfigured") {
    return nonReadyCheck(
      "native-pty",
      "misconfigured",
      "PTY devices are present but not correctly configured for node-pty.",
      remediation(
        "administrator",
        VERIFICATION,
        "Repair /dev/ptmx permissions and the devpts mount, then re-run Doctor.",
      ),
    );
  }
  if (state === "unavailable") {
    return nonReadyCheck(
      "native-pty",
      "unavailable",
      "Native PTY is unavailable (/dev/ptmx or devpts missing).",
      remediation(
        "administrator",
        PACKAGES,
        "Provide a host with /dev/ptmx and a mounted devpts for native terminals.",
      ),
    );
  }
  return nonReadyCheck(
    "native-pty",
    "unavailable",
    "Native PTY state could not be observed.",
    remediation(
      "operator",
      FINDINGS,
      "Confirm /dev/ptmx and devpts are visible to the Station user.",
    ),
  );
};

const projectDisplayCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.xvfb === "present" && facts.xauth === "present") {
    return readyCheck(
      "display",
      "Host display tooling (Xvfb/xauth) is present.",
    );
  }
  if (facts.xvfb === "missing" || facts.xauth === "missing") {
    return nonReadyCheck(
      "display",
      "requires-admin",
      "Host display tooling is incomplete; browser surfaces stay off.",
      remediation(
        "administrator",
        DISPLAY,
        "Display packages are not required for core Node Remote in this beta.",
      ),
    );
  }
  return nonReadyCheck(
    "display",
    "unavailable",
    "Host display tooling could not be observed.",
    remediation(
      "operator",
      DISPLAY,
      "Display is optional for core Node Remote; browser remains unavailable.",
    ),
  );
};

const projectSandboxCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.chromiumSandbox === "ready") {
    return readyCheck(
      "sandbox",
      "Chromium sandbox prerequisites are satisfied.",
    );
  }
  if (facts.chromiumSandbox === "misconfigured") {
    return nonReadyCheck(
      "sandbox",
      "misconfigured",
      "Chromium sandbox path is present but misconfigured.",
      remediation(
        "administrator",
        SANDBOX,
        "Do not disable the sandbox; repair the qualified path outside Vellum Command.",
      ),
    );
  }
  if (facts.chromiumSandbox === "unavailable") {
    return nonReadyCheck(
      "sandbox",
      "unavailable",
      "No qualified Chromium sandbox path is available.",
      remediation(
        "administrator",
        SANDBOX,
        "Browser stays fail-closed until a qualified sandbox path exists.",
      ),
    );
  }
  return nonReadyCheck(
    "sandbox",
    "unavailable",
    "Chromium sandbox state could not be observed; treating as unavailable.",
    remediation(
      "operator",
      SANDBOX,
      "Browser stays fail-closed when sandbox evidence is incomplete.",
    ),
  );
};

const projectSecretStorageCheck = (facts: Facts): LinuxHostCapabilityCheck => {
  if (facts.secretStorage === "ready") {
    return readyCheck(
      "secret-storage",
      "Secret storage is available for browser credentials.",
    );
  }
  if (facts.secretStorage === "headless") {
    return nonReadyCheck(
      "secret-storage",
      "unavailable",
      "Secret tool is present but no session keyring is available (headless).",
      remediation(
        "operator",
        VERIFICATION,
        "Browser credential storage stays fail-closed without a live keyring.",
      ),
    );
  }
  if (facts.secretStorage === "unavailable") {
    return nonReadyCheck(
      "secret-storage",
      "unavailable",
      "Secret storage is unavailable on this host.",
      remediation(
        "administrator",
        PACKAGES,
        "Browser credential storage stays fail-closed without secret-tool/keyring.",
      ),
    );
  }
  return nonReadyCheck(
    "secret-storage",
    "unavailable",
    "Secret storage could not be observed; treating as unavailable.",
    remediation(
      "operator",
      VERIFICATION,
      "Browser credential storage stays fail-closed when evidence is incomplete.",
    ),
  );
};

const projectionFromCheck = (
  check: LinuxHostCapabilityCheck,
): LinuxHostCapabilityProjection =>
  check.status === "ready"
    ? readyProjection(check.summary)
    : nonReadyProjection(check.status, check.summary, check.remediation);

/**
 * Project typed facts into the operator-facing observation.
 *
 * Core status ignores display, sandbox, secret-storage, lingering, and PTY.
 * Browser is never ready in this beta (unavailable).
 */
export const projectLinuxHostCapabilityObservation = (
  facts: Facts,
): LinuxHostCapabilityObservation => {
  const core = projectCoreCheck(facts);
  const storage = projectStorageCheck(facts);
  const userSystemd = projectUserSystemdCheck(facts);
  const persistence = projectPersistenceCheck(facts);
  const nativePty = projectNativePtyCheck(facts);
  const display = projectDisplayCheck(facts);
  const sandbox = projectSandboxCheck(facts);
  const secretStorage = projectSecretStorageCheck(facts);

  const checks: readonly [
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
    LinuxHostCapabilityCheck,
  ] = [
    core,
    storage,
    userSystemd,
    persistence,
    nativePty,
    display,
    sandbox,
    secretStorage,
  ];

  // Browser is not shipped in first beta — always non-ready at the projection.
  const browser = nonReadyProjection(
    "unavailable",
    "Browser is not supported on Linux Remote in this beta.",
    remediation(
      "operator",
      NO_GO,
      "Core Node Remote continues without browser; do not install Xvfb for core.",
    ),
  );

  const terminal = projectionFromCheck(nativePty);

  const coreBlocking = [core, storage, userSystemd];
  const firstFailure = coreBlocking.find((check) => check.status !== "ready");
  if (firstFailure === undefined) {
    return {
      status: "ready",
      summary: "Core Station runtime is ready.",
      terminal,
      browser,
      checks,
      facts,
    };
  }

  return {
    status: firstFailure.status,
    summary: firstFailure.summary,
    remediation: firstFailure.remediation,
    terminal,
    browser,
    checks,
    facts,
  };
};

/**
 * Parse probe stdout and project an observation in one step.
 * Returns null when stdout is not a closed capability record.
 */
export const observeLinuxHostCapabilityDoctor = (
  stdout: string,
): LinuxHostCapabilityObservation | null => {
  const facts = parseLinuxHostCapabilityFacts(stdout);
  if (facts === null) return null;
  return projectLinuxHostCapabilityObservation(facts);
};
