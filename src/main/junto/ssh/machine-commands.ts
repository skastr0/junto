import { Effect } from "effect";
import { makeRemoteCommand, type SshTarget } from "./domain";
import { dedicatedStream } from "./program";

export const openMachineLink = (
  target: SshTarget,
  location: { readonly juntoHome: string; readonly installRoot: string },
) => Effect.gen(function* () {
  if (![location.juntoHome, location.installRoot].every(path => /^\/[^\u0000-\u001f\u007f]*$/.test(path))) return yield* Effect.fail(new Error("machine link requires absolute install paths"));
  const command = yield* makeRemoteCommand("/usr/bin/env", [
    `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "link",
  ]);
  return dedicatedStream(target, command);
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
python=""
for candidate in /usr/bin/python3 /bin/python3; do
  if [ -x "$candidate" ]; then python=$candidate; break; fi
done
[ -n "$python" ] || { printf "%s\\n" "Install Python 3 on this machine, then send Junto again" >&2; exit 1; }
"$python" -c '
import hashlib, json, os, re, stat, sys
root = os.path.realpath(sys.argv[1])
with open(os.path.join(root, "manifest.json"), encoding="utf8") as source:
    manifest = json.load(source)
files = manifest.get("files")
if not isinstance(files, list) or len(files) > 128:
    raise RuntimeError("Invalid package file inventory")
seen = set()
for file in files:
    if not isinstance(file, dict):
        raise RuntimeError("Invalid package file inventory")
    name, mode, size, digest = (file.get(key) for key in ["path", "mode", "bytes", "sha256"])
    if not isinstance(name, str) or not re.fullmatch(r"(?:[A-Za-z0-9._@-]+/)*[A-Za-z0-9._@-]+", name) or any(part in [".", ".."] for part in name.split("/")) or name in seen or type(mode) is not int or not 0 <= mode <= 511 or type(size) is not int or size < 0 or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeError("Invalid package file inventory")
    seen.add(name)
    absolute = os.path.join(root, name)
    metadata = os.lstat(absolute)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or not os.path.realpath(absolute).startswith(root + os.sep):
        raise RuntimeError("Package file is not owned by this staging directory")
    with open(absolute, "rb") as source:
        data = source.read()
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError("Package file does not match its inventory")
    os.chmod(absolute, mode)
input = json.loads(sys.argv[2])
input["bundle"] = root
with open(sys.argv[3], "w", encoding="utf8") as output:
    json.dump(input, output)
' "$stage/package" "$2" "$stage/input.json"
"$stage/package/bin/junto" machine install-local "@$stage/input.json"
`;

/** Copy is an isolated SSH stream, with arguments quoted by the SSH compiler. */
export const receiveMachineBundle = (
  target: SshTarget,
  archiveSha256: string,
  input: { readonly juntoHome?: string; readonly installRoot?: string; readonly expectedInstallationId?: string },
) => Effect.gen(function* () {
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) return yield* Effect.fail(new Error("invalid package checksum"));
  const command = yield* makeRemoteCommand("/bin/sh",["-c",RECEIVE,"junto-send",archiveSha256,JSON.stringify(input)]);
  return dedicatedStream(target,command);
});
