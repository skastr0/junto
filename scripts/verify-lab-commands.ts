/**
 * Verifier lab count: what one small command costs. Sends a move, a rename,
 * a new wire and a delete through the model, one at a time, and records for
 * each the change events the window is told and every call that reaches main,
 * with how long main took and how much it sent back. The renamed seat and the
 * deleted note are picked inside a region when one holds them, and that
 * region's card is read off the screen before and after.
 *
 *   bun scripts/verify-lab-commands.ts change  --canvas NAME --file F   send the four commands
 *   bun scripts/verify-lab-commands.ts confirm --canvas NAME --file F   after a restart: the changes held
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
if (!["change", "confirm"].includes(phase) || canvas === "" || file === "") {
  console.error("usage: verify-lab-commands.ts change|confirm --canvas NAME --file F");
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
const send = (method: string, params: object) => {
  const id = next++;
  return new Promise<any>((done) => {
    waiting.set(id, done);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const name = JSON.stringify(canvas);
type Row = Record<string, any>;
const byId = (rows: ReadonlyArray<Row>) => new Map(rows.map((row) => [row.id as string, row]));
const opened = () => evaluate<{ seq: number; nodes: Row[]; wires: Row[] }>(`window.junto.modelOpen({ canvas: ${name} })`);

if (phase === "change") {
  const before = await opened();
  const seats = before.nodes.filter((node) => node.kind === "agent");
  const regions = before.nodes.filter((node) => node.kind === "region");
  // The smallest region whose box holds the node's centre, if any.
  const regionOf = (node: Row): Row | undefined => {
    const cx = node.x + (node.width ?? 0) / 2;
    const cy = node.y + (node.height ?? 0) / 2;
    return regions
      .filter((region) => cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height)
      .sort((left, right) => left.width * left.height - right.width * right.height)[0];
  };
  const notes = before.nodes.filter((node) => node.kind === "note");
  const note = notes.find((candidate) => regionOf(candidate) !== undefined) ?? notes[0];
  const mover = seats[0]!;
  const renamed = seats.slice(1).find((seat) => regionOf(seat) !== undefined) ?? seats[1]!;
  const [from, to] = [seats.find((seat) => seat.id !== mover.id && seat.id !== renamed.id)!, seats.at(-1)!];
  const watched = [...new Set([regionOf(renamed)?.id, note ? regionOf(note)?.id : undefined].filter((id): id is string => id !== undefined))];
  // What each watched region's card says on screen, and whether the new name is anywhere on screen.
  const onScreen = () =>
    evaluate<{ regions: Record<string, string | null>; newNameShown: boolean; cards: number }>(`(() => ({
      regions: Object.fromEntries(${JSON.stringify(watched)}.map((id) => [id, document.querySelector('.react-flow__node[data-id="' + id + '"]')?.innerText?.replace(/\\s+/g, " ").slice(0, 240) ?? null])),
      newNameShown: document.body.innerText.toLowerCase().includes("renamed by the verifier"),
      cards: document.querySelectorAll(".react-flow__node").length,
    }))()`);
  // The command bar draws a region's count of nodes from the window's own
  // store. Open it on the region that holds the note to be deleted and keep
  // that row mounted, so the count can be read before and after each command.
  const countedRegion = note ? regionOf(note) : undefined;
  const regionRow = () =>
    countedRegion === undefined
      ? Promise.resolve(null)
      : evaluate<{ title: string; detail: string | null } | null>(`(() => {
          const rows = [...document.querySelectorAll('[role="option"]')];
          const row = rows.find((candidate) => candidate.querySelector(".command-bar__row-title")?.textContent?.trim() === ${JSON.stringify(String(countedRegion.label ?? ""))});
          return row ? { title: row.querySelector(".command-bar__row-title").textContent.trim(), detail: row.querySelector(".command-bar__row-detail")?.textContent?.trim() ?? null } : null;
        })()`);
  if (countedRegion !== undefined) {
    const key = { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: process.platform === "darwin" ? 4 : 2 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await sleep(500);
    await send("Input.insertText", { text: String(countedRegion.label ?? "") });
    await sleep(800);
    console.log(JSON.stringify({ commandBar: { open: await evaluate<boolean>(`document.querySelector('[data-testid="command-bar-input"]') !== null`), region: countedRegion.id, label: countedRegion.label ?? null, rowBefore: await regionRow() } }));
  }
  console.log(JSON.stringify({ picked: { renamedSeat: renamed.id, itsRegion: regionOf(renamed)?.id ?? null, deletedNote: note?.id ?? null, itsRegion2: note ? (regionOf(note)?.id ?? null) : null, regions: regions.length, notes: notes.length }, screenBefore: await onScreen() }));
  // Count what the window is told while each command runs.
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
    // The command itself is one modelCommand invoke; anything else is the window asking main for more.
    const invokes = await takeInvokes();
    results.push({ what, reply, events: seen.changed, invokesInMain: invokes, screen: await onScreen(), regionRowInCommandBar: await regionRow() });
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
