/**
 * Hermes remote read programs — sole emitters of identity/avatar shell.
 *
 * Hand-authored scripts are forbidden at the hermes transport boundary.
 * Dynamic values (profile name) cross only as argv after brand re-admission;
 * they are never interpolated into shell source.
 *
 * Doctrine (machine-safety + security-doctrine):
 * - Closed product sources only; no free-form caller shell.
 * - Profile names revalidated at compile time (`HermesProfileName` shape).
 * - Compilation is pure and unit-tested; argv still crosses `makeRemoteCommand`.
 */

import { Effect } from "effect";
import {
  parseHermesProfileName,
  type HermesProfileName,
} from "../hermes/domain";
import { makeRemoteCommand, type RemoteCommand, SshInputError } from "./domain";

// Closed product policy — not caller-provided shell. Paths are fixed under
// $HOME/.hermes; profile names arrive only as positional argv ($1).

/** Enumerate default + named profiles: name, display, matrix, room, avatar flag. */
const HERMES_IDENTITY_BATCH_SOURCE = `
emit() {
  name="$1"; dir="$2"
  display=""
  for brief in "$dir/assets/identity-brief.md" "$dir/identity-brief.md"; do
    if [ -f "$brief" ]; then
      display=$(grep -m1 -E "Display name/code:" "$brief" 2>/dev/null | sed -E 's/.*Display name\\/code:[[:space:]]*//')
      [ -n "$display" ] && break
    fi
  done
  muid=""
  room=""
  env="$dir/.env"
  if [ -f "$env" ]; then
    muid=$(grep -m1 "^MATRIX_USER_ID=" "$env" 2>/dev/null | cut -d= -f2-)
    room=$(grep -m1 "^MATRIX_HOME_ROOM_NAME=" "$env" 2>/dev/null | cut -d= -f2-)
  fi
  avatar="false"
  [ -f "$dir/assets/profile-picture.png" ] && avatar="true"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$display" "$muid" "$room" "$avatar"
}
emit default "$HOME/.hermes"
if [ -d "$HOME/.hermes/profiles" ]; then
  for d in "$HOME/.hermes/profiles"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    emit "$n" "$HOME/.hermes/profiles/$n"
  done
fi
`;

/** base64 of profile-picture.png for argv profile ($1). */
const HERMES_AVATAR_SOURCE = `
if [ "$1" = default ]; then
  path="$HOME/.hermes/assets/profile-picture.png"
else
  path="$HOME/.hermes/profiles/$1/assets/profile-picture.png"
fi
exec base64 < "$path"
`;

/** Pure product compile: fixed identity-batch shell → branded RemoteCommand. */
export const compileHermesIdentityBatch = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> =>
  makeRemoteCommand("/bin/sh", [
    "-c",
    HERMES_IDENTITY_BATCH_SOURCE,
    "vellum-plan:hermes-identity-batch",
  ]);

/**
 * Pure product compile: fixed avatar shell + branded profile as argv only.
 * Profile is never shell-interpolated into the source.
 */
export const compileHermesAvatar = (
  profile: HermesProfileName,
): Effect.Effect<RemoteCommand, SshInputError> => {
  // Brand is not runtime proof across modules — re-admit before argv boundary.
  if (parseHermesProfileName(profile) === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "hermes profile name is not a safe remote argv token",
      }),
    );
  }
  return makeRemoteCommand("/bin/sh", [
    "-c",
    HERMES_AVATAR_SOURCE,
    "vellum-plan:hermes-avatar",
    profile,
  ]);
};

/** Test/audit helper: identity-batch source (no dynamic inputs). */
export const hermesIdentityBatchSource = (): string => HERMES_IDENTITY_BATCH_SOURCE;

/** Test/audit helper: avatar source (profile is argv, not in source). */
export const hermesAvatarSource = (): string => HERMES_AVATAR_SOURCE;
