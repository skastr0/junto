/**
 * Scratch analysis (untracked): turn ~/grid-attrib/run.json into the attribution
 * the lead asked for. Phases come from the marks TerminalSurface writes; self
 * time by function comes from the CDP CPU profile of the same window.
 *
 * usage: bun scripts/zz-grid-open-attrib.ts [run.json]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

type Mark = { readonly name: string; readonly at: number };
type ProfileNode = {
  readonly id: number;
  readonly hitCount?: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
};
type Profile = {
  readonly nodes: ReadonlyArray<ProfileNode>;
  readonly samples: ReadonlyArray<number>;
  readonly timeDeltas: ReadonlyArray<number>;
  readonly startTime: number;
  readonly endTime: number;
};
type Run = {
  readonly anchor: { readonly timeOrigin: number; readonly now: number };
  readonly profileStartAt: number;
  readonly frames: ReadonlyArray<number>;
  readonly marks: ReadonlyArray<Mark>;
  readonly profile: Profile;
};

const path = process.argv[2] ?? `${homedir()}/grid-attrib/run.json`;
const comparePath = process.argv[3];
const run = JSON.parse(readFileSync(path, "utf8")) as Run;

/** The same numbers for a second run, so two arms read as one table. */
const compare = (second: Run, secondPath: string): void => {
  const self = (target: Run) => {
    const nodes = new Map(target.profile.nodes.map((node) => [node.id, node]));
    const per = new Map<string, number>();
    const totals = { program: 0, compile: 0, all: 0 };
    let at = 0;
    for (let index = 0; index < target.profile.samples.length; index += 1) {
      at += target.profile.timeDeltas[index] ?? 0;
      const node = nodes.get(target.profile.samples[index] ?? 0);
      const name = node?.callFrame.functionName || "(anonymous)";
      const ms = (target.profile.timeDeltas[index] ?? 0) / 1000;
      totals.all += ms;
      if (name === "(program)") totals.program += ms;
      if (/^Compile|^Parse|^Optimize|CompileLazy|ParseFunction|GetSharedFunctionInfo/.test(name)) totals.compile += ms;
      per.set(name, (per.get(name) ?? 0) + ms);
    }
    return { totals, per, top: [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) };
  };
  const first = self(run);
  const other = self(second);
  const round = (value: number): string => value.toFixed(1);
  console.log(`\ncompare ${path} vs ${secondPath}`);
  console.log(`  all samples      ${round(first.totals.all).padStart(8)} ms  vs ${round(other.totals.all).padStart(8)} ms`);
  console.log(`  (program)        ${round(first.totals.program).padStart(8)} ms  vs ${round(other.totals.program).padStart(8)} ms`);
  console.log(`  compile by name  ${round(first.totals.compile).padStart(8)} ms  vs ${round(other.totals.compile).padStart(8)} ms`);
  const names = new Set([...first.per.keys(), ...other.per.keys()]);
  const rows = [...names]
    .map((name) => ({ name, a: first.per.get(name) ?? 0, b: other.per.get(name) ?? 0 }))
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b))
    .slice(0, 10);
  for (const row of rows) {
    console.log(`  ${row.name.slice(0, 34).padEnd(34)} ${round(row.a).padStart(8)} ms  vs ${round(row.b).padStart(8)} ms`);
  }
};

if (comparePath !== undefined) {
  compare(JSON.parse(readFileSync(comparePath, "utf8")) as Run, comparePath);
  process.exit(0);
}

const ms = (value: number): string => value.toFixed(1);
const PHASES = ["ctor", "fit-addon", "open", "webgl", "fit"] as const;
const PREFIX = "junto-term-open:";

/** A mark is `junto-term-open:<key>:<phase>:<start|end>`, and a key may hold colons. */
export type ParsedMark = { readonly key: string; readonly phase: string; readonly edge: string };

export const parseMark = (name: string): ParsedMark | null => {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  if (rest.endsWith(":first-paint")) {
    const key = rest.slice(0, -":first-paint".length);
    return key === "" ? null : { key, phase: "first-paint", edge: "paint" };
  }
  const edgeAt = rest.lastIndexOf(":");
  const phaseAt = rest.lastIndexOf(":", edgeAt - 1);
  if (edgeAt < 0 || phaseAt < 0) return null;
  return { key: rest.slice(0, phaseAt), phase: rest.slice(phaseAt + 1, edgeAt), edge: rest.slice(edgeAt + 1) };
};

export type Cell = {
  readonly key: string;
  readonly phases: Readonly<Record<string, number>>;
  readonly firstPaint: number | null;
};

// --- phases, per cell -------------------------------------------------------
const cellMap = new Map<string, { marks: Map<string, number> }>();
for (const mark of run.marks) {
  const parsed = parseMark(mark.name);
  if (parsed === null) continue;
  const cell = cellMap.get(parsed.key) ?? { marks: new Map() };
  cell.marks.set(`${parsed.phase}:${parsed.edge}`, mark.at);
  cellMap.set(parsed.key, cell);
}

const cells: Cell[] = [];
for (const [key, cell] of cellMap) {
  const phases: Record<string, number> = {};
  for (const phase of PHASES) {
    const start = cell.marks.get(`${phase}:start`);
    const end = cell.marks.get(`${phase}:end`);
    if (start !== undefined && end !== undefined) phases[phase] = end - start;
  }
  const openStart = cell.marks.get("open:start") ?? cell.marks.get("ctor:start");
  const paint = cell.marks.get("first-paint:paint");
  cells.push({
    key,
    phases,
    firstPaint: paint !== undefined && openStart !== undefined ? paint - openStart : null,
  });
}
cells.sort((a, b) => (a.firstPaint ?? 0) - (b.firstPaint ?? 0));

console.log(`cells: ${cells.length}`);
const header = ["cell", ...PHASES, "first-paint"].map((label) => label.padEnd(12)).join("");
console.log(header);
const totals: Record<string, number> = {};
for (const cell of cells) {
  const row = [cell.key.replace(/^.*-/, "").slice(0, 10).padEnd(12)];
  for (const phase of PHASES) {
    const value = cell.phases[phase] ?? 0;
    totals[phase] = (totals[phase] ?? 0) + value;
    row.push(`${ms(value)}`.padEnd(12));
  }
  row.push(`${cell.firstPaint === null ? "-" : ms(cell.firstPaint)}`.padEnd(12));
  console.log(row.join(""));
}
if (cells.length > 0) {
  const average = (["cell", ...PHASES, "first-paint"] as const).slice(1).map((label) => {
    if (label === "first-paint") {
      const values = cells.map((c) => c.firstPaint ?? 0);
      return `${ms(values.reduce((a, b) => a + b, 0) / values.length)}`.padEnd(12);
    }
    return `${ms((totals[label] ?? 0) / cells.length)}`.padEnd(12);
  });
  console.log(["per cell".padEnd(12), ...average].join(""));
}
console.log("");

// --- frames -----------------------------------------------------------------
const frames = run.frames.slice(1);
if (frames.length > 0) {
  const sorted = [...frames].sort((a, b) => a - b);
  console.log(
    `frames: n=${frames.length} worst=${ms(sorted[sorted.length - 1] ?? 0)} p95=${ms(sorted[Math.floor(sorted.length * 0.95)] ?? 0)} median=${ms(sorted[Math.floor(sorted.length / 2)] ?? 0)}`,
  );
  const over = frames.filter((value) => value > 50).map((value) => ms(value));
  console.log(`frames over 50 ms: ${over.length ? over.join(", ") : "none"}`);
  console.log("");
}

// --- profile, self time by function inside the open window -------------------
const click = run.marks.find((mark) => mark.name === "junto-grid-open:click")?.at;
if (click === undefined) throw new Error("no click mark in the run");
// The window runs from the click to the last cell's first painted frame, plus
// a margin, because the profile's samples answer the question "what was the
// main thread doing while the open was happening".
const paintTimes = [...cellMap.values()]
  .map((cell) => cell.marks.get("first-paint:paint"))
  .filter((at): at is number => at !== undefined);
const windowEnd = (paintTimes.length > 0 ? Math.max(...paintTimes) : click + 400) + 250;

// Profile times are taken as relative to the profile's own start, anchored at
// the page reading the spec took immediately before Profiler.start. That holds
// whichever epoch the CDP profile reports.
const toPage = (micros: number): number =>
  run.profileStartAt + (micros - run.profile.startTime) / 1000;

const nodes = new Map(run.profile.nodes.map((node) => [node.id, node]));
const self = new Map<number, number>();
let at = 0;
const samples: Array<{ readonly page: number; readonly id: number; readonly us: number }> = [];
for (let i = 0; i < run.profile.samples.length; i += 1) {
  const delta = run.profile.timeDeltas[i] ?? 0;
  at += delta;
  const id = run.profile.samples[i] ?? 0;
  samples.push({ page: toPage(run.profile.startTime + at), id, us: delta });
}
const inWindow = samples.filter((sample) => sample.page >= click && sample.page <= windowEnd);
const firstSample = samples[0]?.page ?? 0;
const lastSample = samples[samples.length - 1]?.page ?? 0;
console.log(
  `clock check: click at ${ms(click)}, samples span ${ms(firstSample)} to ${ms(lastSample)}, window ends ${ms(windowEnd)}`,
);
for (const sample of inWindow) self.set(sample.id, (self.get(sample.id) ?? 0) + sample.us);
const totalUs = inWindow.reduce((sum, sample) => sum + sample.us, 0);
console.log(
  `profile: ${samples.length} samples, ${inWindow.length} in the open window (${ms(windowEnd - click)} ms), ${ms(totalUs / 1000)} ms of samples`,
);
const rows = [...self.entries()]
  .map(([id, us]) => {
    const node = nodes.get(id);
    const frame = node?.callFrame;
    return { us, name: frame?.functionName || "(anonymous)", url: (frame?.url ?? "").replace(/^.*\/node_modules\//, "nm/") };
  })
  .sort((a, b) => b.us - a.us)
  .slice(0, 30);
const width = Math.max(...rows.map((row) => row.name.length), 8);
for (const row of rows) {
  console.log(`${ms(row.us / 1000).padStart(8)} ms  ${row.name.padEnd(width)}  ${row.url.slice(0, 70)}`);
}
