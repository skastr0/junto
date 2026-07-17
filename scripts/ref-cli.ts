#!/usr/bin/env bun
import { Effect, ManagedRuntime } from "effect";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { resolveNodeRef } from "../src/main/vellum/node-ref-resolver";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";

const usage = `vellum node references

usage: bun run ref <command> [args] [--json]

commands:
  format <canvas-name> <node-id>  print a canonical Vellum node reference
  resolve <vellum-uri>            resolve a reference without mutating the canvas`;

type CliError = {
  readonly code: string;
  readonly message: string;
};

const printError = (error: CliError, json: boolean, exitCode: number): void => {
  if (json) console.log(JSON.stringify({ ok: false, error }));
  else console.error(`${error.code}: ${error.message}`);
  process.exitCode = exitCode;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const [command, first, second, ...extra] = positional;
  if (extra.length > 0) {
    printError({ code: "usage", message: usage }, json, 2);
    return;
  }

  if (command === "format") {
    if (first === undefined || second === undefined) {
      printError({ code: "usage", message: "format requires <canvas-name> <node-id>" }, json, 2);
      return;
    }
    try {
      const ref = formatNodeRef({ canvasName: first, nodeId: second });
      if (json) console.log(JSON.stringify({ ok: true, data: { ref } }));
      else console.log(ref);
    } catch (error) {
      printError(
        { code: "invalid_reference", message: error instanceof Error ? error.message : String(error) },
        json,
        1,
      );
    }
    return;
  }

  if (command !== "resolve" || first === undefined || second !== undefined) {
    printError({ code: "usage", message: usage }, json, 2);
    return;
  }

  const parsed = parseNodeRef(first);
  if (!parsed.ok) {
    printError({ code: parsed.error.code, message: parsed.error.message }, json, 1);
    return;
  }

  const runtime = ManagedRuntime.make(CanvasesLive);
  try {
    const canvases = await runtime.runPromise(CanvasesService);
    const result = await runtime.runPromise(Effect.either(resolveNodeRef(canvases, parsed.value)));
    if (result._tag === "Left") {
      printError(
        {
          code: result.left._tag,
          message:
            "message" in result.left
              ? result.left.message
              : `${parsed.value.canvasName}:${parsed.value.nodeId} could not be resolved`,
        },
        json,
        1,
      );
      return;
    }

    const data = {
      ref: result.right.key,
      canvas: result.right.canvasName,
      path: result.right.canvasPath,
      node: result.right.node,
    };
    if (json) console.log(JSON.stringify({ ok: true, data }));
    else console.log(`${data.ref}\n${data.node.type} ${data.node.id}\n${data.path}`);
  } finally {
    await runtime.dispose();
  }
};

await main();
