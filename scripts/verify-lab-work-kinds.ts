/**
 * Verifier lab measurement: what one work change that is not mail costs the
 * window. On the canvas made by `verify-lab-canvas.ts --sinks` it makes, one
 * at a time, a task, a task update, a board post and a pad patch, and records
 * for each the canvas reads, rebuilds, React commits and longest frame gap.
 *
 *   bun scripts/verify-lab-work-kinds.ts [--each 5] [--out DIR]
 *
 * Run under the app-run lock, with the window armed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const each = Number(arg("each", "5"));
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
const evaluate = async <T>(expression: string): Promise<T> => {
  const id = next++;
  const reply = await new Promise<any>((done) => {
    waiting.set(id, done);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (reply.error || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
  return reply.result.result.value as T;
};

const found = await evaluate<{ canvas: string; task: string; board: string; pad: string; cards: number } | null>(`(() => {
  const ids = [...document.querySelectorAll(".react-flow__node")].map((card) => card.getAttribute("data-id") ?? "");
  const pick = (kind) => ids.find((id) => id.startsWith("verify-" + kind + "-")) ?? "";
  const canvas = (document.title.match(/verify-[a-z0-9-]+/) ?? [""])[0];
  return { canvas, task: pick("task"), board: pick("board"), pad: pick("pad"), cards: ids.length };
})()`);
const canvasName = arg("canvas", found?.canvas ?? "");
if (!found || found.task === "" || found.board === "" || found.pad === "" || canvasName === "") {
  console.error(`verify lab: need --canvas NAME and a canvas made with --sinks; found ${JSON.stringify(found)}`);
  process.exit(1);
}

await evaluate(`(() => {
  window.__verifyWork?.stop();
  const tally = { spans: [], marks: [], maxGap: 0, stopped: false };
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
    tally.maxGap = Math.max(tally.maxGap, now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  tally.stop = () => { tally.stopped = true; observer.disconnect(); };
  tally.take = () => {
    const out = { spans: tally.spans, marks: tally.marks, maxGap: tally.maxGap };
    tally.spans = []; tally.marks = []; tally.maxGap = 0;
    return out;
  };
  window.__verifyWork = tally;
})()`);
type Tally = { spans: Array<[string, number]>; marks: string[]; maxGap: number };
const take = () => evaluate<Tally>(`window.__verifyWork.take()`);
const rows: unknown[] = [];
const record = (label: string, result: unknown, tally: Tally) => {
  const sum = (name: string) => {
    const hits = tally.spans.filter(([span]) => span === name);
    return { count: hits.length, ms: Math.round(hits.reduce((total, [, ms]) => total + ms, 0) * 10) / 10 };
  };
  const row = {
    label,
    result,
    canvasChanged: tally.marks.filter((mark) => mark === "canvasChanged").length,
    readCanvas: sum("reload.readCanvas"),
    stringifyCompare: sum("reload.stringifyCompare"),
    applyDoc: sum("reload.applyDoc"),
    structuralRebuild: sum("canvas.structuralRebuild"),
    reactRoot: sum("react.root"),
    reactCanvas: sum("react.canvas"),
    maxFrameGapMs: Math.round(tally.maxGap),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
};
// One call through the window bridge; keeps only whether it worked and an id.
const call = (expression: string) =>
  evaluate<{ ok: boolean; id?: string; error?: string }>(`(async () => {
    try {
      const value = await (${expression});
      if (value?.ok === false) return { ok: false, error: String(value.error ?? "").slice(0, 200) };
      const body = value?.value ?? value?.data ?? value;
      return { ok: true, id: body?.taskId ?? body?.id ?? body?.topic?.topicId ?? body?.post?.postId ?? String(body?.revision ?? "") };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 200) };
    }
  })()`);
const c = JSON.stringify(canvasName);
const measure = async (label: string, expression: string) => {
  const result = await call(expression);
  await sleep(700);
  record(label, result, await take());
  return result;
};

console.log(JSON.stringify({ ...found, canvas: canvasName, loadAverage: loadavg() }));
await sleep(1_000);
await take();
await sleep(3_000);
record("quiet 3 s, no work change", null, await take());

const taskIds: string[] = [];
for (let index = 0; index < each; index += 1) {
  const made = await measure("task created", `window.junto.workTaskCreate(${c}, ${JSON.stringify(found.task)}, "verify task ${String(index)}")`);
  if (made.ok && made.id) taskIds.push(made.id);
}
for (const [index, taskId] of taskIds.entries()) {
  await measure("task brief updated", `window.junto.workTaskDescribe(${c}, ${JSON.stringify(found.task)}, ${JSON.stringify(taskId)}, "verify task ${String(index)} updated")`);
}
const topic = await measure("board topic created", `window.junto.workBoardCreateTopic(${c}, ${JSON.stringify(found.board)}, "verify topic", "body", false)`);
if (topic.ok && topic.id) {
  for (let index = 0; index < each; index += 1) {
    await measure("board post", `window.junto.workBoardPost(${c}, ${JSON.stringify(found.board)}, ${JSON.stringify(topic.id)}, "verify post ${String(index)}")`);
  }
}
for (let index = 0; index < each; index += 1) {
  const shape = { id: `s${String(index)}`, type: "box", x: index * 40, y: 0, w: 30, h: 30, z: index };
  await measure("pad patch (one shape)", `window.junto.workPadPatch(${c}, ${JSON.stringify(found.pad)}, [${JSON.stringify({ op: "upsert", layer: "shape", shape })}])`);
}

await evaluate(`window.__verifyWork.stop()`);
writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ canvas: canvasName, found, rows, loadAverage: loadavg() }, null, 2)}\n`);
ws.close();
