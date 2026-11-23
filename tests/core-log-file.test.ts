/**
 * Every core keeps its log file, the one inside the app as well as a
 * windowless one (docs/machines.md, "Every machine keeps a log"). The app's
 * core logged to its ring alone, so the end that dials every link wrote no
 * row of it to disk: weeks of the operator's link failures were readable only
 * on the far machine.
 *
 * The log is built in a child process, since `console.*` routing is
 * process-wide: the child writes a console line and an Effect row, and the
 * file under a fresh home holds both, as `core`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineLogRow } from "../src/shared/machine-log";
import { Schema } from "effect";

const ROOT = join(import.meta.dirname, "..");
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const writeInChild = (home: string, echo: boolean) => spawnSync("bun", ["-e", `
  const { Effect } = await import("effect");
  const { openCoreLog } = await import(${JSON.stringify(join(ROOT, "src/core/core-log.ts"))});
  const log = openCoreLog({ home: ${JSON.stringify(home)}, echo: ${String(echo)} });
  console.info("[core] pid 4242");
  await Effect.runPromise(Effect.logWarning("link dial failed").pipe(
    Effect.annotateLogs({ area: "link", machine: "mini" }), Effect.provide(log.loggerLayer)));
  log.closeFile();
`], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });

const rowsIn = (home: string) => readFileSync(join(home, ".junto", "logs", "core.jsonl"), "utf8")
  .trim().split("\n").map((line) => Schema.decodeUnknownSync(MachineLogRow)(JSON.parse(line)));

describe("a core's log file", () => {
  for (const echo of [true, false]) {
    it(`holds the core's console lines and Effect rows, echo ${String(echo)}`, () => {
      const home = mkdtempSync(join(tmpdir(), "junto-core-log-"));
      homes.push(home);
      const child = writeInChild(home, echo);
      expect(child.status, child.stderr).toBe(0);
      const rows = rowsIn(home);
      expect(rows.every((row) => row.process === "core")).toBe(true);
      // A core's console line is the core's own, never written as main's.
      expect(rows.find((row) => row.message.includes("[core] pid 4242"))).toMatchObject({ source: "core", area: "core" });
      expect(rows.some((row) => row.area === "link" && row.level === "warn" && row.message === "link dial failed")).toBe(true);
      // Only an echoing core prints its rows: a windowless core's stdout is an unbounded service file.
      expect(child.stdout.includes("link dial failed")).toBe(echo);
    });
  }

  it("is opened by both core entries, through the one helper", () => {
    for (const entry of ["src/core/entry.ts", "src/core/headless.ts"]) {
      const source = readFileSync(join(ROOT, entry), "utf8");
      expect(source, entry).toMatch(/\bopenCoreLog\(\{ home/);
      expect(source, entry).not.toMatch(/\bcreateLogger\(/);
    }
  });
});
