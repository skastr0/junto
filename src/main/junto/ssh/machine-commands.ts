import { Effect } from "effect";
import { makeRemoteCommand, makeRemoteStdin, SshCommandInputError, type RemoteStdin, type SshTarget } from "./domain";
import { dedicatedStream, oneShot, oneShotWithStdin } from "./program";

export const openMachineLink = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* new SshCommandInputError({ check: "install-paths", message: "machine link requires absolute install paths" });
  const command = yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "link",
  ]);
  return dedicatedStream(target, command);
});

const contentTransfer = (
  location: { readonly juntoHome: string; readonly installRoot: string },
  ref: { readonly sha256: string; readonly byteLength: number },
  args: ReadonlyArray<string>,
) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* new SshCommandInputError({ check: "install-paths", message: "machine content requires absolute install paths" });
  if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) return yield* new SshCommandInputError({ check: "content-ref", message: "invalid content ref" });
  return yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "content-transfer", ...args,
  ]);
});

/**
 * One piece of a content object, landed in the machine's own store by its own
 * Junto from stdin. A piece starts where the machine's partial ends (0 for a
 * fresh object) and stays under the 16 MiB stdin boundary, so a larger object
 * goes over in pieces; the store publishes it only once the whole object
 * verifies, and an object already there is a success.
 *
 * The caller decodes the answer closed (parseContentHelperStatus) and passes
 * its error through scrubMessage before any row or log: an IO failure names a
 * path on the far machine. One push per (machine, sha256) at a time, since the
 * far partial is keyed by sha256 alone and two pushes interleave into it.
 */
export const receiveMachineContent = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
  ref: { readonly sha256: string; readonly byteLength: number },
  piece: { readonly offset: number; readonly bytes: Uint8Array },
) => Effect.gen(function* () {
  if (!Number.isSafeInteger(piece.offset) || piece.offset < 0 || piece.offset + piece.bytes.byteLength > ref.byteLength) return yield* new SshCommandInputError({ check: "content-ref", message: "content piece is outside its object" });
  const command = yield* contentTransfer(location, ref, ["receive", ref.sha256, String(ref.byteLength), String(piece.offset)]);
  return oneShotWithStdin(target, command, yield* makeRemoteStdin(piece.bytes), { budget: "bulk" });
});

/** Whether the machine holds the object, and how much of a partial, so a push resumes. */
export const statMachineContent = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
  ref: { readonly sha256: string; readonly byteLength: number },
) => Effect.gen(function* () {
  const command = yield* contentTransfer(location, ref, ["stat", ref.sha256, String(ref.byteLength)]);
  return oneShot(target, command, { budget: "status" });
});

const RECEIVE = `set -eu
umask 077
stage=$(mktemp -d "$HOME/.junto-send.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
cat > "$stage/package.tgz"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$stage/package.tgz" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$stage/package.tgz" | cut -d ' ' -f 1)
fi
[ "$actual" = "$1" ] || { printf '%s\\n' 'package checksum mismatch' >&2; exit 1; }
mkdir "$stage/package"
tar -xzf "$stage/package.tgz" -C "$stage/package"
# Restore manifest modes using the verified payload, independent of tar modes.
[ -f "$stage/package/bin/node" ] && [ ! -L "$stage/package/bin/node" ]
chmod 700 "$stage/package/bin/node"
"$stage/package/bin/node" -e '
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = fs.realpathSync(process.argv[1]);
const files = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).files;
if (!Array.isArray(files) || files.length > 128) throw new Error("Invalid package file inventory");
const seen = new Set();
for (const file of files) {
  if (!file || typeof file !== "object") throw new Error("Invalid package file inventory");
  const {path: name, mode, bytes, sha256} = file;
  if (typeof name !== "string" || !name.split("/").every(part => /^[A-Za-z0-9._@-]+$/.test(part) && part !== "." && part !== "..") || seen.has(name) || !Number.isInteger(mode) || mode < 0 || mode > 511 || !Number.isSafeInteger(bytes) || bytes < 0 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid package file inventory");
  seen.add(name);
  const absolute = path.join(root, name), metadata = fs.lstatSync(absolute);
  if (!metadata.isFile() || metadata.uid !== process.getuid() || !fs.realpathSync(absolute).startsWith(root + path.sep)) throw new Error("Package file is not owned by this staging directory");
  const data = fs.readFileSync(absolute);
  if (data.length !== bytes || crypto.createHash("sha256").update(data).digest("hex") !== sha256) throw new Error("Package file does not match its inventory");
  fs.chmodSync(absolute, mode);
}
const input = JSON.parse(process.argv[2]);
input.bundle = root;
fs.writeFileSync(process.argv[3], JSON.stringify(input), {mode: 384});
' "$stage/package" "$2" "$stage/input.json"
"$stage/package/bin/junto" machine install-local "@$stage/input.json"
`;

/** Copy is an isolated SSH stream, with arguments quoted by the SSH compiler. */
export const receiveMachineBundle = (
  target: SshTarget,
  archiveSha256: string,
  input: { readonly juntoHome?: string; readonly installRoot?: string; readonly expectedInstallationId?: string },
) => Effect.gen(function* () {
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) return yield* new SshCommandInputError({ check: "package-checksum", message: "invalid package checksum" });
  const command = yield* makeRemoteCommand("/bin/sh",["-c",RECEIVE,"junto-send",archiveSha256,JSON.stringify(input)]);
  return dedicatedStream(target,command);
});

/**
 * A Boat machine's key, written by that machine's own Junto from stdin over
 * the dialled session: never argv, an environment value or a command string.
 */
export const placeBoatMachineKey = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
  input: RemoteStdin,
) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* new SshCommandInputError({ check: "install-paths", message: "a machine key needs absolute install paths" });
  const command = yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "machine", "boat-key-local",
  ]);
  return oneShotWithStdin(target, command, input);
});

/**
 * A machine's vault token (docs/machines.md, The vault), written by that
 * machine's own Junto from stdin over the operator's route: never argv, an
 * environment value or a command string. Its answer is the names-only record.
 * The paths and command are checked first, before any token exists; the
 * program is made once the token is on its stdin.
 */
export const placeVaultToken = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* new SshCommandInputError({ check: "install-paths", message: "a vault token needs absolute install paths" });
  const command = yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "machine", "vault-token-local",
  ]);
  return (input: RemoteStdin) => oneShotWithStdin(target, command, input);
});
