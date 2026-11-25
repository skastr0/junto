/**
 * Seat-state CPU profile: replays one harness corpus through the production
 * observer once to collect snapshots, then loops SeatStateRuntime.observe
 * over them so a CPU profile (bun --cpu-prof) is dominated by seat state.
 *
 *   bun --cpu-prof --cpu-prof-dir /tmp/ss-prof scripts/profile-seat-state.ts claude 40
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionObserver, setObserverWriteIntervalMs } from "../src/core/term/observer/session-observer";
import { SeatStateRuntime } from "../src/core/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/core/term/observer/types";

const ROOT = join(import.meta.dirname, "..");
const harness = process.argv[2] ?? "claude";
const loops = Number(process.argv[3] ?? 40);
const text = readFileSync(join(ROOT, `tests/pty-e2e/corpus/${harness}/working-turn.jsonl`), "utf8")
  .trim().split("\n").filter(Boolean)
  .map((l) => Buffer.from((JSON.parse(l) as { b64: string }).b64, "base64").toString("utf8")).join("");
const chunks: string[] = [];
for (let at = 0; at < text.length; at += 270) chunks.push(text.slice(at, at + 270));

setObserverWriteIntervalMs(0);
const observer = new SessionObserver({ bindingId: "bench", epoch: "bench", cols: 120, rows: 32 });
observer.setWriteIntervalMs(0);
const snaps: ObserverGridSnapshot[] = [];
let seq = 0n;
for (const c of chunks) { seq += 1n; observer.feed(c, seq); snaps.push(await observer.snapshot()); }
observer.dispose();

const t0 = process.cpuUsage();
for (let i = 0; i < loops; i += 1) {
  const runtime = new SeatStateRuntime({ turnProgressWatch: false });
  runtime.bindHarness("bench", harness, "bench");
  for (const s of snaps) runtime.observe(s);
  runtime.stop();
}
const d = process.cpuUsage(t0);
console.log(`${harness}: ${((d.user + d.system) / (loops * snaps.length)).toFixed(1)} us per observe over ${snaps.length} snapshots x ${loops}`);
