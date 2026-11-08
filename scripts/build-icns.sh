#!/usr/bin/env bash
#
# build-icns.sh — turn a 1024×1024 PNG into build/icon.icns
#
# Builds the standard macOS iconset ladder (16/32/128/256/512, each with @2x)
# with sips, then packs it with iconutil. electron-builder picks up
# build/icon.icns automatically when packaging the mac target.
#
#   Usage:  scripts/build-icns.sh <path-to-1024.png>
#   Output: build/icon.icns  (relative to the repo root)
#
# Runnable from any directory: the repo root is resolved from the script's
# own location, so build/ always lands beside package.json.

set -euo pipefail

# --- locate repo root (parent of this script's dir) -------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- args -------------------------------------------------------------------
SRC="${1:-}"
if [[ -z "${SRC}" ]]; then
  echo "usage: $(basename "$0") <path-to-1024.png>" >&2
  exit 2
fi
if [[ ! -f "${SRC}" ]]; then
  echo "error: source PNG not found: ${SRC}" >&2
  exit 2
fi

# --- tool checks ------------------------------------------------------------
for tool in sips iconutil; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "error: required tool '${tool}' not found (macOS only)" >&2; exit 3; }
done

# --- verify source is a square, ideally 1024 -------------------------------
DIMS="$(sips -g pixelWidth -g pixelHeight "${SRC}" 2>/dev/null || true)"
W="$(printf '%s\n' "${DIMS}" | awk '/pixelWidth/  {print $2}')"
H="$(printf '%s\n' "${DIMS}" | awk '/pixelHeight/ {print $2}')"
if [[ -z "${W}" || -z "${H}" ]]; then
  echo "error: could not read dimensions of ${SRC}" >&2
  exit 3
fi
if [[ "${W}" != "${H}" ]]; then
  echo "error: source must be square, got ${W}x${H}" >&2
  exit 3
fi
if [[ "${W}" != "1024" ]]; then
  echo "warning: source is ${W}x${H}, expected 1024x1024 — scaling anyway" >&2
fi

# --- build the iconset ------------------------------------------------------
BUILD_DIR="${REPO_ROOT}/build"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "${ICONSET}" "${BUILD_DIR}"
trap 'rm -rf "$(dirname "${ICONSET}")"' EXIT

# name:size pairs — every size scaled directly from the 1024 master
emit() {  # emit <pixels> <filename>
  sips -s format png -z "$1" "$1" "${SRC}" --out "${ICONSET}/$2" >/dev/null
}

emit   16 icon_16x16.png
emit   32 icon_16x16@2x.png
emit   32 icon_32x32.png
emit   64 icon_32x32@2x.png
emit  128 icon_128x128.png
emit  256 icon_128x128@2x.png
emit  256 icon_256x256.png
emit  512 icon_256x256@2x.png
emit  512 icon_512x512.png
emit 1024 icon_512x512@2x.png

# --- pack -------------------------------------------------------------------
OUT="${BUILD_DIR}/icon.icns"
iconutil -c icns "${ICONSET}" -o "${OUT}"

echo "built ${OUT}"
sips -g pixelWidth -g pixelHeight "${OUT}" 2>/dev/null | sed 's/^/  /' || true
