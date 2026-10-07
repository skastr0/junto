/**
 * Verifier lab measurement: what dragging a selection costs the window.
 * On the open canvas it selects several seat cards with real clicks, drags
 * them with real mouse moves at one move per frame, and records the frame
 * intervals during the drag and in the second after the drop.
 *
 *   bun scripts/verify-lab-drag.ts [--select 10] [--steps 90] [--repeats 5] [--profile-first] [--out DIR]
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
const profileFirst = process.argv.includes("--profile-first");
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
const seatsOnScreen = () => evaluate<Array<{ id: string; x: number; y: number }>>(`(() => [...document.querySelectorAll(".react-flow__node")]
  .filter((card) => (card.getAttribute("data-id") ?? "").startsWith("verify-seat-"))
  .map((card) => { const box = card.getBoundingClientRect(); return { id: card.getAttribute("data-id"), x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height }; })
  .filter((box) => box.x > 40 && box.y > 80 && box.x < innerWidth - 40 && box.y < innerHeight - 160 && box.w > 6 && box.h > 6)
  .sort((a, b) => a.y - b.y || a.x - b.x))()`);
// A canvas opens at a readable zoom that may show only a few cards. Zoom out
// with the pinch gesture (wheel with Ctrl) until enough seats are on screen,
// or zooming out stops helping.
let cards = await seatsOnScreen();
let zoomSteps = 0;
for (let tries = 0; tries < 14 && cards.length < select; tries += 1) {
  const size = await evaluate<{ w: number; h: number }>(`({ w: innerWidth, h: innerHeight })`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(size.w / 2), y: Math.round(size.h / 2), deltaX: 0, deltaY: 120, modifiers: 2 });
  await sleep(450);
  const next = await seatsOnScreen();
  zoomSteps += 1;
  if (next.length < cards.length) break;
  cards = next;
}
await sleep(800);
cards = await seatsOnScreen();
console.log(JSON.stringify({ zoomOutSteps: zoomSteps, seatCardsOnScreen: cards.length, viewport: await evaluate<string>(`document.querySelector(".react-flow__viewport")?.style.transform ?? ""`) }));
if (cards.length < 3) {
  console.error(`verify lab: only ${String(cards.length)} seat cards on screen, need at least 3`);
  process.exit(1);
}
// Fewer on screen than asked for is reported, not fatal.
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

// Each repeat is a real drag of the same selection, alternating direction, so
// the cards go out and come back. Before every press the grip card is found
// again and the selection is counted, and after every drop the cards are
// checked to have moved: a press that misses the card drags nothing, and
// would read as a fast drag.
let movedOnFirstDrag = -1;
const gripNow = () =>
  evaluate<{ x: number; y: number; selected: number } | null>(`(() => {
    const card = document.querySelector('.react-flow__node[data-id="${chosen[0]!.id}"]');
    if (!card) return null;
    const box = card.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, selected: document.querySelectorAll(".react-flow__node.selected").length };
  })()`);
const routed = () =>
  evaluate<{ total: number; byTrigger: Record<string, number> } | null>(`(() => {
    const snap = typeof juntoPerf === "object" ? juntoPerf.snapshot() : null;
    return snap ? { total: snap.routeWireInvocations, byTrigger: snap.routeWireByTrigger } : null;
  })()`);
const less = (after: Record<string, number> | undefined, before: Record<string, number> | undefined) =>
  Object.fromEntries(Object.entries(after ?? {}).map(([key, value]) => [key, value - (before?.[key] ?? 0)]).filter(([, value]) => value !== 0));
for (let repeat = 0; repeat < repeats; repeat += 1) {
  const direction = repeat % 2 === 0 ? 1 : -1;
  const grip = await gripNow();
  if (!grip) break;
  const before = await world();
  const routedBefore = await routed();
  await take();
  if (profileFirst && repeat === 0) {
    await send("Profiler.enable", {});
    await send("Profiler.start", {});
  }
  await mouse("mousePressed", grip.x, grip.y);
  const started = Date.now();
  for (let step = 1; step <= steps; step += 1) {
    await mouse("mouseMoved", grip.x + direction * step * 2, grip.y + direction * step, { buttons: 1 });
    await sleep(14);
  }
  const dragMs = Date.now() - started;
  const during = await take();
  const routedDrag = await routed();
  if (profileFirst && repeat === 0) {
    // Where the window's main thread spent the first drag, by function.
    const { profile } = await send("Profiler.stop", {});
    const self = new Map<number, number>();
    const deltas: number[] = profile.timeDeltas ?? [];
    (profile.samples as number[]).forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (deltas[index] ?? 0)));
    const by = new Map<string, number>();
    for (const node of profile.nodes as Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>) {
      const ms = (self.get(node.id) ?? 0) / 1000;
      if (ms === 0) continue;
      const file = node.callFrame.url.split("/").at(-1) ?? "";
      const key = `${node.callFrame.functionName || "(anonymous)"} ${file}:${String(node.callFrame.lineNumber)}`;
      by.set(key, (by.get(key) ?? 0) + ms);
    }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, ms]) => [name, Math.round(ms)]);
    writeFileSync(join(outDir, "first-drag.cpuprofile"), JSON.stringify(profile));
    console.log(JSON.stringify({ firstDragSelfMsByFunction: top }));
  }
  // The drop, timed on its own: from the release until the page next answers,
  // then the frames of the three seconds after.
  const released = Date.now();
  await mouse("mouseReleased", grip.x + direction * steps * 2, grip.y + direction * steps);
  await evaluate<number>(`new Promise((done) => requestAnimationFrame(() => done(performance.now())))`);
  const dropMs = Date.now() - released;
  await sleep(3_000);
  const after = await take();
  const routedDrop = await routed();
  const dropped = await world();
  const moved = Object.keys(before.positions).filter((id) => before.positions[id] !== dropped.positions[id]).length;
  if (repeat === 0) movedOnFirstDrag = moved;
  const facts = { repeat, direction: direction === 1 ? "down-right" : "up-left", selectedBeforePress: grip.selected, cardsMoved: moved };
  rows.push(summarize("drag", during, { ...facts, moves: steps, dragMs, routeWire: routedBefore && routedDrag ? routedDrag.total - routedBefore.total : null, routeWireByTrigger: less(routedDrag?.byTrigger, routedBefore?.byTrigger) }));
  console.log(JSON.stringify(rows.at(-1)));
  rows.push(summarize("3 s after the drop", after, { ...facts, dropMs, routeWire: routedDrag && routedDrop ? routedDrop.total - routedDrag.total : null, routeWireByTrigger: less(routedDrop?.byTrigger, routedDrag?.byTrigger) }));
  console.log(JSON.stringify(rows.at(-1)));
}
const atEnd = await world();
console.log(JSON.stringify({ selectedAtEnd: atEnd.selected, cardsMovedByTheFirstDrag: movedOnFirstDrag }));

await evaluate(`window.__verifyDrag.stop()`);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ select, steps, repeats, world: { selected: before.selected, nodes: before.nodes, edges: before.edges, cardsMovedByTheFirstDrag: movedOnFirstDrag }, rows, loadAverage: loadavg() }, null, 2)}\n`);
ws.close();
