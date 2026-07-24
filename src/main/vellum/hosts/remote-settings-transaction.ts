import { posix } from "node:path";
import type { Context } from "effect";
import { Effect, Either } from "effect";
import {
  SETTINGS_MAX_FILE_BYTES,
  type StationSettings,
} from "@shared/settings";
import {
  mergeRemoteStationSettings,
  planRemoteStationConfig,
  remoteStationAlreadyConfigured,
  remoteStationSettingsFromScratch,
  type RemoteStationConfigInput,
} from "@shared/remote-station-config";
import type { RemoteHost } from "@shared/remote-hosts";
import { RemoteHostsError } from "@shared/remote-hosts";
import {
  makeRemoteStdin,
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, oneShotWithStdin } from "../ssh/program";
import { SshTransport } from "../ssh/service";
import {
  compileRemoteSettingsRestore,
  compileRemoteSettingsSnapshot,
  compileRemoteSettingsStamp,
  confineVellumDirectory,
  confineVellumLeaf,
} from "../ssh/remote-plan";
import { migrateSettingsDocument } from "../settings/migrate";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

type Ssh = Context.Tag.Service<typeof SshTransport>;

const RemoteSettingsSnapshotTypeId: unique symbol = Symbol(
  "@vellum/RemoteSettingsSnapshot",
);

/**
 * Opaque authority for restoring one exact remote settings path. Callers cannot
 * manufacture a path or turn the compensation operation into an ambient write.
 */
export interface RemoteSettingsSnapshot {
  readonly [RemoteSettingsSnapshotTypeId]: typeof RemoteSettingsSnapshotTypeId;
}

type SnapshotState = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly settingsPath: string;
  readonly existed: boolean;
  readonly mode: string;
  readonly bytes: Uint8Array;
};

const snapshotStates = new WeakMap<RemoteSettingsSnapshot, SnapshotState>();

const describeSshError = (error: unknown): string => {
  if (error && typeof error === "object" && "_tag" in error) {
    const ssh = error as SshError;
    if (ssh._tag === "SshTimeoutError") {
      return `SSH timed out after ${ssh.timeoutMs}ms`;
    }
    if (ssh._tag === "SshExitError") {
      return `remote settings operation exited ${ssh.code}`;
    }
    return ssh.message;
  }
  return error instanceof Error ? error.message : String(error);
};

const mintSnapshot = (state: SnapshotState): RemoteSettingsSnapshot => {
  const snapshot = Object.freeze({
    [RemoteSettingsSnapshotTypeId]: RemoteSettingsSnapshotTypeId,
  }) as RemoteSettingsSnapshot;
  snapshotStates.set(snapshot, state);
  return snapshot;
};

const parseSnapshotOutput = (
  host: RemoteHost,
  endpoint: string,
  settingsPath: string,
  output: string,
): RemoteSettingsSnapshot => {
  let state: SnapshotState;
  if (output === "ABSENT\n" || output === "ABSENT") {
    state = {
      hostId: host.id,
      endpoint,
      settingsPath,
      existed: false,
      mode: "600",
      bytes: new Uint8Array(),
    };
  } else {
    const newline = output.indexOf("\n");
    const header = newline >= 0 ? output.slice(0, newline) : output;
    const match = /^PRESENT ([0-7]{3,4}) ([0-9]+)$/u.exec(header);
    if (!match) {
      throw new RemoteHostsError(
        "io",
        `${host.label}: remote settings snapshot returned an invalid frame`,
      );
    }
    const declaredSize = Number(match[2]);
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > SETTINGS_MAX_FILE_BYTES
    ) {
      throw new RemoteHostsError(
        "io",
        `${host.label}: remote settings snapshot exceeded its byte boundary`,
      );
    }
    const encoded = output.slice(newline + 1).replaceAll(/\s/gu, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new RemoteHostsError(
        "io",
        `${host.label}: remote settings snapshot contained invalid base64`,
      );
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== declaredSize) {
      throw new RemoteHostsError(
        "io",
        `${host.label}: remote settings snapshot size did not match its frame`,
      );
    }
    state = {
      hostId: host.id,
      endpoint,
      settingsPath,
      existed: true,
      mode: match[1],
      bytes: Uint8Array.from(bytes),
    };
  }

  return mintSnapshot(state);
};

const stateOf = (snapshot: RemoteSettingsSnapshot): SnapshotState => {
  const state = snapshotStates.get(snapshot);
  if (!state) {
    throw new TypeError("RemoteSettingsSnapshot was not minted by Vellum");
  }
  return state;
};

export const captureRemoteSettingsSnapshot = (
  ssh: Ssh,
  host: RemoteHost,
): Effect.Effect<RemoteSettingsSnapshot, RemoteHostsError> =>
  Effect.gen(function* () {
    if (host.kind !== "remote" || !host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `host ${host.id} is not a remote SSH endpoint`,
        ),
      );
    }
    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const home = yield* ssh.run(homeDirectoryLookup(endpoint)).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            "io",
            `${host.label}: ${describeSshError(error)}`,
          ),
      ),
    );
    const remoteHome = decodeRemoteHomeDirectoryOutput(home.stdout);
    if (remoteHome === null) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "io",
          `${host.label}: remote home is not a canonical absolute path`,
        ),
      );
    }
    const vellumDir = yield* confineVellumDirectory(remoteHome).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const settingsLeaf = yield* confineVellumLeaf(vellumDir, "settings.json").pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const settingsPath = settingsLeaf.value;
    const command = yield* compileRemoteSettingsSnapshot(
      vellumDir,
      settingsLeaf,
      SETTINGS_MAX_FILE_BYTES,
    ).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const result = yield* ssh.run(
      oneShot(endpoint, command, { budget: "status" }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            "io",
            `${host.label}: settings snapshot failed — ${describeSshError(error)}`,
          ),
      ),
    );
    return parseSnapshotOutput(host, host.endpoint, settingsPath, result.stdout);
  });

export const remoteSettingsSnapshotsEqual = (
  left: RemoteSettingsSnapshot,
  right: RemoteSettingsSnapshot,
): boolean => {
  const a = stateOf(left);
  const b = stateOf(right);
  return (
    a.hostId === b.hostId &&
    a.endpoint === b.endpoint &&
    a.settingsPath === b.settingsPath &&
    a.existed === b.existed &&
    a.mode === b.mode &&
    Buffer.from(a.bytes).equals(Buffer.from(b.bytes))
  );
};

export const describeRemoteSettingsSnapshot = (
  snapshot: RemoteSettingsSnapshot,
): {
  readonly existed: boolean;
  readonly station?: {
    readonly role?: string;
    readonly hostId?: string;
    readonly agentHostId?: string;
    readonly commandCenterRef?: string;
  };
} => {
  const state = stateOf(snapshot);
  if (!state.existed) return { existed: false };
  try {
    const decoded = JSON.parse(Buffer.from(state.bytes).toString("utf8")) as {
      readonly station?: {
        readonly role?: unknown;
        readonly hostId?: unknown;
        readonly agentHostId?: unknown;
        readonly commandCenterRef?: unknown;
      };
    };
    const station = decoded.station;
    if (!station || typeof station !== "object") return { existed: true };
    return {
      existed: true,
      station: {
        ...(typeof station.role === "string" ? { role: station.role } : {}),
        ...(typeof station.hostId === "string" ? { hostId: station.hostId } : {}),
        ...(typeof station.agentHostId === "string"
          ? { agentHostId: station.agentHostId }
          : {}),
        ...(typeof station.commandCenterRef === "string"
          ? { commandCenterRef: station.commandCenterRef }
          : {}),
      },
    };
  } catch {
    return { existed: true };
  }
};

export type StampRemoteSettingsResult = {
  readonly snapshot: RemoteSettingsSnapshot;
  readonly detail: string;
  readonly station: StationSettings;
};

const plannedSettingsBody = (
  host: RemoteHost,
  before: SnapshotState,
  input: RemoteStationConfigInput,
): {
  readonly body: Uint8Array;
  readonly detail: string;
  readonly station: StationSettings;
  readonly alreadyConfigured: boolean;
} => {
  const plan = planRemoteStationConfig(input);
  let next = remoteStationSettingsFromScratch(input);
  if (before.existed && before.bytes.byteLength > 0) {
    let raw: string;
    let parsed: unknown;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(before.bytes);
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new RemoteHostsError(
        "validation",
        `${host.label}: remote settings.json is not valid UTF-8 JSON — fix or remove it before deploy`,
      );
    }
    const migrated = migrateSettingsDocument(parsed);
    if (Either.isLeft(migrated)) {
      throw new RemoteHostsError(
        migrated.left.code === "io" ? "io" : "validation",
        `${host.label}: remote settings unreadable — ${migrated.left.message}`,
      );
    }
    if (remoteStationAlreadyConfigured(migrated.right, input)) {
      return {
        body: before.bytes,
        detail: `${host.label}: already configured (${plan.summary})`,
        station: migrated.right.station,
        alreadyConfigured: true,
      };
    }
    next = mergeRemoteStationSettings(migrated.right, input);
  }
  const encoded = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (encoded.byteLength > SETTINGS_MAX_FILE_BYTES) {
    throw new RemoteHostsError(
      "validation",
      `remote settings document would exceed ${SETTINGS_MAX_FILE_BYTES} byte ceiling`,
    );
  }
  return {
    body: Uint8Array.from(encoded),
    detail: `${host.label} (${host.endpoint}): configured ${host.id}: ${plan.summary}`,
    station: next.station,
    alreadyConfigured: false,
  };
};

/**
 * Stamp the Remote role only if settings still equal the captured preimage.
 * The returned postimage is minted from the bytes acknowledged by the remote
 * CAS operation, so compensation never overwrites an edit made after capture.
 */
export const stampRemoteSettingsSnapshot = (
  ssh: Ssh,
  host: RemoteHost,
  original: RemoteSettingsSnapshot,
  input: RemoteStationConfigInput,
): Effect.Effect<StampRemoteSettingsResult, RemoteHostsError> =>
  Effect.gen(function* () {
    if (host.kind !== "remote" || !host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `host ${host.id} is not a remote SSH endpoint`,
        ),
      );
    }
    const before = stateOf(original);
    if (before.hostId !== host.id || before.endpoint !== host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "conflict",
          `${host.label}: settings stamp authority does not match the registered host`,
        ),
      );
    }
    const planned = yield* Effect.try({
      try: () => plannedSettingsBody(host, before, input),
      catch: (error) =>
        error instanceof RemoteHostsError
          ? error
          : new RemoteHostsError(
              "validation",
              error instanceof Error ? error.message : String(error),
            ),
    });
    if (planned.alreadyConfigured) {
      return {
        snapshot: original,
        detail: planned.detail,
        station: planned.station,
      };
    }

    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    // before.settingsPath is always <home>/.vellum/settings.json
    const vellumDir = yield* confineVellumDirectory(
      // settings path is always <home>/.vellum/settings.json
      before.settingsPath.endsWith("/.vellum/settings.json")
        ? before.settingsPath.slice(0, -("/.vellum/settings.json".length))
        : posix.dirname(posix.dirname(before.settingsPath)),
    ).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const settingsLeaf = yield* confineVellumLeaf(vellumDir, "settings.json").pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const command = yield* compileRemoteSettingsStamp(
      vellumDir,
      settingsLeaf,
      SETTINGS_MAX_FILE_BYTES,
    ).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const header = Buffer.from(
      [
        "vellum-settings-stamp-v1",
        before.existed ? "PRESENT" : "ABSENT",
        before.mode,
        String(before.bytes.byteLength),
        "600",
        String(planned.body.byteLength),
        "",
      ].join("\n"),
      "utf8",
    );
    const frame = Buffer.concat([
      header,
      Buffer.from(before.bytes),
      Buffer.from(planned.body),
    ]);
    const stdin = yield* makeRemoteStdin(Uint8Array.from(frame)).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const result = yield* ssh.run(
      oneShotWithStdin(endpoint, command, stdin, { budget: "standard" }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            error._tag === "SshExitError" && error.code === 34
              ? "conflict"
              : "io",
            `${host.label}: settings stamp could not be proven — ${describeSshError(error)}`,
          ),
      ),
    );
    if (result.stdout !== "STAMPED\n" && result.stdout !== "STAMPED") {
      return yield* Effect.fail(
        new RemoteHostsError(
          "io",
          `${host.label}: settings stamp did not return its completion receipt`,
        ),
      );
    }
    return {
      snapshot: mintSnapshot({
        ...before,
        existed: true,
        mode: "600",
        bytes: planned.body,
      }),
      detail: planned.detail,
      station: planned.station,
    };
  });

export const restoreRemoteSettingsSnapshot = (
  ssh: Ssh,
  host: RemoteHost,
  original: RemoteSettingsSnapshot,
  expectedCurrent: RemoteSettingsSnapshot,
): Effect.Effect<void, RemoteHostsError> =>
  Effect.gen(function* () {
    if (host.kind !== "remote" || !host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `host ${host.id} is not a remote SSH endpoint`,
        ),
      );
    }
    const before = stateOf(original);
    const expected = stateOf(expectedCurrent);
    if (
      before.hostId !== host.id ||
      expected.hostId !== host.id ||
      before.endpoint !== host.endpoint ||
      expected.endpoint !== host.endpoint ||
      before.settingsPath !== expected.settingsPath ||
      !expected.existed
    ) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "conflict",
          `${host.label}: settings rollback authority does not match the deployed host state`,
        ),
      );
    }

    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const vellumDir = yield* confineVellumDirectory(
      before.settingsPath.endsWith("/.vellum/settings.json")
        ? before.settingsPath.slice(0, -("/.vellum/settings.json".length))
        : posix.dirname(posix.dirname(before.settingsPath)),
    ).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const settingsLeaf = yield* confineVellumLeaf(vellumDir, "settings.json").pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const command = yield* compileRemoteSettingsRestore(
      vellumDir,
      settingsLeaf,
      SETTINGS_MAX_FILE_BYTES,
    ).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const header = Buffer.from(
      [
        "vellum-settings-rollback-v1",
        expected.mode,
        String(expected.bytes.byteLength),
        before.existed ? "PRESENT" : "ABSENT",
        before.mode,
        String(before.bytes.byteLength),
        "",
      ].join("\n"),
      "utf8",
    );
    const frame = Buffer.concat([
      header,
      Buffer.from(expected.bytes),
      Buffer.from(before.bytes),
    ]);
    const input = yield* makeRemoteStdin(Uint8Array.from(frame)).pipe(
      Effect.mapError(
        (error) => new RemoteHostsError("validation", error.message),
      ),
    );
    const result = yield* ssh.run(
      oneShotWithStdin(endpoint, command, input, { budget: "standard" }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            error._tag === "SshExitError" && error.code === 24
              ? "conflict"
              : "io",
            `${host.label}: settings rollback could not be proven — ${describeSshError(error)}`,
          ),
      ),
    );
    if (result.stdout.trim() !== "RESTORED") {
      return yield* Effect.fail(
        new RemoteHostsError(
          "io",
          `${host.label}: settings rollback did not return its completion receipt`,
        ),
      );
    }
  });
