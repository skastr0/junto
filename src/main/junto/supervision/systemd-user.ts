import { Schema } from "effect";
import { readFileSync } from "node:fs";
import {
  JUNTO_SYSTEMD_USER_UNIT,
  showVellumSystemdUserUnit,
  startVellumSystemdUserUnit,
  systemdUserUnitTarget,
  type SystemctlFailureKind,
  type SystemctlRunResult,
} from "./systemctl-runner";
import {
  stationSupervisorFailure,
  type StationSupervisor,
  type StationSupervisorFailure,
  type StationSupervisorHandoff,
  type StationSupervisorMetadata,
  type StationSupervisorObservation,
} from "./contract";

/** User-relative destination for the generated, generation-pinned service. */
export const USERLAND_LINUX_SERVICE_PATH =
  ".config/systemd/user/junto-remote.service" as const;

const RELEASE_DIRECTORY = /^\/(?:[^/\u0000-\u001f\u007f]+\/)*\.junto\/runtime\/releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9a-f]{64}$/u;

const escapeSystemdArgument = (value: string): string =>
  Array.from(Buffer.from(value, "utf8"), (byte) =>
    (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      "/._:-".includes(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");

/**
 * Renders the only active Remote selector. Its paths are generation-pinned:
 * there is deliberately no `current` link or shell expansion in this unit.
 */
export const renderUserlandLinuxService = ({
  releaseDirectory,
}: {
  readonly releaseDirectory: string;
}): string => {
  if (!RELEASE_DIRECTORY.test(releaseDirectory)) {
    throw new Error("Linux Remote release directory is not a canonical immutable userland generation");
  }
  const release = escapeSystemdArgument(releaseDirectory);
  const launcher = `${release}/resources/systemd/junto-remote-launch`;
  const remote = `${release}/resources/bin/junto-remote`;
  return `[Unit]
Description=Junto Remote headless station
After=default.target
StartLimitIntervalSec=60
StartLimitBurst=3
ConditionFileIsExecutable=${remote}

[Service]
Type=notify
NotifyAccess=all
ExecStart=${launcher}
Restart=on-failure
RestartSec=5s
TimeoutStartSec=45s
TimeoutStopSec=20s
KillMode=mixed
UMask=0077
WorkingDirectory=%h
Environment=PATH=/usr/bin:/bin
Environment=HOME=%h
Environment=XDG_STATE_HOME=%h/.local/state
Environment=XDG_RUNTIME_DIR=%t
RuntimeDirectory=junto-remote
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
UnsetEnvironment=BASH_ENV BASHOPTS BUN_BE_BUN BUN_CONFIG_LINK_NATIVE_BINS BUN_CONFIG_VERBOSE_FETCH BUN_DEBUG_QUIET_LOGS BUN_INSTALL BUN_OPTIONS BUN_RUNTIME_TRANSPILER_CACHE_PATH CHROME_WRAPPER DISPLAY ELECTRON_OZONE_PLATFORM_HINT ELECTRON_RUN_AS_NODE ENV GCONV_PATH GI_TYPELIB_PATH GIO_EXTRA_MODULES GLIBC_TUNABLES GTK_MODULES HOSTALIASES IFS LD_ASSUME_KERNEL LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD LD_PROFILE LD_SHOW_AUXV LOCPATH MALLOC_TRACE NLSPATH NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE OZONE_PLATFORM PYTHONHOME PYTHONPATH QT_PLUGIN_PATH RESOLV_HOST_CONF SHELLOPTS TZDIR JUNTO_BROWSER_CAPABILITY JUNTO_BROWSER_HOME JUNTO_CANVASES_DIR JUNTO_E2E JUNTO_E2E_RENDERER_SURFACE_TIMEOUT_MS JUNTO_NODE_REF XAUTHORITY XDG_SESSION_TYPE
StandardOutput=null
StandardError=null
SyslogIdentifier=junto-remote

[Install]
WantedBy=default.target
`;
};

const SystemdStateToken = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
);
const SystemdMainPidText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(10)),
  Schema.check(Schema.isPattern(/^(0|[1-9]\d*)$/)),
);
const SystemdShowFields = Schema.Struct({
  LoadState: SystemdStateToken,
  ActiveState: SystemdStateToken,
  SubState: SystemdStateToken,
  MainPID: SystemdMainPidText,
  ControlGroup: Schema.String.pipe(Schema.check(Schema.isMaxLength(512))),
  InvocationID: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
});
type SystemdShowFields = typeof SystemdShowFields.Type;

const SystemdObservedPid = Schema.Number.pipe(Schema.check(Schema.isInt()), 
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 0x7fff_ffff })),
  Schema.brand("SystemdObservedPid"),
);
type SystemdObservedPid = typeof SystemdObservedPid.Type;

type ParsedSystemdShow =
  | {
    readonly kind: "fields";
    readonly fields: SystemdShowFields;
    readonly mainPid: SystemdObservedPid;
  }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const metadata: StationSupervisorMetadata = Object.freeze({
  provider: "systemd-user",
  displayName: "systemd user service",
  serviceLabel: JUNTO_SYSTEMD_USER_UNIT,
  recovery: Object.freeze({
    title: "Repair Junto Remote supervision",
    detail: "Install or repair the Junto Remote user service on this host.",
  }),
});

const expectedFields = new Set([
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "ControlGroup",
  "InvocationID",
]);

const currentCgroups = (): ReadonlySet<string> => {
  try {
    return new Set(readFileSync("/proc/self/cgroup", "utf8").split(/\r?\n/)
      .flatMap((line) => {
        const separator = line.indexOf("::");
        return separator < 0 ? [] : [line.slice(separator + 2)];
      })
      .filter((path) => path.startsWith("/")));
  } catch {
    return new Set();
  }
};

const parseSystemdShow = (stdout: string): ParsedSystemdShow => {
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== expectedFields.size || lines.some((line) => line === "")) {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned an incomplete or expanded property set",
    });
  }

  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return Object.freeze({
        kind: "invalid",
        diagnostic: "systemctl returned a malformed property line",
      });
    }
    const key = line.slice(0, separator);
    if (!expectedFields.has(key) || Object.hasOwn(fields, key)) {
      return Object.freeze({
        kind: "invalid",
        diagnostic: "systemctl returned an unknown or duplicate property",
      });
    }
    fields[key] = line.slice(separator + 1);
  }

  const decoded = Schema.decodeUnknownResult(SystemdShowFields)(fields);
  if (decoded._tag === "Failure") {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned invalid property values",
    });
  }
  if (
    decoded.success.ActiveState === "active" &&
    (!/^\/[\x21-\x7e]*$/.test(decoded.success.ControlGroup) ||
      !/^[0-9a-f]{32}$/.test(decoded.success.InvocationID))
  ) {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned invalid active service identity fields",
    });
  }
  const decodedPid = Schema.decodeUnknownResult(SystemdObservedPid)(
    Number(decoded.success.MainPID),
  );
  if (decodedPid._tag === "Failure") {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned an out-of-range MainPID",
    });
  }
  return Object.freeze({
    kind: "fields",
    fields: decoded.success,
    mainPid: decodedPid.success,
  });
};

const systemctlFailureKinds: Record<
  SystemctlFailureKind,
  StationSupervisorFailure["kind"]
> = {
  "invalid-target": "target-unavailable",
  "admission-refused": "admission-refused",
  "spawn-failed": "spawn-failed",
  "process-error": "process-error",
  "stdout-overflow": "output-overflow",
  "stderr-overflow": "output-overflow",
  deadline: "deadline",
  "exit-nonzero": "command-failed",
  "close-timeout": "close-unconfirmed",
};

const mapSystemctlFailure = (
  result: Extract<SystemctlRunResult, { readonly ok: false }>,
): StationSupervisorFailure => stationSupervisorFailure(
  systemctlFailureKinds[result.failure.kind],
  result.failure.diagnostic,
);

const canonicalAbsent = (
  parsed: Extract<ParsedSystemdShow, { readonly kind: "fields" }>,
): boolean => parsed.fields.LoadState === "not-found" &&
  parsed.fields.ActiveState === "inactive" &&
  parsed.fields.SubState === "dead" && parsed.mainPid === 0;

const classifySystemdShow = (
  parsed: Extract<ParsedSystemdShow, { readonly kind: "fields" }>,
  cgroups: ReadonlySet<string>,
): StationSupervisorObservation => {
  if (canonicalAbsent(parsed)) {
    return Object.freeze({
      provider: "systemd-user",
      state: "absent",
      ownership: "none",
    });
  }
  if (parsed.fields.LoadState !== "loaded") {
    return Object.freeze({
      provider: "systemd-user",
      state: "degraded",
      ownership: parsed.mainPid === 0 ? "none" : "unknown",
      failure: stationSupervisorFailure(
        "service-degraded",
        `systemd reports LoadState=${parsed.fields.LoadState}`,
      ),
    });
  }
  if (
    parsed.fields.ActiveState === "active" &&
    parsed.fields.SubState === "running" && parsed.mainPid > 0
  ) {
    return Object.freeze({
      provider: "systemd-user",
      state: "active",
      // MainPID names the shell wrapper. The exact cgroup is observation only:
      // it proves this Electron belongs to the invocation without minting any
      // process-signal authority from systemd's reported pid.
      ownership: cgroups.has(parsed.fields.ControlGroup) &&
          process.env.INVOCATION_ID === parsed.fields.InvocationID
        ? "current"
        : "other",
    });
  }
  if (parsed.fields.ActiveState === "inactive" && parsed.mainPid === 0) {
    return Object.freeze({
      provider: "systemd-user",
      state: "inactive",
      ownership: "none",
    });
  }
  return Object.freeze({
    provider: "systemd-user",
    state: "degraded",
    ownership: parsed.mainPid === 0 ? "none" : "unknown",
    failure: stationSupervisorFailure(
      "service-degraded",
      `systemd reports ActiveState=${parsed.fields.ActiveState}, SubState=${parsed.fields.SubState}`,
    ),
  });
};

const observeSystemdUserUnit = async (): Promise<
  StationSupervisorObservation
> => {
  const result = await showVellumSystemdUserUnit(systemdUserUnitTarget());
  if (!result.ok) {
    if (result.clean && result.failure.kind === "exit-nonzero") {
      const parsed = parseSystemdShow(result.stdout);
      if (parsed.kind === "fields" && canonicalAbsent(parsed)) {
        return classifySystemdShow(parsed, currentCgroups());
      }
    }
    return Object.freeze({
      provider: "systemd-user",
      state: "unknown",
      ownership: "unknown",
      failure: mapSystemctlFailure(result),
    });
  }

  const parsed = parseSystemdShow(result.stdout);
  if (parsed.kind === "invalid") {
    return Object.freeze({
      provider: "systemd-user",
      state: "degraded",
      ownership: "unknown",
      failure: stationSupervisorFailure("invalid-output", parsed.diagnostic),
    });
  }
  return classifySystemdShow(parsed, currentCgroups());
};

const requestSystemdUserHandoff = async (): Promise<
  StationSupervisorHandoff
> => {
  const result = await startVellumSystemdUserUnit(systemdUserUnitTarget());
  if (result.ok) {
    return Object.freeze({ provider: "systemd-user", accepted: true });
  }
  return Object.freeze({
    provider: "systemd-user",
    accepted: false,
    failure: mapSystemctlFailure(result),
  });
};

export const createSystemdUserStationSupervisor = (): StationSupervisor =>
  Object.freeze({
    metadata,
    observe: observeSystemdUserUnit,
    requestHandoff: requestSystemdUserHandoff,
  });
