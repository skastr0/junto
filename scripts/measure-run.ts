#!/usr/bin/env bun
/**
 * One receipt per tool run: wall time, CPU seconds (the whole process tree,
 * from /usr/bin/time), peak RSS of the largest process, peak RSS summed over
 * the tree and the peak process count (sampled every 250 ms), and the machine
 * load and idle CPU when the run started. CPU seconds and RSS hold up under
 * a loaded machine; wall time does not, so read it with the load beside it.
 *
 *   bun scripts/measure-run.ts --label tsc-5.9-cold -- ./node_modules/.bin/tsc --noEmit
 *
 * Prints the receipt as one JSON line on stderr and appends it to
 * $JUNTO_MEASURE_LEDGER (default docs/research/tooling/measure-runs.ndjson).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = process.env.JUNTO_MEASURE_LEDGER ?? join(ROOT, "docs/research/tooling/measure-runs.ndjson");

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const labelAt = argv.indexOf("--label");
if (split < 0 || labelAt < 0 || labelAt > split || split === argv.length - 1) {
  console.error("usage: bun scripts/measure-run.ts --label <name> -- <command...>");
  process.exit(2);
}
const label = argv[labelAt + 1]!;
const command = argv.slice(split + 1);

const idleOverOneSecond = async (): Promise<number> => {
  const sum = () =>
    cpus().reduce(
      (acc, cpu) => {
        const t = cpu.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const a = sum();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const b = sum();
  return Math.round(((b.idle - a.idle) / Math.max(1, b.total - a.total)) * 1000) / 10;
};

type Row = { readonly pid: number; readonly ppid: number; readonly rssKiB: number };
const processTable = async (): Promise<Row[]> => {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss="], { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((cols) => cols.length === 3 && cols.every(Number.isFinite))
    .map(([pid, ppid, rssKiB]) => ({ pid: pid!, ppid: ppid!, rssKiB: rssKiB! }));
};
const tree = (rows: Row[], root: number): Row[] => {
  const children = new Map<number, Row[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const out: Row[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      walk(child.pid);
    }
  };
  walk(root);
  return out;
};

const load1 = loadavg()[0]!;
const idlePct = await idleOverOneSecond();
const started = performance.now();

// /usr/bin/time waits on the command, so its CPU totals include every
// descendant the command waited for. Its report is the last lines of stderr.
const child = spawn("/usr/bin/time", ["-l", ...command], { cwd: process.cwd(), stdio: ["inherit", "inherit", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  stderr += text;
  process.stderr.write(text);
});

let peakTreeKiB = 0;
let peakProcs = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const members = tree(await processTable(), child.pid!);
    peakTreeKiB = Math.max(peakTreeKiB, members.reduce((acc, row) => acc + row.rssKiB, 0));
    peakProcs = Math.max(peakProcs, members.length);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();

const exitCode: number = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
sampling = false;
await sampler;
const wallS = (performance.now() - started) / 1000;

const timed = stderr.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys[\s\S]*?(\d+)\s+maximum resident set size/u);
const userS = timed ? Number(timed[2]) : null;
const sysS = timed ? Number(timed[3]) : null;
const receipt = {
  label,
  command: command.join(" "),
  at: new Date().toISOString(),
  exitCode,
  wallS: Math.round(wallS * 100) / 100,
  cpuS: userS !== null && sysS !== null ? Math.round((userS + sysS) * 100) / 100 : null,
  userS,
  sysS,
  maxRssMiB: timed ? Math.round(Number(timed[4]) / 1048576) : null,
  peakTreeRssMiB: Math.round(peakTreeKiB / 1024),
  peakProcs,
  load1AtStart: Math.round(load1 * 10) / 10,
  idlePctAtStart: idlePct,
  cores: cpus().length,
};
mkdirSync(dirname(LEDGER), { recursive: true });
appendFileSync(LEDGER, `${JSON.stringify(receipt)}\n`);
console.error(`measure-run: ${JSON.stringify(receipt)}`);
process.exit(exitCode);
