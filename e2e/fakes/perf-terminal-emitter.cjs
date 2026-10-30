#!/usr/bin/env node
// Emitter for the terminal performance baseline (e2e/scenarios/perf-terminal-baseline.spec.ts). Planted as the seat's harness binary.
// Deterministic Claude-like ANSI at a fixed byte rate, read live from a control
// file so one launch serves every condition. Echoes stdin so input-to-paint can
// be measured. Test only: never ships.
"use strict";
const fs = require("node:fs");

const CONTROL = process.env.PERF_EMIT_CONTROL || "__CONTROL__"; // {"bps": number, "seed": number, "working"?: boolean}
let bps = 0;
// Working seats paint what Codex paints mid-turn: a braille spinner in the OSC title and a
// "Working (esc to interrupt)" status line, so the real observer path marks them working.
let working = false;
let seed = 1;

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const readControl = () => {
  try {
    // A per-process file (CONTROL.<pid>) overrides the shared one.
    let path = CONTROL;
    try { fs.accessSync(CONTROL + "." + process.pid); path = CONTROL + "." + process.pid; } catch { /* shared */ }
    const c = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof c.bps === "number") bps = c.bps;
    working = c.working === true;
    if (typeof c.seed === "number" && c.seed !== seed) { seed = c.seed; rand = mulberry32(seed + salt); }
  } catch { /* absent control: stay quiet */ }
};

// Per-seat salt keeps seats distinct but reproducible: hash of the cwd.
const salt = [...process.cwd()].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) | 0, 7);
let rand = mulberry32(seed + salt);

const WORDS = "read edit write grep glob bash plan check test build file path diff merge ring seat mail canvas state".split(" "); // no capital Z, ever
const SGR = ["\x1b[2m", "\x1b[1m", "\x1b[36m", "\x1b[32m", "\x1b[33m", "\x1b[35m", "\x1b[90m"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spin = 0;
// One "frame" of Claude-like output: a redrawn status line (erase + move up) and
// a wrapped body line with SGR runs. Roughly 120 to 220 bytes.
const frame = () => {
  const words = [];
  const n = 8 + Math.floor(rand() * 10);
  for (let i = 0; i < n; i++) words.push(SGR[Math.floor(rand() * SGR.length)] + WORDS[Math.floor(rand() * WORDS.length)] + "\x1b[0m");
  const glyph = SPIN[spin++ % SPIN.length];
  const seconds = Math.floor(rand() * 90);
  const status = working
    ? `\x1b[2K\r• Working (${seconds}s • esc to interrupt)`
    : `\x1b[2K\r${glyph} \x1b[2mThinking… (${seconds}s)\x1b[0m`;
  const title = working ? `\x1b]0;${glyph} perf\x07` : "";
  return title + status + "\x1b[1A\x1b[2K\r" + words.join(" ") + "\r\n" + status + "\r\n";
};

// A probe (install check, --version) has no terminal: answer and leave, so it never counts as a seat.
if (!process.stdin.isTTY) { process.stdout.write("codex-cli 0.0.0-perf\n"); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (d) => process.stdout.write(d)); // echo as one atomic write

// Identity for the rig: pid, cwd and the JUNTO_* env the seat was given.
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("JUNTO")));
  fs.writeFileSync(CONTROL + ".started." + process.pid, JSON.stringify({ pid: process.pid, cwd: process.cwd(), env }));
} catch { /* the rig counts starts; a missing file shows as a missing seat */ }

readControl();
setInterval(readControl, 250);

// 16 ms ticks, bytes owed carried over so the long-run rate is exact.
let owed = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  owed += (bps * (now - last)) / 1000;
  last = now;
  let out = "";
  while (owed > 0) {
    const f = frame();
    out += f;
    owed -= Buffer.byteLength(f);
  }
  if (out) process.stdout.write(out);
}, 16);
