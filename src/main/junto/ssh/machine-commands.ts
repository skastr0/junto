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
"$stage/package/bin/node" -e '
const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
const root=fs.realpathSync(process.argv[1]);
const manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8"));
if (!Array.isArray(manifest.files) || manifest.files.length>128) throw new Error("Invalid package file inventory");
for (const file of manifest.files) {
  if (typeof file.path!=="string" || !/^(?:[A-Za-z0-9._@-]+\\/)*[A-Za-z0-9._@-]+$/.test(file.path) || file.path.split("/").some(part=>part==="." || part==="..") || !Number.isSafeInteger(file.mode) || file.mode<0 || file.mode>511 || !Number.isSafeInteger(file.bytes) || file.bytes<0 || typeof file.sha256!=="string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("Invalid package file inventory");
  const absolute=path.join(root,file.path), metadata=fs.lstatSync(absolute), actual=fs.realpathSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid!==process.getuid() || !actual.startsWith(root+path.sep)) throw new Error("Package file is not owned by this staging directory");
  const bytes=fs.readFileSync(absolute);
  if (bytes.length!==file.bytes || crypto.createHash("sha256").update(bytes).digest("hex")!==file.sha256) throw new Error("Package file does not match its inventory");
  fs.chmodSync(absolute,file.mode);
}
const input=JSON.parse(process.argv[2]); input.bundle=root; fs.writeFileSync(process.argv[3],JSON.stringify(input));
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
