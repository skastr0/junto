/**
 * [fake-tui] Operator action paint cost on the factory shape: answer a signal,
 * create a thread, and reply in the real window while the seat is busy. The
 * measurement is click/key press to the paint-complete rAF pair stamped when
 * the result mutation enters the DOM, with renderer long tasks/frames and
 * every ipcMain.handle call metered.
 *   scripts/run-e2e.sh e2e/scenarios/zz-operator-action-paint.spec.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { mod } from "../harness/keys";
import { canvasReady } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "factory";
const TARGET = "seat-4";
const TARGET_LABEL = "seat 4";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "operator-action-paint");
const MAIN_LOGS = join(FRAMES, "main-logs");
process.env.JUNTO_E2E_MAIN_LOG = MAIN_LOGS;

const shaped = JSON.parse(readFileSync("e2e/scenarios/zz-proof-factory-shape.json", "utf8")) as {
  model: { nodes: Array<any>; wires: Array<any> };
  signalRows: Array<any>;
};
const seenWires = new Set<string>();
const wires = shaped.model.wires.filter((wire) => {
  const key = `${wire.from}\0${wire.to}\0${wire.verb}`;
  if (seenWires.has(key)) return false;
  seenWires.add(key);
  return true;
});
const nodes = shaped.model.nodes.map((node) =>
  node.kind === "agent" ? { ...node, launch: { ...node.launch, cwd: "/tmp" } } : node,
);
const factory = { nodes, wires };
const perfSignal = {
  signalId: "perf-operator-action-signal",
  canvasName: CANVAS,
  nodeId: TARGET,
  kind: "escalate",
  text: "PERF signal answer target",
  createdAt: Date.now(),
  state: "open",
};

const installMeter = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __ipcPaintMeter: Record<string, { calls: number; bytes: number; ms: number }> };
    g.__ipcPaintMeter = {};
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    if (handlers === undefined) throw new Error("ipcMain._invokeHandlers is gone");
    for (const [channel, handler] of handlers) {
      handlers.set(channel, async (...args: unknown[]) => {
        const at = performance.now();
        const out = await handler(...args);
        const entry = (g.__ipcPaintMeter[channel] ??= { calls: 0, bytes: 0, ms: 0 });
        entry.calls += 1;
        entry.ms += performance.now() - at;
        try { entry.bytes += JSON.stringify(out)?.length ?? 0; } catch { /* unmeasured */ }
        return out;
      });
    }
    return handlers.size;
  });

const resetMeter = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => void ((globalThis as unknown as { __ipcPaintMeter: object }).__ipcPaintMeter = {}));
const readMeter = (app: ElectronApplication): Promise<Record<string, { calls: number; bytes: number; ms: number }>> =>
  app.evaluate(() => (globalThis as unknown as { __ipcPaintMeter: Record<string, { calls: number; bytes: number; ms: number }> }).__ipcPaintMeter);

const installPaintProbe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __paintProbe?: { frames: number[]; longtasks: Array<{ start: number; duration: number }>; raf?: number };
      __paintReset?: () => void;
      __paintRead?: () => unknown;
      __mutationLog?: Array<{
        t: number;
        testid?: string;
        attr?: string;
        value?: string;
        className?: string;
        text?: string;
        raf1?: number;
        raf2?: number;
      }>;
      __mutationReset?: () => void;
    };
    if (w.__paintProbe !== undefined) return;
    const probe: { frames: number[]; longtasks: Array<{ start: number; duration: number }>; raf?: number } = { frames: [], longtasks: [] };
    w.__paintProbe = probe;
    document.addEventListener("click", () => {
      (window as unknown as { __lastClickAt: number }).__lastClickAt = Date.now();
    }, true);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longtasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ entryTypes: ["longtask"] });
    } catch { /* longtask unsupported */ }
    let last = performance.now();
    const tick = (): void => {
      const at = performance.now();
      probe.frames.push(at - last);
      last = at;
      probe.raf = requestAnimationFrame(tick);
    };
    probe.raf = requestAnimationFrame(tick);
    w.__paintReset = () => {
      probe.frames.length = 0;
      probe.longtasks.length = 0;
    };
    w.__paintRead = () => ({
      frames: [...probe.frames],
      worstFrame: Math.max(0, ...probe.frames),
      frameMs: probe.frames.reduce((sum, ms) => sum + ms, 0),
      longtasks: [...probe.longtasks].sort((a, b) => b.duration - a.duration),
      longtaskMs: probe.longtasks.reduce((sum, entry) => sum + entry.duration, 0),
    });
    const mutationLog: NonNullable<typeof w.__mutationLog> = [];
    w.__mutationLog = mutationLog;
    const markMutation = (target: Element, attr?: string): void => {
      const item: (typeof mutationLog)[number] = {
        t: Date.now(),
        ...(target.getAttribute("data-testid") === null ? {} : { testid: target.getAttribute("data-testid")! }),
        ...(attr === undefined ? {} : { attr, value: target.getAttribute(attr) ?? "" }),
        ...(typeof target.className === "string" ? { className: target.className } : {}),
        text: (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
      };
      mutationLog.push(item);
      requestAnimationFrame(() => {
        item.raf1 = Date.now();
        requestAnimationFrame(() => {
          item.raf2 = Date.now();
        });
      });
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) {
          markMutation(record.target, record.attributeName ?? undefined);
          continue;
        }
        if (record.type !== "childList") continue;
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.hasAttribute("data-testid")) markMutation(node);
          for (const child of node.querySelectorAll('[data-testid="seat-threads-message"], [data-testid="operator-feed-card"]')) {
            markMutation(child);
          }
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "aria-current"],
    });
    w.__mutationReset = () => {
      mutationLog.length = 0;
    };
  });

const installEars = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __waitingEars: { marks: Array<{ t: number }>; gone: Array<{ t: number }> } };
    w.__waitingEars = { marks: [], gone: [] };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const marks = node.matches('[data-testid="seat-threads-waiting"]') ? [node] : [...node.querySelectorAll('[data-testid="seat-threads-waiting"]')];
          for (const _mark of marks) w.__waitingEars.marks.push({ t: performance.now() });
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          const marks = node.matches('[data-testid="seat-threads-waiting"]') ? [node] : [...node.querySelectorAll('[data-testid="seat-threads-waiting"]')];
          for (const _mark of marks) w.__waitingEars.gone.push({ t: performance.now() });
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  });

const twoFramesAfterVisible = async (page: Page): Promise<number> =>
  page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(Date.now())))));

type MutationMark = {
  readonly t: number;
  readonly testid?: string;
  readonly attr?: string;
  readonly value?: string;
  readonly className?: string;
  readonly text?: string;
  readonly raf1?: number;
  readonly raf2?: number;
};

type ResultEndpoint =
  | { readonly kind: "class"; readonly text: string; readonly className: string }
  | { readonly kind: "attr"; readonly text: string; readonly attr: string; readonly value: string }
  | { readonly kind: "message"; readonly text: string };

const endpointMatches = (mark: MutationMark, endpoint: ResultEndpoint): boolean => {
  if (endpoint.kind === "class") {
    return mark.attr === "class" && (mark.className ?? "").includes(endpoint.className) && (mark.text ?? "").includes(endpoint.text);
  }
  if (endpoint.kind === "attr") {
    return mark.attr === endpoint.attr && mark.value === endpoint.value && (mark.text ?? "").includes(endpoint.text);
  }
  return mark.testid === "seat-threads-message" && (mark.text ?? "").includes(endpoint.text);
};

const mutationEndpoint = async (page: Page, endpoint: ResultEndpoint): Promise<MutationMark> => {
  // The visible wait has already proved the endpoint. Two frames here only let
  // the mutation's own rAF stamps land; the stamps themselves are the times.
  await twoFramesAfterVisible(page);
  const mutations = await page.evaluate(() => [
    ...((window as unknown as { __mutationLog?: unknown[] }).__mutationLog ?? []),
  ] as MutationMark[]);
  const mark = mutations.find((one) => endpointMatches(one, endpoint));
  if (mark?.raf2 === undefined) throw new Error(`no painted mutation matched ${JSON.stringify(endpoint)} in ${JSON.stringify(mutations)}`);
  return mark;
};

type StageEvent = {
  readonly t: number;
  readonly process: "renderer" | "main" | "core";
  readonly stage: string;
  readonly op?: string;
  readonly id?: string | number;
  readonly label?: string;
};

const mainStageEvents = (): StageEvent[] => {
  try {
    return readdirSync(MAIN_LOGS)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .flatMap((name) => readFileSync(join(MAIN_LOGS, name), "utf8").split("\n"))
      .flatMap((line) => {
        const at = line.indexOf("PERF-STAGE ");
        if (at === -1) return [];
        try { return [JSON.parse(line.slice(at + "PERF-STAGE ".length)) as StageEvent]; } catch { return []; }
      });
  } catch {
    return [];
  }
};

const rendererStageEvents = (page: Page): Promise<StageEvent[]> =>
  page.evaluate(() => ((window as unknown as { __juntoPerfStages?: unknown[] }).__juntoPerfStages ?? []) as never[]);

const stageTable = (name: string, click: number, painted: number, events: ReadonlyArray<StageEvent>) => {
  const wanted = (event: StageEvent): boolean => {
    if (name === "signal-answer") {
      return (
        event.op === "SignalsAnswer" ||
        event.op === "SignalGet" ||
        event.op === "SignalWriteRow" ||
        event.op === "SignalRecordAnswer" ||
        event.op === "SignalSetThread" ||
        event.op === "SignalsChanged" ||
        event.label === "ipc.work.signal-answer"
      );
    }
    if (name === "thread-create" || name === "thread-reply") {
      return (
        event.op === "seatThreadSend" ||
        event.op === "ThreadsWrite" ||
        event.op === "ThreadsInput" ||
        event.op === "ThreadWriteRow" ||
        event.op === "ThreadsDeliver" ||
        event.op === "WorkMailChanged" ||
        event.op === "ThreadsMessages" ||
        event.label === "ipc.work.thread-send"
      );
    }
    return false;
  };
  const inWindow = events.filter((event) => event.t >= click - 5 && event.t <= painted);
  const requestIds = new Set(
    inWindow
      .filter((event) => wanted(event) && event.id !== undefined)
      .map((event) => event.id),
  );
  const filtered = inWindow
    .filter((event) =>
      wanted(event) ||
      ((event.stage === "main-reply" || event.stage === "rpc-reply-arrived") && event.id !== undefined && requestIds.has(event.id)),
    )
    .sort((a, b) => a.t - b.t);
  const rows = filtered.map((event) => ({
    stage: `${event.process} ${event.stage}${event.op === undefined ? "" : ` ${event.op}`}`,
    atMs: Math.round((event.t - click) * 100) / 100,
  }));
  const timeline = [
    { stage: "click handler start", t: click },
    ...filtered.map((event, index) => ({ stage: rows[index]!.stage, t: event.t })),
    { stage: "first painted frame", t: painted },
  ];
  let largest = { from: "click handler start", to: "first painted frame", ms: painted - click };
  for (let index = 1; index < timeline.length; index += 1) {
    const gap = timeline[index]!.t - timeline[index - 1]!.t;
    if (gap > largest.ms) largest = { from: timeline[index - 1]!.stage, to: timeline[index]!.stage, ms: gap };
  }
  return {
    stages: rows,
    largestGap: { ...largest, ms: Math.round(largest.ms * 100) / 100 },
  };
};

const measureAction = async (
  app: ElectronApplication,
  page: Page,
  name: string,
  act: () => Promise<void>,
  visible: () => Promise<void>,
  endpoint: ResultEndpoint,
) => {
  await resetMeter(app);
  await page.evaluate(() => {
    (window as unknown as { __paintReset: () => void }).__paintReset();
    (window as unknown as { __juntoPerfStages: unknown[] }).__juntoPerfStages = [];
    (window as unknown as { __lastClickAt: number }).__lastClickAt = 0;
    (window as unknown as { __mutationReset?: () => void }).__mutationReset?.();
  });
  const fallbackClick = await page.evaluate(() => Date.now());
  await act();
  const started = await page.evaluate(() => {
    const stamped = (window as unknown as { __lastClickAt: number }).__lastClickAt;
    return stamped === 0 ? Date.now() : stamped;
  });
  const click = started || fallbackClick;
  await visible();
  const resultMutation = await mutationEndpoint(page, endpoint);
  const painted = resultMutation.raf2!;
  await page.waitForTimeout(150);
  const renderer = await page.evaluate(() => (window as unknown as { __paintRead: () => any }).__paintRead());
  const ipcRaw = await readMeter(app);
  const ipcRows = Object.entries(ipcRaw)
    .map(([channel, row]) => ({ channel, calls: row.calls, bytes: Math.round(row.bytes), ms: Math.round(row.ms * 100) / 100 }))
    .sort((a, b) => b.bytes - a.bytes);
  const stages = [...await rendererStageEvents(page), ...mainStageEvents()];
  return {
    name,
    clickToPaintMs: Math.round((painted - click) * 100) / 100,
    clickToResultDomMs: Math.round((resultMutation.t - click) * 100) / 100,
    paintAfterResultDomMs: Math.round((painted - resultMutation.t) * 100) / 100,
    ...stageTable(name, click, painted, stages),
    renderer: {
      worstFrameMs: Math.round((renderer.worstFrame ?? 0) * 100) / 100,
      frameMs: Math.round((renderer.frameMs ?? 0) * 100) / 100,
      longtaskMs: Math.round((renderer.longtaskMs ?? 0) * 100) / 100,
      longtasks: renderer.longtasks.slice(0, 4),
    },
    ipc: {
      calls: ipcRows.reduce((sum, row) => sum + row.calls, 0),
      bytes: ipcRows.reduce((sum, row) => sum + row.bytes, 0),
      handlerMs: Math.round(ipcRows.reduce((sum, row) => sum + row.ms, 0) * 100) / 100,
      top: ipcRows.slice(0, 8),
    },
  };
};

test("[fake-tui] operator signal and thread actions paint on the factory shape", async () => {
  test.setTimeout(600_000);
  await mkdir(FRAMES, { recursive: true });
  const junto = await launchJunto({
    seedModels: { [CANVAS]: factory as never },
    seedAgentSignals: [...shaped.signalRows, perfSignal] as never,
    afterSeed: installCrewSeatHarness,
    windowContentSize: { width: 1500, height: 950 },
    extraEnv: { JUNTO_PERF_STAGES: "1" },
  });
  const { app, page } = junto;
  const results: unknown[] = [];
  try {
    await canvasReady(page, { timeout: 60_000 });
    await crewPlayFactory(page);
    expect(await installMeter(app)).toBeGreaterThan(10);
    await installPaintProbe(page);
    await installEars(page);
    const seat = crewSeat(junto.sandbox, CANVAS, TARGET);
    await crewOccupySeat(page, CANVAS, { id: TARGET }, seat, 60_000);
    await seat.control({ screen: { mode: "working" } });
    await page.waitForTimeout(700);

    // Signal answer: the result is the card leaving Needs you. The seat is working;
    // the real terminal write continues detached after the answer commits.
    await page.getByRole("button", { name: /Needs you/ }).click();
    const card = page.getByTestId("operator-feed-card").filter({ hasText: "PERF signal answer target" }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    results.push(await measureAction(app, page, "control-select-card", async () => {
      await card.click();
    }, async () => {
      await expect(card).toHaveAttribute("aria-current", "true", { timeout: 5_000 });
    }, { kind: "attr", text: "PERF signal answer target", attr: "aria-current", value: "true" }));
    await page.getByRole("button", { name: `Write reply to ${TARGET_LABEL}` }).click();
    await page.getByLabel("Your reply").fill("PERF signal answer: go ahead");
    results.push(await measureAction(app, page, "signal-answer", async () => {
      await page.getByRole("button", { name: "Send reply" }).click();
    }, async () => {
      // The visible result is the card starting its leave, not the end of the
      // feed's intentional 280 ms fade.
      await expect(card.locator("xpath=..")).toHaveClass(/operator-feed__slot--leaving/, { timeout: 15_000 });
    }, { kind: "class", text: "PERF signal answer target", className: "operator-feed__slot--leaving" }));
    await page.keyboard.press("Escape");

    // Thread create from the global Threads modal's real composer.
    await page.keyboard.press(mod("U"));
    const modal = page.locator(".operator-threads").first();
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("operator-threads-new").click();
    const quick = page.getByTestId("quick-thread");
    await quick.getByRole("combobox", { name: "Seat or region" }).fill(TARGET_LABEL);
    await page.keyboard.press("Enter");
    const createText = "PERF thread create body";
    await quick.getByTestId("thread-composer-input").fill(createText);
    const pane = page.getByTestId("operator-threads-pane");
    results.push(await measureAction(app, page, "thread-create", async () => {
      await quick.getByTestId("thread-composer-send").click();
    }, async () => {
      await expect(pane.getByTestId("seat-threads-message").filter({ hasText: createText })).toBeVisible({ timeout: 15_000 });
    }, { kind: "message", text: createText }));

    // Thread reply in the thread that create opened.
    const replyText = "PERF thread reply body";
    await pane.getByTestId("thread-composer-input").fill(replyText);
    results.push(await measureAction(app, page, "thread-reply", async () => {
      await pane.getByTestId("thread-composer-send").click();
    }, async () => {
      await expect(pane.getByTestId("seat-threads-message").filter({ hasText: replyText })).toBeVisible({ timeout: 15_000 });
    }, { kind: "message", text: replyText }));

    // Waiting-mark lifecycle: hold delivery behind a real attention dialog, let
    // the mark appear, then free the seat and prove the same mark leaves when
    // delivery lands. A control-painted draft is not the operator's draft, so
    // production correctly does not hold mail for it.
    await seat.control({ screen: { mode: "attention", text: "Allow command? [y/n]" } });
    await page.waitForTimeout(1800);
    const heldText = "PERF held reply body";
    await page.evaluate(() => {
      const ears = (window as unknown as { __waitingEars: { marks: unknown[]; gone: unknown[] } }).__waitingEars;
      ears.marks.length = 0;
      ears.gone.length = 0;
    });
    await pane.getByTestId("thread-composer-input").fill(heldText);
    const heldStart = await page.evaluate(() => performance.now());
    await pane.getByTestId("thread-composer-send").click();
    const heldMessage = pane.getByTestId("seat-threads-message").filter({ hasText: heldText });
    await expect(heldMessage).toBeVisible({ timeout: 15_000 });
    const waiting = heldMessage.getByTestId("seat-threads-waiting");
    await expect(waiting).toBeVisible({ timeout: 5_000 });
    await seat.control({ screen: { mode: "idle" } });
    await expect(waiting).toHaveCount(0, { timeout: 10_000 });
    const ears = await page.evaluate(() => (window as unknown as { __waitingEars: { marks: Array<{ t: number }>; gone: Array<{ t: number }> } }).__waitingEars);
    const firstMarkMs = ears.marks[0] === undefined ? null : Math.round((ears.marks[0].t - heldStart) * 100) / 100;
    expect(firstMarkMs).not.toBeNull();
    expect(firstMarkMs!).toBeGreaterThan(950);
    results.push({
      name: "waiting-mark-lifecycle",
      markAppearedMs: firstMarkMs,
      markClearedAfterIdleMs: ears.marks[0] === undefined || ears.gone[0] === undefined ? null : Math.round((ears.gone[0].t - ears.marks[0].t) * 100) / 100,
      marks: ears.marks.length,
      cleared: ears.gone.length,
    });
    await page.screenshot({ path: join(FRAMES, "final.png") });
  } finally {
    await writeFile(join(FRAMES, "paint-results.json"), `${JSON.stringify(results, null, 2)}\n`).catch(() => undefined);
    console.log(`OPERATOR-ACTION-PAINT ${JSON.stringify(results)}`);
    await junto.close();
  }
});
