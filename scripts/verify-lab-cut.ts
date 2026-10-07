/**
 * Verifier lab check for the storage cut: a canvas made before the cut, read
 * and changed through the model after it.
 *
 *   bun scripts/verify-lab-cut.ts snapshot --canvas NAME --file F   old build: save the document
 *   bun scripts/verify-lab-cut.ts compare  --canvas NAME --file F   new build: modelOpen against it
 *   bun scripts/verify-lab-cut.ts change   --canvas NAME --file F   new build: move, rename, wire, delete
 *   bun scripts/verify-lab-cut.ts confirm  --canvas NAME --file F   after a restart: the changes held
 *
 * Run under the app-run lock against the lab app.
 */
import { readFileSync, writeFileSync } from "node:fs";

const phase = process.argv[2] ?? "";
const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const canvas = arg("canvas", "");
const file = arg("file", "");
const rendererPort = process.env.JUNTO_PERF_LAB_RENDERER_PORT ?? "9229";
if (!["snapshot", "compare", "change", "confirm"].includes(phase) || canvas === "" || file === "") {
  console.error("usage: verify-lab-cut.ts snapshot|compare|change|confirm --canvas NAME --file F");
  process.exit(64);
}
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
const evaluate = async <T>(expression: string): Promise<T> => {
  const id = next++;
  const reply = await new Promise<any>((done) => {
    waiting.set(id, done);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 600));
  return reply.result.result.value as T;
};
const name = JSON.stringify(canvas);
type Row = Record<string, any>;
const byId = (rows: ReadonlyArray<Row>) => new Map(rows.map((row) => [row.id as string, row]));
const opened = () => evaluate<{ seq: number; nodes: Row[]; wires: Row[] }>(`window.junto.modelOpen({ canvas: ${name} })`);

if (phase === "snapshot") {
  const doc = await evaluate<{ nodes: Row[]; edges: Row[] }>(`window.junto.readCanvas(${name}).then((read) => read.doc)`);
  writeFileSync(file, JSON.stringify({ doc }));
  console.log(JSON.stringify({ phase, nodes: doc.nodes.length, edges: doc.edges.length }));
}

if (phase === "compare") {
  const { doc } = JSON.parse(readFileSync(file, "utf8")) as { doc: { nodes: Row[]; edges: Row[] } };
  const now = await opened();
  const nodes = byId(now.nodes);
  const wires = byId(now.wires);
  const problems: string[] = [];
  const kinds: Record<string, number> = {};
  doc.nodes.forEach((old, index) => {
    const node = nodes.get(old.id);
    if (!node) return void problems.push(`node ${old.id} missing`);
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    for (const field of ["x", "y", "width", "height"]) if (old[field] !== node[field]) problems.push(`${old.id}: ${field} ${String(old[field])} became ${String(node[field])}`);
    const expectedKind = old.type === "group" ? "region" : (old.ether?.entity?.kind ?? "note");
    if (node.kind !== expectedKind) problems.push(`${old.id}: kind ${expectedKind} became ${node.kind}`);
    if (node.kind === "agent") {
      if (node.bindingId !== old.ether.terminal.bindingId) problems.push(`${old.id}: bindingId changed`);
      if (node.harness !== old.ether.terminal.harness) problems.push(`${old.id}: harness changed`);
      if (node.label !== old.text) problems.push(`${old.id}: label ${JSON.stringify(old.text)} became ${JSON.stringify(node.label)}`);
    }
    if (node.kind === "region" && (node.label ?? "") !== (old.label ?? "")) problems.push(`${old.id}: region label changed`);
    if (node.kind === "note" && node.text !== old.text) problems.push(`${old.id}: note text changed`);
    // Paint order: the document's array order is the old z.
    const later = doc.nodes[index + 1];
    const laterNode = later ? nodes.get(later.id) : undefined;
    if (laterNode && !(node.z < laterNode.z)) problems.push(`${old.id}: no longer paints under ${later!.id}`);
  });
  for (const old of doc.edges) {
    const wire = wires.get(old.id);
    if (!wire) { problems.push(`wire ${old.id} missing`); continue; }
    if (wire.from !== old.fromNode || wire.to !== old.toNode || wire.verb !== old.ether?.verb) problems.push(`wire ${old.id}: ends or verb changed`);
  }
  const cards = await evaluate<number>(`document.querySelectorAll(".react-flow__node").length`);
  console.log(JSON.stringify({ phase, seq: now.seq, before: { nodes: doc.nodes.length, wires: doc.edges.length }, after: { nodes: now.nodes.length, wires: now.wires.length }, kinds, cardsOnScreen: cards, problems: problems.length, first: problems.slice(0, 8) }));
}

if (phase === "change") {
  const before = await opened();
  const seats = before.nodes.filter((node) => node.kind === "agent");
  const note = before.nodes.find((node) => node.kind === "note");
  const [mover, renamed, from, to] = [seats[0]!, seats[1]!, seats[2]!, seats[40]!];
  // Count what the window is told and what it re-reads while each command runs.
  await evaluate(`(() => {
    window.__verifyCut?.stop();
    const tally = { changed: [], canvases: 0, marks: [], spans: [] };
    const offChanged = window.junto.onModelChanged((event) => tally.changed.push({ seq: event.seq, nodes: event.nodes.length, wires: event.wires.length, removedNodes: event.removedNodes.length, removedWires: event.removedWires.length }));
    const offCanvases = window.junto.onModelCanvasesChanged(() => { tally.canvases += 1; });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith("junto:")) continue;
        if (entry.entryType === "measure") tally.spans.push(entry.name.slice(6)); else tally.marks.push(entry.name.slice(6));
      }
    });
    observer.observe({ entryTypes: ["measure", "mark"] });
    tally.stop = () => { offChanged(); offCanvases(); observer.disconnect(); };
    tally.take = () => { const out = { changed: tally.changed, canvases: tally.canvases, marks: tally.marks, spans: tally.spans }; tally.changed = []; tally.canvases = 0; tally.marks = []; tally.spans = []; return out; };
    window.__verifyCut = tally;
  })()`);
  // Count the window's reads where they arrive, in main, so the number does
  // not depend on instrumentation inside the window that a change may remove.
  const mainPort = process.env.JUNTO_PERF_LAB_MAIN_PORT ?? "9230";
  const mainTargets = (await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json()) as Array<{ webSocketDebuggerUrl: string }>;
  const mainWs = new WebSocket(mainTargets[0]!.webSocketDebuggerUrl);
  await new Promise<void>((ok) => (mainWs.onopen = () => ok()));
  let mainNext = 1;
  const mainWaiting = new Map<number, (value: any) => void>();
  mainWs.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const done = message.id === undefined ? undefined : mainWaiting.get(message.id);
    if (done) {
      mainWaiting.delete(message.id);
      done(message);
    }
  };
  const mainEvaluate = async <T>(expression: string): Promise<T> => {
    const id = mainNext++;
    const reply = await new Promise<any>((done) => {
      mainWaiting.set(id, done);
      mainWs.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 400));
    return reply.result.result.value as T;
  };
  const counted = await mainEvaluate<string[]>(`(() => {
    const load = typeof require === "function" ? require : process.mainModule.require;
    const handlers = load("electron").ipcMain._invokeHandlers;
    globalThis.__verifyInvokes = globalThis.__verifyInvokes ?? {};
    const wrapped = [];
    for (const [channel, handler] of handlers) {
      if (!String(channel).startsWith("junto:") || handler.__verifyCounted) continue;
      // Per channel: how many calls, how long main took to answer them, and how much it sent back.
      const counting = async (...args) => {
        const started = performance.now();
        try {
          const value = await handler(...args);
          const slot = (globalThis.__verifyInvokes[channel] ??= { calls: 0, ms: 0, bytes: 0 });
          slot.calls += 1;
          slot.ms += performance.now() - started;
          try { slot.bytes += JSON.stringify(value ?? null).length; } catch { slot.bytes += -1; }
          return value;
        } catch (error) {
          const slot = (globalThis.__verifyInvokes[channel] ??= { calls: 0, ms: 0, bytes: 0 });
          slot.calls += 1;
          slot.ms += performance.now() - started;
          throw error;
        }
      };
      counting.__verifyCounted = true;
      handlers.set(channel, counting);
      wrapped.push(channel);
    }
    return wrapped;
  })()`);
  const takeInvokes = () => mainEvaluate<Record<string, { calls: number; ms: number; bytes: number }>>(`(() => { const out = globalThis.__verifyInvokes; globalThis.__verifyInvokes = {}; for (const slot of Object.values(out)) slot.ms = Math.round(slot.ms * 100) / 100; return out; })()`);
  console.log(JSON.stringify({ mainChannelsCounted: counted.length }));
  const wireId = `verify-new-wire-${String(Date.now())}`;
  const commands: Array<[string, object]> = [
    ["move one seat", { _tag: "Move", canvas, moves: [{ id: mover.id, x: mover.x + 137, y: mover.y + 59 }] }],
    ["rename one seat", { _tag: "Edit", canvas, id: renamed.id, change: { kind: "agent", label: "renamed by the verifier" } }],
    ["add one wire", { _tag: "Add", canvas, nodes: [], wires: [{ id: wireId, from: from.id, to: to.id, verb: "messages" }] }],
    ["delete one note", { _tag: "Remove", canvas, nodes: [note!.id], wires: [] }],
  ];
  const results: object[] = [];
  await sleep(1_500);
  await evaluate(`window.__verifyCut.take()`);
  await takeInvokes();
  await sleep(2_000);
  console.log(JSON.stringify({ what: "quiet 2 s, nothing sent", invokesInMain: await takeInvokes() }));
  for (const [what, command] of commands) {
    const reply = await evaluate<{ ok: boolean; seq?: number; error?: string }>(`window.junto.modelCommand(${JSON.stringify(command)}).then((value) => ({ ok: true, seq: value.seq }), (error) => ({ ok: false, error: String(error).slice(0, 300) }))`);
    await sleep(1_200);
    const seen = await evaluate<{ changed: object[]; canvases: number; marks: string[]; spans: string[] }>(`window.__verifyCut.take()`);
    const count = (list: string[], key: string) => list.filter((item) => item === key).length;
    // The command itself is one modelCommand invoke; anything else is the window asking main for more.
    const invokes = await takeInvokes();
    results.push({ what, reply, events: seen.changed, canvasChangedMarks: count(seen.marks, "canvasChanged"), readCanvasSpans: count(seen.spans, "reload.readCanvas"), invokesInMain: invokes });
    console.log(JSON.stringify(results.at(-1)));
  }
  await evaluate(`window.__verifyCut.stop()`);
  mainWs.close();
  const after = await opened();
  writeFileSync(file, JSON.stringify({ expect: { mover: { id: mover.id, x: mover.x + 137, y: mover.y + 59 }, renamed: renamed.id, wire: { id: wireId, from: from.id, to: to.id }, removed: note!.id, seq: after.seq, nodes: after.nodes.length, wires: after.wires.length } }));
  console.log(JSON.stringify({ phase, seqBefore: before.seq, seqAfter: after.seq, nodes: [before.nodes.length, after.nodes.length], wires: [before.wires.length, after.wires.length] }));
}

if (phase === "confirm") {
  const { expect } = JSON.parse(readFileSync(file, "utf8")) as { expect: Row };
  const now = await opened();
  const nodes = byId(now.nodes);
  const wires = byId(now.wires);
  const mover = nodes.get(expect.mover.id);
  const wire = wires.get(expect.wire.id);
  console.log(JSON.stringify({
    phase,
    seq: [expect.seq, now.seq],
    counts: { nodes: [expect.nodes, now.nodes.length], wires: [expect.wires, now.wires.length] },
    moveHeld: mover?.x === expect.mover.x && mover?.y === expect.mover.y,
    renameHeld: nodes.get(expect.renamed)?.label === "renamed by the verifier",
    wireHeld: wire?.from === expect.wire.from && wire?.to === expect.wire.to && wire?.verb === "messages",
    deleteHeld: !nodes.has(expect.removed),
    cardsOnScreen: await evaluate<number>(`document.querySelectorAll(".react-flow__node").length`),
    renamedOnScreen: await evaluate<boolean>(`document.body.innerText.toLowerCase().includes("renamed by the verifier")`),
  }));
}
ws.close();
