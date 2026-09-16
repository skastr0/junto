#!/usr/bin/env bash
# Launch the Junto dev app on the orb Desktop, in the foreground.
# Launched via amp-desktop-run, the Desktop supplies DISPLAY/Wayland/audio;
# do not set display variables here.
#
# --disable-gpu: the orb VM has no usable GPU; when the GPU process dies the
# app crashes ("GPU process isn't usable"), so render in software.
set -euo pipefail

exec bash "$(dirname "$0")/../scripts/dev.sh" -- --disable-gpu
