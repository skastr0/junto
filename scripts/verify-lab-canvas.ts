/**
 * Verifier lab setup: arm the lab window, then give it a fresh canvas of N
 * agent seats that never start and open it, so perf-lab-work-changes.ts has
 * one known canvas to measure on.
 *
 *   bun scripts/verify-lab-canvas.ts --canvas NAME [--cards 46]
 *   bun scripts/verify-lab-canvas.ts --canvas NAME --remove
 */
import { resolve } from "node:path";
import { agentTextNode, canvasDoc } from "../e2e/harness/sandbox";
import { formatNodeRef } from "../src/shared/node-ref";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
};
const canvasName = arg("canvas", "");
const cards = Number(arg("cards", "46"));
const remove = process.argv.includes("--remove");
const root = resolve(import.meta.dirname, "..");
const rendererPort = process.env.JUNTO_PERF_LAB_RENDERER_PORT ?? "9229";
const mainPort = process.env.JUNTO_PERF_LAB_MAIN_PORT ?? "9230";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
if (canvasName === "") {
  console.error("usage: verify-lab-canvas.ts --canvas NAME [--cards N] | --remove");
  process.exit(64);
}

type Target = { type: string; title?: string; webSocketDebuggerUrl: string };
const targets = async (port: string): Promise<Target[]> =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
const connect = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error(`cannot connect to ${url}`));
  });
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
  const send = async (method: string, params: object = {}): Promise<any> => {
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
  return { send, evaluate, close: () => ws.close() };
};

const pageTarget = (await targets(rendererPort)).find((t) => t.type === "page" && (t.title ?? "").startsWith("Junto"));
const mainTarget = (await targets(mainPort))[0];
if (!pageTarget || !mainTarget) {
  console.error("verify lab: lab app not reachable on its debug ports");
  process.exit(1);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
const main = await connect(mainTarget.webSocketDebuggerUrl);
const name = JSON.stringify(canvasName);

if (remove) {
  const result = await page.evaluate(`(async () => {
    const api = window.junto;
    await api.factoryPauseSet(${name}, true).catch(() => undefined);
    const deleted = await api.deleteCanvas(${name}).then(() => true, (error) => String(error));
    return { deleted, stillListed: (await api.listCanvases()).some((row) => row.name === ${name}) };
  })()`);
  console.log(JSON.stringify({ canvasName, ...(result as object) }));
  page.close();
  main.close();
  process.exit(0);
}

// Arm the span and React-commit recorders; both are frozen at module load.
const armed = () =>
  page.evaluate<boolean>(`typeof juntoPerfFrames === "object" && typeof juntoPerf === "object"`).catch(() => false);
if (!(await armed())) {
  await page.evaluate(`(() => { localStorage.setItem("JUNTO_PERF_FRAMES", "1"); localStorage.setItem("JUNTO_PERF", "1"); })()`);
  await page.send("Page.reload");
  for (let tries = 0; tries < 40 && !(await armed()); tries += 1) await sleep(500);
  if (!(await armed())) {
    console.error("verify lab: the window did not arm after a reload");
    process.exit(1);
  }
}
await sleep(1_500);

// The first-run overlay covers the canvas on a fresh lab home.
await page.evaluate(`(() => {
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "skip the tour")?.click();
})()`);

const tag = canvasName.replace(/[^a-z0-9]/gu, "").slice(-8);
const nodes = Array.from({ length: cards }, (_, i) => {
  const id = `verify-seat-${String(i + 1).padStart(2, "0")}-${tag}`;
  return agentTextNode({
    id,
    key: `local:${id}`,
    label: id,
    harness: "claude",
    cwd: root,
    x: (i % 5) * 260,
    y: Math.floor(i / 5) * 130,
  });
});
// --regions, --notes and --wires fill the canvas out to the shape of a real
// one: regions drawn around pairs of seats, loose notes, and message wires
// between neighbouring seats. Regions go first so they paint underneath.
const regions = Number(arg("regions", "0"));
const notes = Number(arg("notes", "0"));
const wires = Number(arg("wires", "0"));
const seatsOnly = nodes.slice();
for (let i = 0; i < regions; i += 1) {
  const anchor = seatsOnly[(i * 2) % seatsOnly.length]!;
  nodes.unshift({
    id: `verify-region-${String(i + 1).padStart(2, "0")}-${tag}`,
    type: "group",
    label: `region ${String(i + 1)}`,
    x: anchor.x - 20,
    y: anchor.y - 30,
    width: 520,
    height: 170,
    ether: { region: { hold: false } },
  } as never);
}
for (let i = 0; i < notes; i += 1) {
  nodes.push({ id: `verify-note-${String(i + 1).padStart(2, "0")}-${tag}`, type: "text", text: `note ${String(i + 1)}`, x: -320, y: i * 140, width: 240, height: 120 } as never);
}
const edges = Array.from({ length: wires }, (_, i) => {
  const from = seatsOnly[i % seatsOnly.length]!;
  const to = seatsOnly[(i + 1 + Math.floor(i / seatsOnly.length) * 3) % seatsOnly.length]!;
  return { id: `verify-wire-${String(i + 1).padStart(3, "0")}-${tag}`, fromNode: from.id, toNode: to.id, ether: { verb: "messages" } };
}).filter((edge) => edge.fromNode !== edge.toNode);

// --sinks adds one task board, one bulletin board and one pad beside the seats,
// for measuring work changes other than mail.
if (process.argv.includes("--sinks")) {
  for (const [index, kind] of ["task", "board", "pad"].entries()) {
    nodes.push({
      id: `verify-${kind}-${tag}`,
      type: "text",
      text: kind,
      x: 1400,
      y: index * 260,
      width: 320,
      height: 220,
      ether: { entity: { kind }, ...(kind === "task" ? { tasks: { name: "verify", items: [] } } : {}) },
    } as never);
  }
}
await page.evaluate(`(async () => {
  const api = window.junto;
  await api.createCanvas(${name}).catch(() => undefined);
  const read = await api.readCanvas(${name});
  await api.writeCanvas(${name}, ${JSON.stringify(canvasDoc(nodes, edges as never))}, read.revision);
})()`);

// Open the canvas the way a junto:// link does.
const first = nodes[0]!;
await main.evaluate(`(() => {
  const load = typeof require === "function" ? require : process.mainModule.require;
  const window = load("electron").BrowserWindow.getAllWindows()[0];
  window.webContents.send("junto:node-ref-opened", ${JSON.stringify({
    ref: formatNodeRef({ canvasName, nodeId: first.id } as never),
    canvasName,
    nodeId: first.id,
    deliveryId: crypto.randomUUID(),
  })});
  return true;
})()`);
await sleep(2_500);
await page.evaluate(`(() => { document.querySelector(".react-flow__controls-fitview")?.click(); })()`);
await sleep(1_500);

const state = await page.evaluate<Record<string, unknown>>(`(async () => ({
  cards: document.querySelectorAll(".react-flow__node").length,
  firstCard: document.querySelector(".react-flow__node")?.getAttribute("data-id") ?? null,
  running: (await window.junto.terminalList()).filter((row) => row.status === "running" || row.status === "starting").length,
  paused: await window.junto.factoryPauseState(${name}).catch((error) => String(error)),
  size: [innerWidth, innerHeight],
}))()`);
console.log(JSON.stringify({ canvasName, cardsWritten: cards, nodesWritten: nodes.length, wiresWritten: edges.length, ...state }));
page.close();
main.close();
