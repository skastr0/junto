#!/usr/bin/env bun
import { Effect, ManagedRuntime } from "effect";
import {
  AUTHORIAL_WRITE_ENV,
  requireAuthorialCliWrite,
} from "../src/shared/authorial-write";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";

// Operator CLI only (requires VELLUM_AUTHORIAL_WRITE=1). Agents must not
// delete canvases. Removes via CanvasesService.remove (updates authority
// generation and cleans known export sidecars). Exits non-zero if any named
// canvas is missing or the name is invalid. `--json` emits a machine-readable
// report.

interface DeleteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly path?: string;
  readonly error?: string;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const usage = (): never => {
  console.error("usage: bun run canvas:rm <name> [name...] [--json]");
  console.error("  deletes canvas document(s) from live authority (canvas-authority-v1)");
  process.exit(2);
};

const main = async () => {
  try {
    requireAuthorialCliWrite();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Operator override: ${AUTHORIAL_WRITE_ENV}=1 bun run canvas:rm …`);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const names = args.filter((arg) => arg !== "--json");

  if (names.length === 0) usage();

  const runtime = ManagedRuntime.make(CanvasesLive);
  try {
    const canvases = await runtime.runPromise(CanvasesService);

    const results: DeleteResult[] = [];
    for (const raw of names) {
      const outcome = await runtime.runPromise(Effect.either(canvases.remove(raw)));
      if (outcome._tag === "Left") {
        results.push({ name: raw, ok: false, error: errorMessage(outcome.left) });
      } else {
        results.push({ name: outcome.right.name, ok: true });
      }
    }

    if (jsonMode) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const result of results) {
        if (result.ok) {
          console.log(`deleted ${result.name}`);
        } else {
          console.error(`failed ${result.name}: ${result.error}`);
        }
      }

      const remaining = await runtime.runPromise(canvases.list);
      if (remaining.length === 0) {
        console.log("no canvases left in live authority");
      }
    }

    if (results.some((result) => !result.ok)) process.exit(1);
  } finally {
    await runtime.dispose();
  }
};

await main();
