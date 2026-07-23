import { Schema } from "effect";
import { readFileSync } from "node:fs";
import {
  VELLUM_SYSTEMD_USER_UNIT,
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

const SystemdStateToken = Schema.String.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z][a-z0-9-]*$/),
);
const SystemdMainPidText = Schema.String.pipe(
  Schema.maxLength(10),
  Schema.pattern(/^(0|[1-9]\d*)$/),
);
const SystemdShowFields = Schema.Struct({
  LoadState: SystemdStateToken,
  ActiveState: SystemdStateToken,
  SubState: SystemdStateToken,
  MainPID: SystemdMainPidText,
  ControlGroup: Schema.String.pipe(Schema.maxLength(512), Schema.pattern(/^\/[\x21-\x7e]*$/)),
  InvocationID: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/)),
});
type SystemdShowFields = typeof SystemdShowFields.Type;

const SystemdObservedPid = Schema.Int.pipe(
  Schema.between(0, 0x7fff_ffff),
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
  serviceLabel: VELLUM_SYSTEMD_USER_UNIT,
  recovery: Object.freeze({
    title: "Repair Vellum Remote supervision",
    detail: "Install or repair the Vellum Remote user service on this host.",
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

  const decoded = Schema.decodeUnknownEither(SystemdShowFields)(fields);
  if (decoded._tag === "Left") {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned invalid property values",
    });
  }
  const decodedPid = Schema.decodeUnknownEither(SystemdObservedPid)(
    Number(decoded.right.MainPID),
  );
  if (decodedPid._tag === "Left") {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "systemctl returned an out-of-range MainPID",
    });
  }
  return Object.freeze({
    kind: "fields",
    fields: decoded.right,
    mainPid: decodedPid.right,
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
