import { Effect } from "effect";
import { makeRemoteCommand, type SshTarget } from "./domain";
import { dedicatedStream } from "./program";

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
"$stage/package/bin/node" -e 'const fs=require("node:fs"); const input=JSON.parse(process.argv[2]); input.bundle=process.argv[1]; fs.writeFileSync(process.argv[3],JSON.stringify(input))' "$stage/package" "$2" "$stage/input.json"
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
