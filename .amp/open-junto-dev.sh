#!/usr/bin/env bash
# Launch the Junto dev app on the orb Desktop, in the foreground.
# Launched via amp-desktop-run, the Desktop supplies DISPLAY/Wayland/audio;
# do not set display variables here.
#
# --disable-gpu: the orb VM has no usable GPU; when the GPU process dies the
# app crashes ("GPU process isn't usable"), so render in software.
#
# LIVE_OVERSEER: the ship profile compiles every harness gate in except the
# app-owned `junto-overseer` seat, which is off in normal dev builds. An orb
# exists to exercise the whole harness range, so turn it on here; it only
# exposes the surface, and a human still has to grant the seat.
export JUNTO_LIVE_OVERSEER=1

set -euo pipefail

exec bash "$(dirname "$0")/../scripts/dev.sh" -- --disable-gpu
