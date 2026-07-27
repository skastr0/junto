#!/usr/bin/env bun
import { Effect } from "effect";
import {
  canvasControlAuthorialPermit,
  removeCanvasThroughControl,
} from "../src/main/vellum/canvas-control/client";

const usage = "usage: VELLUM_AUTHORIAL_WRITE=1 bun run canvas:rm <name>…";

const names = process.argv.slice(2);
if (names.length === 0 || names.includes("--help") || names.includes("-h")) {
  console.error(usage);
  process.exit(names.length === 0 ? 2 : 0);
}

let permit: ReturnType<typeof canvasControlAuthorialPermit>;
try {
  permit = canvasControlAuthorialPermit();
} catch (error) {
  console.error(
    `canvas:rm: authorial_write_denied: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(2);
}

for (const name of names) {
  const result = await Effect.runPromise(
    Effect.either(removeCanvasThroughControl(name, permit)),
  );
  if (result._tag === "Left") {
    console.error(`canvas:rm: ${result.left.code}: ${result.left.message}`);
    process.exit(1);
  }
  console.log(`removed ${result.right.name}`);
}
