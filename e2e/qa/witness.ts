#!/usr/bin/env bun
/**
 * Prints the running app's projection of one canvas as JSON: the compiled
 * document read through the owner-local canvas control socket and the
 * deterministic digest built from it, the same path as `bun run digest`
 * without the sidecar write. Runs under bun because Playwright's transform
 * cannot load the control client; the oracle spawns it with the sandbox's
 * JUNTO_CANVAS_CONTROL_HOME so it can only reach the app under test.
 */
import { Effect } from "effect";
import { digestCanvas } from "../../src/shared/digest";
import { executionGraphContextFromActorRefs } from "../../src/shared/graph";
import { readCanvasThroughControl } from "../../src/main/junto/canvas-control/client";

const canvas = process.argv[2];
if (!canvas || !process.env.JUNTO_CANVAS_CONTROL_HOME) {
  console.error("witness: usage: JUNTO_CANVAS_CONTROL_HOME=<dir> bun e2e/qa/witness.ts <canvas>");
  process.exit(2);
}

const result = await Effect.runPromise(Effect.result(readCanvasThroughControl(canvas, { timeoutMs: 10_000 })));
if (result._tag === "Failure") {
  console.error(`witness: ${result.failure.message}`);
  process.exit(1);
}
const { actorRefs, doc, name, snapshots } = result.success;
const context = executionGraphContextFromActorRefs(name, actorRefs);
const digest = digestCanvas(name, doc, snapshots, { resolveActorRef: context.resolveActorRef });
process.stdout.write(JSON.stringify({ name, doc, digest }));
