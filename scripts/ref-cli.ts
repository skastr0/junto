#!/usr/bin/env bun
import { Effect } from "effect";
import { readCanvasThroughControl } from "../src/main/vellum-command/canvas-control/client";
import { formatNodeRef, nodeRefKey, parseNodeRef } from "../src/shared/node-ref";

const usage = `vellum-command node references

usage: bun run ref <command> [args] [--json]

commands:
  format <canvas-name> <node-id>  print a canonical Vellum Command node reference
  resolve <vellum-command-uri>    resolve a reference without mutating the canvas`;

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

  const read = await Effect.runPromise(
    Effect.result(readCanvasThroughControl(parsed.value.canvasName)),
  );
  if (read._tag === "Failure") {
    printError(
      { code: read.failure.code, message: read.failure.message },
      json,
      1,
    );
    return;
  }
  const matches = read.success.doc.nodes.filter(
    (node) => node.id === parsed.value.nodeId,
  );
  if (matches.length === 0) {
    printError(
      {
        code: "NodeNotFound",
        message: `${parsed.value.canvasName}:${parsed.value.nodeId} could not be resolved`,
      },
      json,
      1,
    );
    return;
  }
  if (matches.length !== 1) {
    printError(
      {
        code: "DuplicateNodeId",
        message: `${parsed.value.canvasName}:${parsed.value.nodeId} matched ${String(matches.length)} nodes`,
      },
      json,
      1,
    );
    return;
  }
  const node = matches[0]!;
  const data = {
    ref: nodeRefKey(parsed.value),
    canvas: parsed.value.canvasName,
    node,
  };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else console.log(`${data.ref}\n${data.node.type} ${data.node.id}`);
};

await main();
