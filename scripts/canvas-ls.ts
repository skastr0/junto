#!/usr/bin/env bun
import { ManagedRuntime } from "effect";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";

// Headless agent surface: `bun run canvas:ls` lists every canvas in live
// authority (canvas-authority-v1 via CanvasesService). Plain aligned text by
// default; `--json` emits machine-readable JSON.

interface CanvasRow {
  readonly name: string;
  readonly nodes: number | null;
  readonly edges: number | null;
  readonly path: string;
  readonly modifiedAt: string;
  readonly error?: string;
}

const pad = (value: string, width: number): string =>
  value + " ".repeat(Math.max(0, width - value.length));

const printTable = (rows: ReadonlyArray<CanvasRow>): void => {
  if (rows.length === 0) {
    console.log("no canvases found in live authority");
    return;
  }

  const cell = (row: CanvasRow, key: "nodes" | "edges"): string =>
    row.error ? row.error : String(row[key]);

  const columns: ReadonlyArray<{ header: string; value: (row: CanvasRow) => string }> = [
    { header: "NAME", value: (row) => row.name },
    { header: "NODES", value: (row) => cell(row, "nodes") },
    { header: "EDGES", value: (row) => cell(row, "edges") },
    { header: "MODIFIED", value: (row) => row.modifiedAt },
    { header: "PATH", value: (row) => row.path },
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
  const runtime = ManagedRuntime.make(CanvasesLive);
  try {
    const canvases = await runtime.runPromise(CanvasesService);
    const [summaries, live] = await Promise.all([
      runtime.runPromise(canvases.list),
      runtime.runPromise(canvases.liveDocuments()),
    ]);
    const docsByName = new Map(live.map((entry) => [entry.canvasName, entry.doc]));

    const rows: CanvasRow[] = summaries.map((summary) => {
      const doc = docsByName.get(summary.name);
      if (doc === undefined) {
        return {
          name: summary.name,
          nodes: null,
          edges: null,
          path: summary.path,
          modifiedAt: summary.modifiedAt,
          error: "missing",
        };
      }
      return {
        name: summary.name,
        nodes: doc.nodes.length,
        edges: doc.edges.length,
        path: summary.path,
        modifiedAt: summary.modifiedAt,
      };
    });

    if (jsonMode) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    printTable(rows);
  } finally {
    await runtime.dispose();
  }
};

await main();
