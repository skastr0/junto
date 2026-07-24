import { posix } from "node:path";
import type { Context } from "effect";
import { Effect, Either } from "effect";
import type { StationSettings } from "@shared/settings";
import { SETTINGS_MAX_FILE_BYTES } from "@shared/settings";
import {
  planRemoteStationConfig,
  remoteStationAlreadyConfigured,
  remoteStationSettingsFromScratch,
  type RemoteStationConfigInput,
} from "@shared/remote-station-config";
import type { RemoteHost } from "@shared/remote-hosts";
import { hermesKeyFor, RemoteHostsError } from "@shared/remote-hosts";
import {
  makeRemoteStdin,
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, oneShotWithStdin } from "../ssh/program";
import { remoteCat } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import {
  compileRemotePlan,
  compileRemoteTopologyEvidencePresence,
  compileRemoteTopologySealPresence,
  confineVellumDirectory,
  confineVellumLeaf,
  remoteStationSettingsInstallPlan,
} from "../ssh/remote-plan";
import { migrateSettingsDocument } from "../settings/migrate";
import { configureRecordFromResult } from "@shared/station-status";
import { recordStationConfigure } from "../station-status-store";
import { stationSettingsWitness } from "../station-witness";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

// SSH install of ~/.vellum/settings.json on a registered remote host.
// Source of truth is the typed remote-plan AST — never a hand-authored script.

const PROBE_TIMEOUT_MS = 10_000;

type Ssh = Context.Tag.Service<typeof SshTransport>;

export type ConfigureRemoteResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly station?: StationSettings;
  readonly code?: "io" | "validation" | "not_found" | "conflict";
  readonly message?: string;
};

const classifySshFailure = (message: string): string => {
  if (/Permission denied|publickey|Authentication failed/i.test(message)) {
    return "Permission denied — check SSH keys / ssh-agent.";
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(message)) {
    return "Unknown host — add a Host entry in ~/.ssh/config or use a resolvable hostname.";
  }
  if (/Connection timed out|Operation timed out|ETIMEDOUT|ConnectTimeout/i.test(message)) {
    return "Timeout — host unreachable (VPN/Tailscale down, wrong endpoint, or firewall).";
  }
  if (/Host key verification failed/i.test(message)) {
    return "Host key rejected — verify fingerprint then `ssh-keygen -R <host>` if rebuilt.";
  }
  if (/Connection refused/i.test(message)) {
    return "Connection refused — sshd not listening, or wrong port.";
  }
  return message;
};

const describeSshError = (error: SshError): string => {
  switch (error._tag) {
    case "SshTimeoutError":
      return classifySshFailure(`Connection timed out after ${error.timeoutMs}ms`);
    case "SshExitError":
      return classifySshFailure(`ssh exited with code ${error.code}`);
    case "SshInputError":
      return `Invalid endpoint: ${error.message}`;
    default:
      return classifySshFailure(error.message);
  }
};

const formatUnknown = (error: unknown): string => {
  if (error && typeof error === "object" && "_tag" in error) {
    return describeSshError(error as SshError);
  }
  return error instanceof Error ? error.message : String(error);
};

const serializeSettingsBody = (settings: ReturnType<typeof remoteStationSettingsFromScratch>): string => {
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > SETTINGS_MAX_FILE_BYTES) {
    throw new RemoteHostsError(
      "validation",
      `remote settings document would exceed ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
    );
  }
  return body;
};

/**
 * Read remote settings.json when present. Missing file → defaults path in caller.
 * Non-zero cat (ENOENT) is treated as missing, not hard failure.
 */
const readRemoteSettingsRaw = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  settingsPath: string,
): Effect.Effect<string | null, never> =>
  remoteCat(settingsPath).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "status" }))),
    Effect.map((result) => result.stdout),
    Effect.catchAll(() => Effect.succeed(null as string | null)),
  );

const writeRemoteSettings = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remoteHome: string,
  body: string,
): Effect.Effect<void, SshError | RemoteHostsError> =>
  Effect.gen(function* () {
    const vellumDir = yield* confineVellumDirectory(remoteHome);
    const settingsPath = yield* confineVellumLeaf(vellumDir, "settings.json");
    const plan = remoteStationSettingsInstallPlan(vellumDir, settingsPath);
    const command = yield* compileRemotePlan(plan);
    const input = yield* makeRemoteStdin(body);
    yield* ssh.run(oneShotWithStdin(endpoint, command, input, { budget: "standard" }));
  }).pipe(
    Effect.mapError((error): SshError | RemoteHostsError => {
      if (error instanceof RemoteHostsError) return error;
      return error as SshError;
    }),
  );

/**
 * Remote "already configured" requires topology.key + topology.seal as regular
 * files. Absent / symlink / asymmetric is not success.
 */
const probeRemoteTopologySealed = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remoteHome: string,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const vellumDir = yield* confineVellumDirectory(remoteHome);
    const command = yield* compileRemoteTopologySealPresence(vellumDir);
    const result = yield* ssh.run(oneShot(endpoint, command, { budget: "status" }));
    const out = result.stdout.trim();
    return out === "SEALED";
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));

/**
 * Any topology seal footprint (key and/or seal, including partial/asymmetric).
 * Probe failure → fail closed (assume evidence present).
 */
const probeRemoteTopologyEvidence = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  remoteHome: string,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const vellumDir = yield* confineVellumDirectory(remoteHome);
    const command = yield* compileRemoteTopologyEvidencePresence(vellumDir);
    const result = yield* ssh.run(oneShot(endpoint, command, { budget: "status" }));
    return result.stdout.trim() !== "ABSENT";
  }).pipe(Effect.catchAll(() => Effect.succeed(true)));

const probeRemoteStation = (
  ssh: Ssh,
  endpoint: Parameters<typeof oneShot>[0],
  settingsPath: string,
  input: RemoteStationConfigInput,
): Effect.Effect<
  { readonly ok: boolean; readonly detail: string; readonly station?: StationSettings },
  never
> =>
  remoteCat(settingsPath).pipe(
    Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget: "status" }))),
    Effect.map((result) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout) as unknown;
      } catch {
        return {
          ok: false as const,
          detail: "wrote settings but remote file is not valid JSON",
        };
      }
      const migrated = migrateSettingsDocument(parsed);
      if (Either.isLeft(migrated)) {
        return {
          ok: false as const,
          detail: `wrote settings but remote document failed decode: ${migrated.left.message}`,
        };
      }
      if (!remoteStationAlreadyConfigured(migrated.right, input)) {
        const s = migrated.right.station;
        return {
          ok: false as const,
          detail: `probe mismatch: remote station role=${s.role} hostId=${s.hostId} commandCenterRef=${s.commandCenterRef}`,
          station: s,
        };
      }
      return {
        ok: true as const,
        detail: `configured ${input.remoteHostId}: ${planRemoteStationConfig(input).summary}`,
        station: migrated.right.station,
      };
    }),
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false as const,
        detail: `wrote settings but probe failed: ${formatUnknown(error)}`,
      }),
    ),
  );

/**
 * Configure a registered remote host as a Vellum Remote station over existing SSH.
 *
 * Beta contract: **enroll fresh Remote only on pristine topology** — never
 * overwrite an existing settings document or seal footprint. Idempotent when
 * remote already matches the planned stamp **and** topology seals are present.
 *
 * Residual: still stamps `settings.json` directly (pending-remote-v1 enrollment
 * artifact + first-boot admit not yet wired). Deploy CAS stamp path is separate.
 */
export const configureRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  options: {
    readonly commandCenterRef: string;
    readonly supervisedPreferred?: boolean;
    /** A larger deploy transaction records only its final durable outcome. */
    readonly recordStatus?: boolean;
  },
): Effect.Effect<ConfigureRemoteResult, RemoteHostsError> =>
  Effect.gen(function* () {
    if (host.kind !== "remote") {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `host ${host.id} is local — only remote hosts can be configured as Remote`,
        ),
      );
    }
    if (!host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError("validation", `remote host ${host.id} missing endpoint`),
      );
    }

    let planInput: RemoteStationConfigInput;
    let plan: ReturnType<typeof planRemoteStationConfig>;
    try {
      planInput = {
        remoteHostId: host.id,
        agentHostId: hermesKeyFor(host),
        commandCenterRef: options.commandCenterRef,
        supervisedPreferred: options.supervisedPreferred ?? true,
      };
      plan = planRemoteStationConfig(planInput);
    } catch (error) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError("validation", `Invalid endpoint: ${error.message}`),
      ),
    );

    yield* ssh.warm(endpoint).pipe(
      Effect.timeoutFail({
        duration: PROBE_TIMEOUT_MS,
        onTimeout: () =>
          new RemoteHostsError(
            "io",
            `${host.label}: SSH warm timed out after ${PROBE_TIMEOUT_MS}ms`,
          ),
      }),
      Effect.mapError((error) =>
        error instanceof RemoteHostsError
          ? error
          : new RemoteHostsError("io", `${host.label}: ${formatUnknown(error)}`),
      ),
    );

    const homeResult = yield* ssh.run(homeDirectoryLookup(endpoint)).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError("io", `${host.label}: ${formatUnknown(error)}`),
      ),
    );
    const homePath = decodeRemoteHomeDirectoryOutput(homeResult.stdout);
    if (homePath === null) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "io",
          `${host.id}: remote home response must be exactly one canonical absolute path followed by LF (got ${JSON.stringify(homeResult.stdout)})`,
        ),
      );
    }

    const dirPath = posix.join(homePath, ".vellum");
    const settingsPath = posix.join(dirPath, "settings.json");

    const raw = yield* readRemoteSettingsRaw(ssh, endpoint, settingsPath);
    if (raw !== null && raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return {
          ok: false,
          detail: `${host.label}: remote settings.json is not valid JSON — refuse enroll (not pristine); fix or remove before configure`,
          code: "validation" as const,
          message: "remote settings.json is not valid JSON",
        } satisfies ConfigureRemoteResult;
      }
      const migrated = migrateSettingsDocument(parsed);
      if (Either.isLeft(migrated)) {
        return {
          ok: false,
          detail: `${host.label}: remote settings unreadable — refuse enroll (not pristine): ${migrated.left.message}`,
          code: migrated.left.code === "io" ? "io" : "validation",
          message: migrated.left.message,
        } satisfies ConfigureRemoteResult;
      }
      if (remoteStationAlreadyConfigured(migrated.right, planInput)) {
        const sealed = yield* probeRemoteTopologySealed(ssh, endpoint, homePath);
        if (sealed) {
          const okResult = {
            ok: true as const,
            detail: `${host.label}: already configured (${plan.summary})`,
            station: migrated.right.station,
          } satisfies ConfigureRemoteResult;
          if (options.recordStatus !== false) {
            yield* Effect.promise(() =>
              recordStationConfigure(
                configureRecordFromResult({
                  ok: true,
                  hostId: host.id,
                  detail: okResult.detail,
                  stationWitness: stationSettingsWitness(migrated.right.station),
                }),
              ).catch(() => undefined),
            );
          }
          return okResult;
        }
        // Settings match but seals incomplete — not pristine; do not re-stamp.
        return {
          ok: false,
          detail: `${host.label}: remote settings match plan but topology seals are incomplete — refuse overwrite; restore seals or wipe to a pristine install`,
          code: "conflict" as const,
          message: "remote topology seals incomplete; refuse enroll overwrite",
          station: migrated.right.station,
        } satisfies ConfigureRemoteResult;
      }
      // Existing non-matching settings — never merge/overwrite.
      return {
        ok: false,
        detail: `${host.label}: remote already has settings.json — refuse enroll overwrite (fresh Remote requires pristine topology)`,
        code: "conflict" as const,
        message: "remote settings already present; refuse enroll overwrite",
        station: migrated.right.station,
      } satisfies ConfigureRemoteResult;
    }

    // Settings absent: still refuse when key/seal evidence remains.
    const hasEvidence = yield* probeRemoteTopologyEvidence(ssh, endpoint, homePath);
    if (hasEvidence) {
      return {
        ok: false,
        detail: `${host.label}: remote has topology.key/seal evidence without settings — refuse enroll (not pristine)`,
        code: "conflict" as const,
        message: "remote topology evidence present; refuse enroll overwrite",
      } satisfies ConfigureRemoteResult;
    }

    const nextSettings = remoteStationSettingsFromScratch(planInput);
    let body: string;
    try {
      body = serializeSettingsBody(nextSettings);
    } catch (error) {
      return yield* Effect.fail(
        error instanceof RemoteHostsError
          ? error
          : new RemoteHostsError("validation", String(error)),
      );
    }

    yield* writeRemoteSettings(ssh, endpoint, homePath, body).pipe(
      Effect.mapError((error) =>
        error instanceof RemoteHostsError
          ? error
          : new RemoteHostsError("io", `${host.label}: write failed — ${formatUnknown(error)}`),
      ),
    );

    const probe = yield* probeRemoteStation(ssh, endpoint, settingsPath, planInput);
    if (!probe.ok) {
      const failed = {
        ok: false as const,
        detail: `${host.label}: ${probe.detail}`,
        station: probe.station,
        code: "io" as const,
        message: probe.detail,
      } satisfies ConfigureRemoteResult;
      if (options.recordStatus !== false) {
        yield* Effect.promise(() =>
          recordStationConfigure(
            configureRecordFromResult({
              ok: false,
              hostId: host.id,
              detail: failed.detail,
            }),
          ).catch(() => undefined),
        );
      }
      return failed;
    }

    const configuredStation = probe.station ?? plan.station;
    const okResult = {
      ok: true as const,
      detail: `${host.label} (${host.endpoint}): ${probe.detail}`,
      station: configuredStation,
    } satisfies ConfigureRemoteResult;
    if (options.recordStatus !== false) {
      yield* Effect.promise(() =>
        recordStationConfigure(
          configureRecordFromResult({
            ok: true,
            hostId: host.id,
            detail: okResult.detail,
            stationWitness: stationSettingsWitness(configuredStation),
          }),
        ).catch(() => undefined),
      );
    }
    return okResult;
  }).pipe(
    Effect.catchAll((error) => {
      if (error instanceof RemoteHostsError) {
        return Effect.fail(error);
      }
      return Effect.succeed({
        ok: false,
        detail: formatUnknown(error),
        code: "io" as const,
        message: formatUnknown(error),
      } satisfies ConfigureRemoteResult);
    }),
  );
