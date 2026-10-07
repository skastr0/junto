/**
 * Verifier lab measurement: what dragging a selection costs the window.
 * On the open canvas it selects several seat cards with real clicks, drags
 * them with real mouse moves at one move per frame, and records the frame
 * intervals during the drag and in the second after the drop.
 *
 *   bun scripts/verify-lab-drag.ts [--select 10] [--steps 90] [--repeats 5] [--out DIR]
 *
 * Run after scripts/verify-lab-canvas.ts, under the app-run lock.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const select = Number(arg("select", "10"));
const steps = Number(arg("steps", "90"));
const repeats = Number(arg("repeats", "5"));
const rendererPort = process.env.JUNTO_PERF_LAB_RENDERER_PORT ?? "9229";
const outDir = resolve(arg("out", "."));
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const targets = (await (await fetch(`http://127.0.0.1:${rendererPort}/json/list`)).json()) as Array<{ type: string; title?: string; webSocketDebuggerUrl: string }>;
const target = targets.find((t) => t.type === "page" && (t.title ?? "").startsWith("Junto"));
if (!target) {
  console.error("verify lab: lab window not reachable");
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((ok) => (ws.onopen = () => ok()));
let next = 1;
const waiting = new Map<number, (value: any) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const done = message.id === undefined ? undefined : waiting.get(message.id);
  if (done) {
    waiting.delete(message.id);
    done(message);
  }
};
const send = async (method: string, params: object): Promise<any> => {
  const id = next++;
  const reply = await new Promise<any>((done) => {
    waiting.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const evaluate = async <T>(expression: string): Promise<T> => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value as T;
};
const mouse = (type: string, x: number, y: number, extra: object = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });

// Seat cards that are fully on screen, top-left first.
const cards = await evaluate<Array<{ id: string; x: number; y: number }>>(`(() => [...document.querySelectorAll(".react-flow__node")]
  .filter((card) => (card.getAttribute("data-id") ?? "").startsWith("verify-seat-"))
  .map((card) => { const box = card.getBoundingClientRect(); return { id: card.getAttribute("data-id"), x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height }; })
  .filter((box) => box.x > 40 && box.y > 80 && box.x < innerWidth - 40 && box.y < innerHeight - 160 && box.w > 6 && box.h > 6)
  .sort((a, b) => a.y - b.y || a.x - b.x))()`);
if (cards.length < select) {
  console.error(`verify lab: only ${String(cards.length)} seat cards on screen, need ${String(select)}`);
  process.exit(1);
}
const chosen = cards.slice(0, select);
// 8 is the Shift modifier: the app extends a selection with shift-click.
await mouse("mousePressed", chosen[0]!.x, chosen[0]!.y);
await mouse("mouseReleased", chosen[0]!.x, chosen[0]!.y);
for (const card of chosen.slice(1)) {
  await mouse("mousePressed", card.x, card.y, { modifiers: 8 });
  await mouse("mouseReleased", card.x, card.y, { modifiers: 8 });
  await sleep(60);
}
await sleep(500);
const world = () =>
  evaluate<{ selected: number; nodes: number; edges: number; positions: Record<string, string> }>(`(() => ({
    selected: document.querySelectorAll(".react-flow__node.selected").length,
    nodes: document.querySelectorAll(".react-flow__node").length,
    edges: document.querySelectorAll(".react-flow__edge").length,
    positions: Object.fromEntries(${JSON.stringify(chosen.map((card) => card.id))}.map((id) => [id, document.querySelector('.react-flow__node[data-id="' + id + '"]')?.style.transform ?? ""])),
  }))()`);
const before = await world();
console.log(JSON.stringify({ selected: before.selected, wanted: select, nodes: before.nodes, edges: before.edges, loadAverage: loadavg() }));

await evaluate(`(() => {
  window.__verifyDrag?.stop();
  const tally = { frames: [], spans: [], marks: [], stopped: false };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith("junto:")) continue;
      if (entry.entryType === "measure") tally.spans.push([entry.name.slice(6), entry.duration]);
      else tally.marks.push(entry.name.slice(6));
    }
  });
  observer.observe({ entryTypes: ["measure", "mark"] });
  let last = performance.now();
  const frame = (now) => {
    if (tally.stopped) return;
    tally.frames.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  tally.stop = () => { tally.stopped = true; observer.disconnect(); };
  tally.take = () => {
    const out = { frames: tally.frames, spans: tally.spans, marks: tally.marks };
    tally.frames = []; tally.spans = []; tally.marks = [];
    return out;
  };
  window.__verifyDrag = tally;
})()`);
type Tally = { frames: number[]; spans: Array<[string, number]>; marks: string[] };
const take = () => evaluate<Tally>(`window.__verifyDrag.take()`);
const summarize = (label: string, tally: Tally, extra: object = {}) => {
  const frames = [...tally.frames].sort((a, b) => a - b);
  const at = (q: number) => Math.round((frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] ?? 0) * 10) / 10;
  const by = new Map<string, { count: number; ms: number }>();
  for (const [name, ms] of tally.spans) {
    const slot = by.get(name) ?? { count: 0, ms: 0 };
    slot.count += 1;
    slot.ms += ms;
    by.set(name, slot);
  }
  const marks = new Map<string, number>();
  for (const mark of tally.marks) marks.set(mark, (marks.get(mark) ?? 0) + 1);
  return {
    label,
    frames: frames.length,
    frameMs: { median: at(0.5), p95: at(0.95), max: at(1) },
    over33ms: frames.filter((ms) => ms > 33).length,
    spans: Object.fromEntries([...by].map(([name, slot]) => [name, { count: slot.count, ms: Math.round(slot.ms * 10) / 10 }])),
    marks: Object.fromEntries(marks),
    ...extra,
  };
};

const rows: unknown[] = [];
await sleep(1_000);
await take();
await sleep(2_000);
rows.push(summarize("quiet 2 s, selection held", await take()));
console.log(JSON.stringify(rows.at(-1)));

const grip = chosen[0]!;
let movedOnFirstDrag = -1;
for (let repeat = 0; repeat < repeats; repeat += 1) {
  const direction = repeat % 2 === 0 ? 1 : -1;
  await take();
  await mouse("mousePressed", grip.x, grip.y);
  const started = Date.now();
  for (let step = 1; step <= steps; step += 1) {
    await mouse("mouseMoved", grip.x + direction * step * 2, grip.y + direction * step, { buttons: 1 });
    await sleep(14);
  }
  const dragMs = Date.now() - started;
  const during = await take();
  await mouse("mouseReleased", grip.x + direction * steps * 2, grip.y + direction * steps);
  await sleep(1_200);
  const after = await take();
  if (repeat === 0) {
    const dropped = await world();
    movedOnFirstDrag = Object.keys(before.positions).filter((id) => before.positions[id] !== dropped.positions[id]).length;
  }
  // Back where it started, unmeasured, so every repeat drags the same way.
  await mouse("mousePressed", grip.x + direction * steps * 2, grip.y + direction * steps);
  await mouse("mouseMoved", grip.x, grip.y, { buttons: 1 });
  await mouse("mouseReleased", grip.x, grip.y);
  await sleep(1_200);
  rows.push(summarize("drag", during, { repeat, moves: steps, dragMs }));
  console.log(JSON.stringify(rows.at(-1)));
  rows.push(summarize("1.2 s after the drop", after, { repeat }));
  console.log(JSON.stringify(rows.at(-1)));
}
const atEnd = await world();
console.log(JSON.stringify({ selectedAtEnd: atEnd.selected, cardsMovedByTheFirstDrag: movedOnFirstDrag }));

await evaluate(`window.__verifyDrag.stop()`);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ select, steps, repeats, world: { selected: before.selected, nodes: before.nodes, edges: before.edges, cardsMovedByTheFirstDrag: movedOnFirstDrag }, rows, loadAverage: loadavg() }, null, 2)}\n`);
ws.close();
