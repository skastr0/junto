#!/usr/bin/env bun
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc } from "../src/shared/canvas";

// Headless agent surface: `bun run canvas:ls` lists every canvas under
// ~/.vellum/canvases without the GUI. Plain aligned text by default;
// `--json` emits machine-readable JSON. A corrupt/invalid canvas degrades to
// an error cell rather than crashing the whole listing.

interface CanvasRow {
  readonly name: string;
  readonly nodes: number | null;
  readonly edges: number | null;
  readonly path: string;
  readonly modifiedAt: string;
  readonly error?: string;
}

const canvasesDir = () => join(homedir(), ".vellum", "canvases");

const readRow = async (file: string): Promise<CanvasRow> => {
  const path = join(canvasesDir(), file);
  const name = basename(file, ".canvas");

  try {
    const [info, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
    const modifiedAt = info.mtime.toISOString();

    const decoded = decodeCanvasDoc(JSON.parse(raw));
    if (Either.isLeft(decoded)) {
      return { name, nodes: null, edges: null, path, modifiedAt, error: "invalid" };
    }

    return {
      name,
      nodes: decoded.right.nodes.length,
      edges: decoded.right.edges.length,
      path,
      modifiedAt,
    };
  } catch (error) {
    return {
      name,
      nodes: null,
      edges: null,
      path,
      modifiedAt: "",
      error: error instanceof Error ? error.message : "invalid",
    };
  }
};

const pad = (value: string, width: number): string => value + " ".repeat(Math.max(0, width - value.length));

const printTable = (rows: ReadonlyArray<CanvasRow>): void => {
  if (rows.length === 0) {
    console.log(`no canvases found in ${canvasesDir()}`);
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

  await mkdir(canvasesDir(), { recursive: true });
  const files = (await readdir(canvasesDir())).filter((file) => file.endsWith(".canvas"));
  const rows = (await Promise.all(files.map(readRow))).slice().sort((a, b) => a.name.localeCompare(b.name));

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  printTable(rows);
};

await main();
