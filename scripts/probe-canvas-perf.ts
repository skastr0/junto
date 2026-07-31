/**
 * Attach to packaged Vellum Command (`--remote-debugging-port=9229`) and measure
 * selection / pan / idle long-task budgets on the live board.
 */
const ENDPOINT = process.env.VELLUM_CDP_URL ?? "http://127.0.0.1:9229";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const median = (samples: number[]): number => {
  if (samples.length === 0) return Infinity;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpSession {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  private readonly ready: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 5_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP websocket error"));
        },
        { once: true },
      );
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const msg = JSON.parse(raw) as { id?: number; result?: Json; error?: { message?: string } };
      if (typeof msg.id !== "number") return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
      else waiter.resolve((msg.result as Json) ?? null);
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const session = new CdpSession(new WebSocket(wsUrl));
    await session.ready;
    return session;
  }

  async send(method: string, params?: Record<string, Json>): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 8_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T; subtype?: string; description?: string } };
    if (result.result?.subtype === "error") {
      throw new Error(result.result.description ?? "evaluate error");
    }
    return result.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

const waitForNodes = async (cdp: CdpSession, min: number): Promise<number> => {
  for (let i = 0; i < 40; i += 1) {
    const n = await cdp.evaluate<number>(
      `document.querySelectorAll(".react-flow__node").length`,
    );
    if (n >= min) return n;
    await sleep(250);
  }
  return cdp.evaluate<number>(`document.querySelectorAll(".react-flow__node").length`);
};

const main = async (): Promise<void> => {
  const list = (await (await fetch(`${ENDPOINT}/json/list`)).json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  const pageTarget = list.find((t) => t.type === "page" && t.url.includes("vellum-app"));
  if (!pageTarget) throw new Error(`no vellum page target at ${ENDPOINT}`);

  const cdp = await CdpSession.connect(pageTarget.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  const nodeCount = await waitForNodes(cdp, 20);
  if (nodeCount < 2) throw new Error(`need ≥2 nodes, found ${nodeCount}`);

  const meta = await cdp.evaluate<{
    nodes: number;
    selected: number;
    impact: boolean;
    minimap: boolean;
  }>(`({
    nodes: document.querySelectorAll(".react-flow__node").length,
    selected: document.querySelectorAll(".react-flow__node.selected").length,
    impact: Boolean(document.querySelector(".react-flow.impact-mode")),
    minimap: Boolean(document.querySelector(".react-flow__minimap")),
  })`);

  await cdp.evaluate(`(() => {
    const w = window;
    w.__p = { frames: [], longs: 0 };
    let last = performance.now();
    const tick = (now) => {
      w.__p.frames.push(now - last);
      last = now;
      if (w.__p.frames.length < 120) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      const ro = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.duration >= 50) w.__p.longs += 1;
      });
      ro.observe({ type: "longtask", buffered: true });
      w.__p.ro = ro;
    } catch {}
    return true;
  })()`);

  // Wheel via DOM events — Electron's CDP Input.mouseWheel often hangs.
  for (let i = 0; i < 30; i += 1) {
    await cdp.evaluate(
      `(() => {
        const el = document.querySelector(".react-flow__pane") || document.body;
        el.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: ${i % 2 ? -220 : 220},
        }));
        return true;
      })()`,
    );
    await sleep(16);
  }
  await sleep(300);
  const pan = await cdp.evaluate<{
    n: number;
    median: number;
    p95: number;
    max: number;
    longs: number;
  }>(`(() => {
    const p = window.__p;
    p.ro?.disconnect();
    const f = p.frames || [];
    const s = [...f].sort((a, b) => a - b);
    return {
      n: f.length,
      median: s[Math.floor(s.length / 2)] ?? null,
      p95: s[Math.floor(s.length * 0.95)] ?? null,
      max: s[s.length - 1] ?? null,
      longs: p.longs,
    };
  })()`);

  const selection: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const t0 = Date.now();
    await cdp.evaluate(
      `(() => {
        const nodes = [...document.querySelectorAll(".react-flow__node")];
        const idx = ${i % 2 === 0 ? "Math.min(nodes.length - 1, Math.floor(nodes.length / 2))" : "0"};
        const el = nodes[idx];
        if (!el) return null;
        for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }));
        }
        return el.getAttribute("data-id");
      })()`,
    );
    for (let w = 0; w < 40; w += 1) {
      const ok = await cdp.evaluate<number>(
        `document.querySelectorAll(".react-flow__node.selected").length`,
      );
      if (ok >= 1) break;
      await sleep(16);
    }
    selection.push(Date.now() - t0);
  }

  await cdp.evaluate(`(() => {
    window.__idle = { longs: 0 };
    try {
      const ro = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.duration >= 50) window.__idle.longs += 1;
      });
      ro.observe({ type: "longtask", buffered: false });
      window.__idle.ro = ro;
    } catch {}
    return true;
  })()`);
  await sleep(4_000);
  const idleLongTasks = await cdp.evaluate<number>(
    `(() => { window.__idle.ro?.disconnect(); return window.__idle.longs; })()`,
  );

  const report = {
    endpoint: ENDPOINT,
    meta,
    nodeCount,
    pan,
    selection: {
      samplesMs: selection,
      medianMs: median(selection),
      maxMs: Math.max(...selection),
    },
    idleLongTasks4s: idleLongTasks,
  };
  console.log(JSON.stringify(report, null, 2));
  cdp.close();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
