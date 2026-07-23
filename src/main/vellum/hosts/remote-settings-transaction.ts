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
  makeRemoteCommand,
  makeRemoteStdin,
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, oneShotWithStdin } from "../ssh/program";
import { SshTransport } from "../ssh/service";
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

const SNAPSHOT_SCRIPT = `
set -eu
DIR="$1"
SETTINGS="$2"
LIMIT="$3"
if [ -L "$DIR" ]; then
  echo "SETTINGS_DIR_IS_SYMLINK" >&2
  exit 11
fi
if [ ! -e "$SETTINGS" ] && [ ! -L "$SETTINGS" ]; then
  /usr/bin/printf 'ABSENT\n'
  exit 0
fi
if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then
  echo "SETTINGS_PATH_NOT_REGULAR" >&2
  exit 12
fi
MODE="$(/usr/bin/stat -f '%Lp' "$SETTINGS" 2>/dev/null || /usr/bin/stat -c '%a' "$SETTINGS" 2>/dev/null)"
case "$MODE" in
  [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
  *) echo "SETTINGS_MODE_UNREADABLE" >&2; exit 13 ;;
esac
BYTES="$(/usr/bin/wc -c < "$SETTINGS" | /usr/bin/tr -d ' ')"
case "$BYTES" in
  ''|*[!0-9]*) echo "SETTINGS_SIZE_UNREADABLE" >&2; exit 13 ;;
esac
if [ "$BYTES" -gt "$LIMIT" ]; then
  echo "SETTINGS_TOO_LARGE" >&2
  exit 14
fi
/usr/bin/printf 'PRESENT %s %s\n' "$MODE" "$BYTES"
/usr/bin/base64 < "$SETTINGS"
`.trim();

const STAMP_SCRIPT = `
set -eu
DIR="$1"
SETTINGS="$2"
LIMIT="$3"
IFS= read -r FRAME_VERSION
IFS= read -r EXPECTED_KIND
IFS= read -r EXPECTED_MODE
IFS= read -r EXPECTED_SIZE
IFS= read -r NEXT_MODE
IFS= read -r NEXT_SIZE
[ "$FRAME_VERSION" = "vellum-settings-stamp-v1" ] || exit 32
case "$EXPECTED_KIND" in PRESENT|ABSENT) ;; *) exit 32 ;; esac
case "$EXPECTED_MODE:$NEXT_MODE" in
  [0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]) ;;
  *) exit 32 ;;
esac
case "$EXPECTED_SIZE:$NEXT_SIZE" in
  *[!0-9:]*|:*|*:) exit 32 ;;
esac
[ "$EXPECTED_SIZE" -le "$LIMIT" ] && [ "$NEXT_SIZE" -le "$LIMIT" ] || exit 32
if [ -L "$DIR" ]; then
  echo "SETTINGS_DIR_UNSAFE" >&2
  exit 33
fi
/bin/mkdir -p "$DIR"
if [ -L "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "SETTINGS_DIR_UNSAFE" >&2
  exit 33
fi
EXPECTED_TMP="$(/usr/bin/mktemp "$SETTINGS.stamp-expected.XXXXXX")"
NEXT_TMP="$(/usr/bin/mktemp "$SETTINGS.stamp-next.XXXXXX")"
cleanup_settings_stamp() {
  /bin/rm -f -- "$EXPECTED_TMP" "$NEXT_TMP"
}
trap cleanup_settings_stamp EXIT HUP INT TERM
/bin/dd bs=1 count="$EXPECTED_SIZE" of="$EXPECTED_TMP" 2>/dev/null
/bin/dd bs=1 count="$NEXT_SIZE" of="$NEXT_TMP" 2>/dev/null
EXPECTED_READ="$(/usr/bin/wc -c < "$EXPECTED_TMP" | /usr/bin/tr -d ' ')"
NEXT_READ="$(/usr/bin/wc -c < "$NEXT_TMP" | /usr/bin/tr -d ' ')"
[ "$EXPECTED_READ" = "$EXPECTED_SIZE" ] && [ "$NEXT_READ" = "$NEXT_SIZE" ] || exit 32
TRAILING="$(/bin/dd bs=1 count=1 2>/dev/null | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
[ "$TRAILING" = "0" ] || exit 32
if [ "$EXPECTED_KIND" = "PRESENT" ]; then
  if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then
    echo "SETTINGS_CHANGED_BEFORE_STAMP" >&2
    exit 34
  fi
  CURRENT_MODE="$(/usr/bin/stat -f '%Lp' "$SETTINGS" 2>/dev/null || /usr/bin/stat -c '%a' "$SETTINGS" 2>/dev/null)"
  [ "$CURRENT_MODE" = "$EXPECTED_MODE" ] || {
    echo "SETTINGS_CHANGED_BEFORE_STAMP" >&2
    exit 34
  }
  /usr/bin/cmp -s "$SETTINGS" "$EXPECTED_TMP" || {
    echo "SETTINGS_CHANGED_BEFORE_STAMP" >&2
    exit 34
  }
else
  [ "$EXPECTED_SIZE" = "0" ] || exit 32
  if [ -e "$SETTINGS" ] || [ -L "$SETTINGS" ]; then
    echo "SETTINGS_CHANGED_BEFORE_STAMP" >&2
    exit 34
  fi
fi
/bin/chmod "$NEXT_MODE" "$NEXT_TMP"
/bin/mv -f "$NEXT_TMP" "$SETTINGS"
/usr/bin/printf 'STAMPED\n'
`.trim();

const RESTORE_SCRIPT = `
set -eu
DIR="$1"
SETTINGS="$2"
LIMIT="$3"
if [ -L "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "SETTINGS_DIR_UNSAFE" >&2
  exit 21
fi
IFS= read -r FRAME_VERSION
IFS= read -r EXPECTED_MODE
IFS= read -r EXPECTED_SIZE
IFS= read -r ORIGINAL_KIND
IFS= read -r ORIGINAL_MODE
IFS= read -r ORIGINAL_SIZE
[ "$FRAME_VERSION" = "vellum-settings-rollback-v1" ] || exit 22
case "$EXPECTED_SIZE:$ORIGINAL_SIZE" in
  *[!0-9:]*|:*|*:) exit 22 ;;
esac
case "$ORIGINAL_KIND" in PRESENT|ABSENT) ;; *) exit 22 ;; esac
case "$EXPECTED_MODE:$ORIGINAL_MODE" in
  [0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]) ;;
  *) exit 22 ;;
esac
case "$ORIGINAL_MODE" in
  [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
  *) exit 22 ;;
esac
[ "$EXPECTED_SIZE" -le "$LIMIT" ] && [ "$ORIGINAL_SIZE" -le "$LIMIT" ] || exit 22
EXPECTED_TMP="$(/usr/bin/mktemp "$SETTINGS.rollback-expected.XXXXXX")"
ORIGINAL_TMP="$(/usr/bin/mktemp "$SETTINGS.rollback-original.XXXXXX")"
cleanup_settings_rollback() {
  /bin/rm -f -- "$EXPECTED_TMP" "$ORIGINAL_TMP"
}
trap cleanup_settings_rollback EXIT HUP INT TERM
/bin/dd bs=1 count="$EXPECTED_SIZE" of="$EXPECTED_TMP" 2>/dev/null
/bin/dd bs=1 count="$ORIGINAL_SIZE" of="$ORIGINAL_TMP" 2>/dev/null
EXPECTED_READ="$(/usr/bin/wc -c < "$EXPECTED_TMP" | /usr/bin/tr -d ' ')"
ORIGINAL_READ="$(/usr/bin/wc -c < "$ORIGINAL_TMP" | /usr/bin/tr -d ' ')"
[ "$EXPECTED_READ" = "$EXPECTED_SIZE" ] && [ "$ORIGINAL_READ" = "$ORIGINAL_SIZE" ] || exit 22
TRAILING="$(/bin/dd bs=1 count=1 2>/dev/null | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
[ "$TRAILING" = "0" ] || exit 22
if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then
  echo "SETTINGS_COMPARE_TARGET_UNSAFE" >&2
  exit 23
fi
CURRENT_MODE="$(/usr/bin/stat -f '%Lp' "$SETTINGS" 2>/dev/null || /usr/bin/stat -c '%a' "$SETTINGS" 2>/dev/null)"
[ "$CURRENT_MODE" = "$EXPECTED_MODE" ] || {
  echo "SETTINGS_CHANGED_SINCE_STAMP" >&2
  exit 24
}
/usr/bin/cmp -s "$SETTINGS" "$EXPECTED_TMP" || {
  echo "SETTINGS_CHANGED_SINCE_STAMP" >&2
  exit 24
}
if [ "$ORIGINAL_KIND" = "PRESENT" ]; then
  /bin/chmod "$ORIGINAL_MODE" "$ORIGINAL_TMP"
  /bin/mv -f "$ORIGINAL_TMP" "$SETTINGS"
else
  [ "$ORIGINAL_SIZE" = "0" ] || exit 22
  /bin/rm -f -- "$SETTINGS"
fi
/usr/bin/printf 'RESTORED\n'
`.trim();

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
    const directoryPath = posix.join(remoteHome, ".vellum");
    const settingsPath = posix.join(directoryPath, "settings.json");
    const command = yield* makeRemoteCommand("/bin/sh", [
      "-c",
      SNAPSHOT_SCRIPT,
      "vellum-settings-snapshot",
      directoryPath,
      settingsPath,
      String(SETTINGS_MAX_FILE_BYTES),
    ]).pipe(
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
    const directoryPath = posix.dirname(before.settingsPath);
    const command = yield* makeRemoteCommand("/bin/sh", [
      "-c",
      STAMP_SCRIPT,
      "vellum-settings-stamp",
      directoryPath,
      before.settingsPath,
      String(SETTINGS_MAX_FILE_BYTES),
    ]).pipe(
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
    const directoryPath = posix.dirname(before.settingsPath);
    const command = yield* makeRemoteCommand("/bin/sh", [
      "-c",
      RESTORE_SCRIPT,
      "vellum-settings-rollback",
      directoryPath,
      before.settingsPath,
      String(SETTINGS_MAX_FILE_BYTES),
    ]).pipe(
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
