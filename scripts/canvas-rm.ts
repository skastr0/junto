#!/usr/bin/env bun
/**
 * Beta: mutating canvas:rm is disabled.
 *
 * A separate CanvasesLive process has process-local mutexes and can race the
 * running app on the same generation. Reintroduce only by routing through the
 * running Command Center operator-authoring path.
 */

console.error(
  "canvas:rm is disabled for beta — remove canvases from the running Command Center UI.",
);
console.error(
  "Reason: CLI authority writes race the app process and can drop operator changes.",
);
process.exit(2);
