#!/usr/bin/env bun
/**
 * Maps a bundle line from a log back to source, with a release's source map
 * archive (scripts/collect-sourcemaps.ts):
 *
 *   bun scripts/sourcemap-resolve.ts <archive.tar.gz | folder> <bundle>:<line>[:<column>]
 *
 * <bundle> is what the log prints, in any of these forms:
 *   junto-app://renderer/assets/index-FcIFvAbn.js:17415   (a renderer error in app.jsonl)
 *   out/main/core-process.js:2140:17                       (a path inside the build)
 *   core-process.js:2140                                   (a name; refused if two bundles share it)
 * A log that names only a line (the renderer's does) gets every original
 * position that line holds; with a column, the one segment it falls in.
 * Prints the original file, line and column, and the line itself when the map
 * carries the sources. docs/source-maps.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "./collect-sourcemaps";
import { decodeSegments, lineOrigins, lookup, type RawSourceMap, type Segment } from "./source-map-lookup";

export type Target = { readonly bundle: string; readonly line: number; readonly column: number | undefined };

/** A logged location: `<bundle>:<line>` or `<bundle>:<line>:<column>`. */
export const parseTarget = (text: string): Target => {
  const match = /^(.*?):(\d+)(?::(\d+))?$/u.exec(text.trim().replace(/^\(|\)$/gu, ""));
  if (match === null) throw new Error(`not a location: ${text} (want <bundle>:<line>[:<column>])`);
  const bundle = (match[1] ?? "").replace(/^[a-z-]+:\/\/[^/]*\//u, "").replace(/^\/+/u, "");
  return { bundle, line: Number(match[2]), column: match[3] === undefined ? undefined : Number(match[3]) };
};

/** The one manifest entry a logged bundle names. */
export const pickEntry = (manifest: Manifest, bundle: string): Manifest["maps"][number] => {
  const wanted = bundle.split("?")[0] ?? bundle;
  const exact = manifest.maps.filter((entry) => entry.bundle === wanted || entry.bundle === `out/renderer/${wanted}`);
  const found = exact.length > 0 ? exact : manifest.maps.filter((entry) => basename(entry.bundle) === basename(wanted));
  if (found.length === 0) throw new Error(`no source map for ${bundle} in this archive (${manifest.version}, ${manifest.commit.slice(0, 12)})`);
  if (found.length > 1) throw new Error(`${bundle} is ambiguous: ${found.map((entry) => entry.bundle).join(", ")}`);
  return found[0] as Manifest["maps"][number];
};

const show = (segment: Segment, map: RawSourceMap): string => {
  const index = map.sources.indexOf(segment.source);
  const text = index >= 0 ? map.sourcesContent?.[index]?.split("\n")[segment.sourceLine - 1] : undefined;
  const where = `${segment.source}:${String(segment.sourceLine)}:${String(segment.sourceColumn + 1)}${segment.name === undefined ? "" : ` (${segment.name})`}`;
  return text === undefined ? where : `${where}\n    ${text.trim().slice(0, 200)}`;
};

export const resolveLocation = (folder: string, target: Target): string => {
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Manifest;
  const entry = pickEntry(manifest, target.bundle);
  const map = JSON.parse(readFileSync(join(folder, entry.map), "utf8")) as RawSourceMap;
  const segments = decodeSegments(map);
  const header = `${entry.bundle}:${String(target.line)}${target.column === undefined ? "" : `:${String(target.column)}`}  (${manifest.version}, commit ${manifest.commit.slice(0, 12)})`;
  if (target.column !== undefined) {
    const segment = lookup(segments, target.line, target.column);
    return `${header}\n  ${segment === undefined ? "no mapping at that position" : show(segment, map)}`;
  }
  const origins = lineOrigins(segments, target.line);
  if (origins.length === 0) return `${header}\n  no mapping on that line`;
  return `${header}\n${origins.slice(0, 20).map((segment) => `  ${show(segment, map)}`).join("\n")}`;
};

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const [source, location] = process.argv.slice(2);
  if (source === undefined || location === undefined || process.argv.length !== 4) {
    console.error("usage: bun scripts/sourcemap-resolve.ts <archive.tar.gz | folder> <bundle>:<line>[:<column>]");
    process.exitCode = 2;
  } else {
    let staged: string | undefined;
    try {
      let folder = resolve(source);
      if (!existsSync(folder)) throw new Error(`${folder} does not exist`);
      if (!statSync(folder).isDirectory()) {
        staged = mkdtempSync(join(tmpdir(), "junto-sourcemap-resolve-"));
        const untar = spawnSync("tar", ["-xzf", folder, "-C", staged], { encoding: "utf8" });
        if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
        folder = staged;
      }
      console.log(resolveLocation(folder, parseTarget(location)));
    } catch (error) {
      console.error(`junto: error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      if (staged !== undefined) rmSync(staged, { recursive: true, force: true });
    }
  }
}
