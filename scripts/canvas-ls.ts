#!/usr/bin/env bun
import { Effect } from "effect";
import {
  listCanvasesThroughControl,
  type CanvasControlClientError,
} from "../src/main/junto/canvas-control/client";

// Headless agent surface: the running app returns its compiled live projection.
// This process never opens product state.

interface CanvasRow {
  readonly name: string;
  readonly nodes: number;
  readonly edges: number;
  readonly modifiedAt: string;
}

const pad = (value: string, width: number): string =>
  value + " ".repeat(Math.max(0, width - value.length));

const printTable = (rows: ReadonlyArray<CanvasRow>): void => {
  if (rows.length === 0) {
    console.log("no canvases found in live authority");
    return;
  }

  const columns: ReadonlyArray<{ header: string; value: (row: CanvasRow) => string }> = [
    { header: "NAME", value: (row) => row.name },
    { header: "NODES", value: (row) => String(row.nodes) },
    { header: "EDGES", value: (row) => String(row.edges) },
    { header: "MODIFIED", value: (row) => row.modifiedAt },
  ];

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
  );

  const line = (values: ReadonlyArray<string>): string =>
    values.map((value, i) => pad(value, widths[i]!)).join("  ").trimEnd();

  console.log(line(columns.map((column) => column.header)));
  for (const row of rows) {
    console.log(line(columns.map((column) => column.value(row))));
  }
};

const main = async () => {
  const jsonMode = process.argv.slice(2).includes("--json");
  try {
    const rows: ReadonlyArray<CanvasRow> = await Effect.runPromise(
      listCanvasesThroughControl(),
    );

    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    printTable(rows);
  } catch (error) {
    const message =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "CanvasControlClientError"
        ? `${(error as CanvasControlClientError).code}: ${(error as CanvasControlClientError).message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`canvas:ls: ${message}`);
    process.exitCode = 1;
  }
};

await main();
