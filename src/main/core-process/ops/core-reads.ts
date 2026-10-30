/**
 * The reads shared code asks of the core (`coreReads` in core-runner.ts),
 * answered here so main can ask them by name once the core runs in its own
 * process: a canvas, this machine's name, and its vault scope.
 */
import type { Canvas } from "@shared/model";
import { coreReads } from "../../core-runner";
import { coreOps, type CoreOp } from "../ops";
import { Effect } from "effect";

declare module "../ops" {
  interface CoreOps {
    "core.canvas": CoreOp<{ readonly canvasName: string }, Canvas | undefined>;
    "core.machineName": CoreOp<Record<string, never>, string>;
    "core.vaultScope": CoreOp<Record<string, never>, { readonly vault: string } | undefined>;
  }
}

coreOps({
  "core.canvas": ({ canvasName }) => Effect.promise(() => coreReads.canvas(canvasName)),
  "core.machineName": () => Effect.promise(() => coreReads.machineName()),
  "core.vaultScope": () => Effect.promise(() => coreReads.vaultScope()),
});
