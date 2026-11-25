/**
 * Terminal pipeline CPU microbench: recorded harness PTY bytes through the
 * production headless observer, viewport snapshot and seat-state machine.
 * It also writes the same byte chunks in a simple binary form for the Rust
 * parser/grid comparison generated under the output directory.
 *
 * Run on a VM:
 *   bun scripts/perf-terminal-pipeline.ts --out /tmp/term-pipe-bench
 *   cd /tmp/term-pipe-bench/rs && cargo build --release && ./target/release/vtebench
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { SessionObserver, setObserverWriteIntervalMs } from "../src/core/term/observer/session-observer";
import { SeatStateRuntime } from "../src/core/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/core/term/observer/types";

type Corpus = {
  readonly name: string;
  readonly harness: string;
  readonly file: string;
};

const ROOT = join(import.meta.dirname, "..");
const CORPORA: readonly Corpus[] = [
  { name: "claude", harness: "claude", file: "tests/pty-e2e/corpus/claude/working-turn.jsonl" },
  { name: "codex", harness: "codex", file: "tests/pty-e2e/corpus/codex/working-turn.jsonl" },
  { name: "devin", harness: "devin", file: "tests/pty-e2e/corpus/devin/working-turn.jsonl" },
];
const COLS = 120;
const ROWS = 32;
const REPS = 5;
const CHUNK_SIZES = [
  ["small", 270],
  ["frame", 2700],
] as const;

type Stats = { best: number; median: number };
type CaseResult = {
  corpus: string;
  mode: string;
  writes: number;
  meanBytes: number;
  xtermUs: Stats;
  observerUs: Stats;
  snapshotNowUs: Stats;
  seatStateUs: Stats;
  pipelineUs: Stats;
};

const cpuUs = (): number => {
  const u = process.cpuUsage();
  return u.user + u.system;
};
const cpuSince = (start: { user: number; system: number }): number => {
  const d = process.cpuUsage(start);
  return d.user + d.system;
};
const stats = (values: number[]): Stats => {
  const sorted = [...values].sort((a, b) => a - b);
  return { best: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0 };
};
const round = (n: number): number => Math.round(n * 100) / 100;

const loadCorpusText = (file: string): string => {
  const rows = readFileSync(join(ROOT, file), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { b64: string });
  return rows.map((row) => Buffer.from(row.b64, "base64").toString("utf8")).join("");
};

const rechunk = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
};

const writeXterm = (term: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve));

const benchRawXterm = async (chunks: readonly string[]): Promise<Stats> => {
  const reps: number[] = [];
  for (let r = 0; r < REPS; r += 1) {
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
    for (const chunk of chunks.slice(0, Math.min(30, chunks.length))) await writeXterm(term, chunk);
    const start = process.cpuUsage();
    for (const chunk of chunks) await writeXterm(term, chunk);
    reps.push(cpuSince(start) / chunks.length);
  }
  return stats(reps);
};

const benchObserver = async (
  chunks: readonly string[],
  harness: string,
): Promise<{ observer: Stats; snapshotNow: Stats; seatState: Stats; pipeline: Stats }> => {
  const observerReps: number[] = [];
  const snapshotReps: number[] = [];
  const seatReps: number[] = [];
  setObserverWriteIntervalMs(0);
  for (let r = 0; r < REPS; r += 1) {
    const observer = new SessionObserver({ bindingId: "bench", epoch: "bench", cols: COLS, rows: ROWS });
    observer.setWriteIntervalMs(0);
    let seq = 0n;
    for (const chunk of chunks.slice(0, Math.min(10, chunks.length))) {
      seq += 1n;
      observer.feed(chunk, seq);
      await observer.snapshot();
    }
    const snapshots: ObserverGridSnapshot[] = [];
    const start = process.cpuUsage();
    for (const chunk of chunks) {
      seq += 1n;
      observer.feed(chunk, seq);
      snapshots.push(await observer.snapshot());
    }
    observerReps.push(cpuSince(start) / chunks.length);

    let s0 = process.cpuUsage();
    for (let i = 0; i < snapshots.length; i += 1) observer.snapshotNow();
    snapshotReps.push(cpuSince(s0) / snapshots.length);

    const runtime = new SeatStateRuntime({ turnProgressWatch: false });
    runtime.bindHarness("bench", harness, "bench");
    s0 = process.cpuUsage();
    for (const snapshot of snapshots) runtime.observe(snapshot);
    seatReps.push(cpuSince(s0) / snapshots.length);
    runtime.stop();
    observer.dispose();
  }
  const observer = stats(observerReps);
  const seatState = stats(seatReps);
  return {
    observer,
    snapshotNow: stats(snapshotReps),
    seatState,
    pipeline: { best: observer.best + seatState.best, median: observer.median + seatState.median },
  };
};

const writeRustInputs = (out: string, name: string, chunks: readonly string[]): void => {
  const bytes = chunks.map((chunk) => Buffer.from(chunk, "utf8"));
  writeFileSync(join(out, `${name}.bin`), Buffer.concat(bytes));
  const lens = Buffer.alloc(bytes.length * 4);
  bytes.forEach((chunk, i) => lens.writeUInt32LE(chunk.length, i * 4));
  writeFileSync(join(out, `${name}.len`), lens);
};

const rustMain = (names: readonly string[]): string => `use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi;
use std::fs;

struct Size;
impl Dimensions for Size {
    fn total_lines(&self) -> usize { ${ROWS} }
    fn screen_lines(&self) -> usize { ${ROWS} }
    fn columns(&self) -> usize { ${COLS} }
}

struct Nop;
impl vte::Perform for Nop {}

fn cpu_us() -> f64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let t = |v: libc::timeval| v.tv_sec as f64 * 1e6 + v.tv_usec as f64;
    t(u.ru_utime) + t(u.ru_stime)
}

fn load(name: &str) -> Vec<Vec<u8>> {
    let bin = fs::read(format!("../{name}.bin")).unwrap();
    let len = fs::read(format!("../{name}.len")).unwrap();
    let mut at = 0;
    len.chunks(4).map(|c| {
        let n = u32::from_le_bytes([c[0], c[1], c[2], c[3]]) as usize;
        let v = bin[at..at + n].to_vec();
        at += n;
        v
    }).collect()
}

fn passes(chunks: &[Vec<u8>], mut f: impl FnMut(&[u8])) -> (f64, f64) {
    for c in chunks.iter().take(30) { f(c); }
    let mut reps: Vec<f64> = (0..${REPS}).map(|_| {
        let t = cpu_us();
        for c in chunks { f(c); }
        (cpu_us() - t) / chunks.len() as f64
    }).collect();
    reps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (reps[0], reps[2])
}

fn main() {
    for name in [${names.map((n) => `"${n}"`).join(", ")}] {
        let chunks = load(name);
        let mut parser = vte::Parser::new();
        let mut nop = Nop;
        let (b, m) = passes(&chunks, |c| parser.advance(&mut nop, c));
        println!("rust-vte {name} best_us={b:.2} median_us={m:.2}");

        let config = Config { scrolling_history: 2000, ..Config::default() };
        let mut term = Term::new(config, &Size, VoidListener);
        let mut processor: ansi::Processor = ansi::Processor::new();
        let (b, m) = passes(&chunks, |c| processor.advance(&mut term, c));
        println!("rust-grid {name} best_us={b:.2} median_us={m:.2}");
    }
}
`;

const writeRustProject = (out: string, names: readonly string[]): void => {
  const rs = join(out, "rs");
  mkdirSync(join(rs, "src"), { recursive: true });
  writeFileSync(join(rs, "Cargo.toml"), `[package]\nname = "vtebench"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nvte = "0.15"\nalacritty_terminal = "0.25"\nlibc = "0.2"\n\n[profile.release]\nopt-level = 3\nlto = true\ncodegen-units = 1\n`);
  writeFileSync(join(rs, "src/main.rs"), rustMain(names));
};

const main = async (): Promise<void> => {
  const out = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : "/tmp/term-pipe-bench";
  mkdirSync(out, { recursive: true });
  const results: CaseResult[] = [];
  const rustNames: string[] = [];
  for (const corpus of CORPORA) {
    const text = loadCorpusText(corpus.file);
    for (const [mode, size] of CHUNK_SIZES) {
      const chunks = rechunk(text, size);
      const name = `${corpus.name}-${mode}`;
      rustNames.push(name);
      writeRustInputs(out, name, chunks);
      const xterm = await benchRawXterm(chunks);
      const observer = await benchObserver(chunks, corpus.harness);
      const meanBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0) / chunks.length;
      results.push({
        corpus: corpus.name,
        mode,
        writes: chunks.length,
        meanBytes,
        xtermUs: { best: round(xterm.best), median: round(xterm.median) },
        observerUs: { best: round(observer.observer.best), median: round(observer.observer.median) },
        snapshotNowUs: { best: round(observer.snapshotNow.best), median: round(observer.snapshotNow.median) },
        seatStateUs: { best: round(observer.seatState.best), median: round(observer.seatState.median) },
        pipelineUs: { best: round(observer.pipeline.best), median: round(observer.pipeline.median) },
      });
      console.log(`${name} writes=${chunks.length} meanB=${meanBytes.toFixed(0)} xterm_us=${round(xterm.median)} observer_us=${round(observer.observer.median)} seat_us=${round(observer.seatState.median)} pipeline_us=${round(observer.pipeline.median)}`);
    }
  }
  writeRustProject(out, rustNames);
  writeFileSync(join(out, "js-results.json"), `${JSON.stringify({ cols: COLS, rows: ROWS, reps: REPS, results }, null, 2)}\n`);
  console.log(`wrote ${join(out, "js-results.json")}; rust project ${join(out, "rs")}`);
};

await main();
