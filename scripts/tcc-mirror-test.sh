#!/usr/bin/env bash
# tcc-mirror-test.sh: measure what macOS privacy (TCC) sees when Junto starts
# from a fresh TCC state, without touching the real Junto's grants.
#
# A build of a main commit gets its own bundle id, com.skastr0.junto.tcctest,
# so TCC treats it as a new app. Only that id is ever reset. It launches
# through LaunchServices (`open -n -a`), so it is its own responsible process
# and nothing it does is billed to a running Junto.
#
#   scripts/tcc-mirror-test.sh build [commit]   export the commit, give it the test id, build the fast Preview
#   scripts/tcc-mirror-test.sh run              reset the test id, start the TCC log stream, launch the mirror cold
#   (control, by hand) in the mirror, open a plain terminal node and type: ls ~/Documents >/dev/null
#   scripts/tcc-mirror-test.sh report           stop the stream, print every TCC line naming the test id
#   scripts/tcc-mirror-test.sh clean            quit the mirror, reset the test id, delete the build and its home
#
# Read the report: a TCC line from the shell probe (accessing /bin/zsh or a
# child, responsible com.skastr0.junto.tcctest) or a kTCCServiceSystemPolicy*
# request before the control would mean the probe raised a check. The control
# must show kTCCServiceSystemPolicyDocumentsFolder and a prompt; if it does
# not, the TCC state was not fresh and the run proves nothing. Results are
# recorded in docs/macos-privacy.md, Shell environment.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID=com.skastr0.junto.tcctest
REAL_ID=com.skastr0.junto
BUILD="$HOME/.junto-preview-builds/tcctest"
PREVIEW_HOME="$HOME/.junto-preview-tcctest"
OUT="${TCC_MIRROR_OUT:-$HOME/.junto-preview-builds/tcctest-run}"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

die() { printf 'tcc-mirror-test: %s\n' "$*" >&2; exit 1; }

mirror_app() {
  local app
  app="$(find "$BUILD/release" -maxdepth 3 -name '*.app' -type d 2>/dev/null | head -n 1)"
  [[ -n "$app" ]] || die "no mirror build in $BUILD; run build first"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "$ID" ]] \
    || die "$app is not the mirror id $ID; refusing"
  printf '%s\n' "$app"
}

keys_digest() {
  if [[ -f "$HOME/.ssh/authorized_keys" ]]; then shasum -a 256 "$HOME/.ssh/authorized_keys" | cut -d' ' -f1; else echo none; fi
}

# The export's own identity: bundle id, the ids the policy files pin, and the
# name macOS shows. Executable and helper names stay "Junto": the packaging
# audit and provenance pin them.
give_identity() {
  python3 -I - "$ID" <<'PY'
import json, sys
test_id = sys.argv[1]
def sub(path, old, new):
    text = open(path).read()
    assert old in text, (path, old)
    open(path, "w").write(text.replace(old, new))
package = json.load(open("package.json"))
package["build"]["appId"] = test_id
info = package["build"]["mac"].setdefault("extendInfo", {})
info["CFBundleDisplayName"] = "Junto TCC Test"
info["CFBundleName"] = "Junto TCC Test"
with open("package.json", "w") as out:
    json.dump(package, out, indent=2, ensure_ascii=False)
    out.write("\n")
sub("scripts/package-security-policy.json", '"bundleIdentifier": "com.skastr0.junto",', f'"bundleIdentifier": "{test_id}",')
sub("scripts/macos-runtime-policy.json", '"com.skastr0.junto', f'"{test_id}')
sub("scripts/app-paths.sh", 'LABEL="com.skastr0.junto"', f'LABEL="{test_id}"')
sub("scripts/app-paths.sh", 'APP_BUNDLE_ID="com.skastr0.junto"', f'APP_BUNDLE_ID="{test_id}"')
# A Preview build names itself "Junto PREVIEW"; the prompt must name the mirror.
sub("scripts/package-app-macos.sh", "CFBundleDisplayName=Junto PREVIEW", "CFBundleDisplayName=Junto TCC Test")
PY
}

build() {
  local commit export_dir
  commit="$(git -C "$REPO" rev-parse --verify "${1:-HEAD}^{commit}")"
  rm -rf "$BUILD"
  mkdir -p "$(dirname "$BUILD")"
  export_dir="$(mktemp -d "$HOME/.junto-preview-builds/.export-XXXXXX")"
  trap 'rm -rf "$export_dir"' EXIT
  git -C "$REPO" archive "$commit" | tar -xf - -C "$export_dir"
  git -C "$export_dir" init -q
  git -C "$export_dir" fetch -q --no-tags --depth=1 "$REPO" "$commit"
  git -C "$export_dir" update-ref --no-deref HEAD "$commit"
  git -C "$export_dir" read-tree "$commit"
  mv "$export_dir" "$BUILD"
  trap - EXIT
  cp -cR "$REPO/node_modules" "$BUILD/node_modules"
  find "$BUILD/node_modules" -maxdepth 1 -type l -name node_modules -delete
  cd "$BUILD"
  give_identity
  # The packager proves tracked sources equal HEAD, so the identity is
  # committed in the export's own git, never in the repo.
  git add package.json scripts/package-security-policy.json scripts/macos-runtime-policy.json \
    scripts/app-paths.sh scripts/package-app-macos.sh
  git -c user.name=tcc-mirror -c user.email=tcc-mirror@localhost commit -qm "TCC mirror identity on $commit (export only)"
  # The app carries machine payloads: keep the caller's source for them, else
  # the build orb the 2026-10-19 run used.
  local orb="${JUNTO_MACHINE_LINUX_ORB:-}" bundles="${JUNTO_MACHINE_BUNDLES:-}"
  while IFS= read -r name; do unset "$name"; done < <(compgen -v JUNTO_)
  export JUNTO_FEATURE_PROFILE=ship JUNTO_PREVIEW_BUILD=1
  if [[ -n "$bundles" ]]; then export JUNTO_MACHINE_BUNDLES="$bundles"
  else export JUNTO_MACHINE_LINUX_ORB="${orb:-vellum-v015-build-clean}"; fi
  bash scripts/build-app.sh --target mac --fast
  printf 'built %s from %s\n' "$(mirror_app)" "$commit"
}

run() {
  local app
  app="$(mirror_app)"
  pgrep -f "$app/Contents/MacOS/" >/dev/null && die "the mirror is already running"
  [[ ! -e "$PREVIEW_HOME" ]] || die "$PREVIEW_HOME exists; run clean first"
  mkdir -p "$OUT"
  keys_digest > "$OUT/authorized_keys.before"
  "$LSREGISTER" -f "$app"
  # The test id only. Never the real Junto's grants.
  [[ "$ID" != "$REAL_ID" ]] || die "refusing to reset $REAL_ID"
  tccutil reset All "$ID"
  mkdir -p "$PREVIEW_HOME"
  chmod 700 "$PREVIEW_HOME"
  printf '%s\n' 'Fresh preview, no production seed.' > "$PREVIEW_HOME/.fresh-preview"
  chmod 600 "$PREVIEW_HOME/.fresh-preview"
  /usr/bin/log stream --debug --info --style compact --predicate 'subsystem == "com.apple.TCC"' \
    > "$OUT/tcc-stream.log" 2> "$OUT/tcc-stream.err" &
  echo $! > "$OUT/tcc-stream.pid"
  # Let the stream attach before the launch.
  for _ in $(seq 1 50); do [[ -s "$OUT/tcc-stream.log" ]] && break; sleep 0.1; done
  date '+%Y-%m-%d %H:%M:%S' > "$OUT/launch.local"
  open -n -a "$app" --env "JUNTO_PREVIEW_HOME=$PREVIEW_HOME"
  printf 'launched at %s local; wait for the window, do the control if wanted, then: %s report\n' \
    "$(cat "$OUT/launch.local")" "$0"
}

report() {
  [[ -f "$OUT/tcc-stream.pid" ]] || die "no run in $OUT"
  kill "$(cat "$OUT/tcc-stream.pid")" 2>/dev/null || true
  rm -f "$OUT/tcc-stream.pid"
  printf 'launch: %s local\n' "$(cat "$OUT/launch.local")"
  printf '\nshell environment log line:\n'
  find "$PREVIEW_HOME" -name app.jsonl -exec grep -h '\[env\]' {} + 2>/dev/null || echo "(none)"
  printf '\nTCC requests naming %s (context, attribution, result):\n' "$ID"
  grep -F "$ID" "$OUT/tcc-stream.log" | grep -oE 'msgID=[0-9.]+' | sort -u | while read -r msg; do
    grep -F "$msg," "$OUT/tcc-stream.log" | grep -E 'AUTHREQ_(CTX|ATTRIBUTION|RESULT)'
    echo
  done
  printf 'folder checks: %s\n' "$(grep -c 'kTCCServiceSystemPolicy' "$OUT/tcc-stream.log" || true)"
}

clean() {
  local app digest
  app="$(find "$BUILD/release" -maxdepth 3 -name '*.app' -type d 2>/dev/null | head -n 1 || true)"
  if [[ -n "$app" ]]; then
    pkill -TERM -f "$app/Contents/MacOS/" 2>/dev/null || true
    for _ in $(seq 1 50); do pgrep -f "$app/Contents/MacOS/" >/dev/null || break; sleep 0.1; done
    "$LSREGISTER" -u "$app" 2>/dev/null || true
  fi
  [[ -f "$OUT/tcc-stream.pid" ]] && kill "$(cat "$OUT/tcc-stream.pid")" 2>/dev/null || true
  tccutil reset All "$ID" || true
  digest="$(keys_digest)"
  if [[ -f "$OUT/authorized_keys.before" && "$(cat "$OUT/authorized_keys.before")" != "$digest" ]]; then
    printf 'tcc-mirror-test: WARNING ~/.ssh/authorized_keys changed during the run\n' >&2
  fi
  rm -rf "$BUILD" "$PREVIEW_HOME" "$OUT"
  printf 'clean: mirror quit, %s reset, build and home deleted\n' "$ID"
}

case "${1:-}" in
  build) shift; build "$@" ;;
  run) run ;;
  report) report ;;
  clean) clean ;;
  *) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
