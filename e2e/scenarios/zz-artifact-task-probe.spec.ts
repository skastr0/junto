/**
 * Artifact/task probe (measurement only, never a gate): what the window
 * pays for the operator's factory-shaped work data — 515 artifacts on the
 * operator's 29 Artifacts nodes with the anonymous per-document shape
 * (477 documents, ~4.6 MB, max 208 KB; e2e/scenarios/
 * zz-artifact-shape.factory.json) plus 38 links, and 744 tasks with ~985 KB
 * of bodies on 3 task boards — seeded straight into
 * junto.db through afterSeed (artifact_heads/versions, task_heads,
 * task_numbers), then:
 *
 *   boot      canvas open + settle, traced (the resident-data baseline)
 *   open-art  dblclick an Artifacts card, then pick rows across the size
 *             spread; row click -> detail first frame, ms
 *   open-task same for task boards -> task-detail first frame, ms
 *   writes    artifact edit-replace + task edit storm at PROBE_WRITES/s for
 *             PROBE_SECONDS, traced: board busy, tasks>16/50, frames/s,
 *             per-apply ms. This is where shared reads (4c919860d) vs
 *             per-subscriber reads (a6dfcc893) diverge.
 *
 *   PROBE_ONLY=boot,open-art,open-task,writes  (default all)
 *   PROBE_REPS=2  PROBE_SECONDS=10  PROBE_WRITES=4
 *   scripts/run-e2e.sh e2e/scenarios/zz-artifact-task-probe.spec.ts
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { ulid } from "ulid";
import type { ElectronApplication } from "@playwright/test";
import { makeStateEngineLive } from "../../src/core/state/engine";
import { canonicalJson } from "../../src/shared/work-canonical-json";
import { OPERATOR_DISPLAY, type NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import type { Sandbox } from "../harness/sandbox";

const CANVAS = "factory";
const ART_NODES = Array.from({ length: 29 }, (_, i) => `probe-art-${i}`);
const TASK_NODES = ["probe-task-1", "probe-task-2", "probe-task-3"] as const;
const ART_COUNT = 515;
const LINK_COUNT = ART_COUNT - 477;
const TASK_COUNT = 744;
const TASK_BODY_TARGET_BYTES = 985_000;

const REPS = Number(process.env["PROBE_REPS"] ?? 2);
const SECONDS = Number(process.env["PROBE_SECONDS"] ?? 10);
const WRITES = Number(process.env["PROBE_WRITES"] ?? 4);
const ONLY = (process.env["PROBE_ONLY"] ?? "").split(",").filter(Boolean);
const want = (phase: string): boolean => ONLY.length === 0 || ONLY.includes(phase);

type Ev = { name?: string; ph?: string; pid?: number; tid?: number; ts?: number; dur?: number; args?: Record<string, unknown> };

/** Renderer main thread: busy ms/s and top-level tasks by length; frames. */
const read = (events: Ev[], seconds: number) => {
  const threads = new Map<string, string>();
  const procs = new Map<number, string>();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, String(e.args?.["name"]));
    if (e.ph === "M" && e.name === "process_name") procs.set(e.pid!, String(e.args?.["name"]));
  }
  const main = events
    .filter((e) => e.ph === "X" && typeof e.dur === "number" && threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain" && /renderer/i.test(procs.get(e.pid!) ?? "renderer"))
    .sort((a, b) => a.ts! - b.ts!);
  let end = 0;
  let busy = 0;
  const tops: number[] = [];
  for (const e of main) {
    if (e.ts! < end) continue;
    busy += e.dur! / 1000;
    tops.push(e.dur! / 1000);
    end = e.ts! + e.dur!;
  }
  const count = (n: string) => events.filter((e) => e.name === n && e.ph !== "E").length;
  tops.sort((a, b) => b - a);
  return {
    mainBusyMsPerS: Math.round(busy / seconds),
    tasksOver16PerS: +(tops.filter((d) => d > 16).length / seconds).toFixed(2),
    tasksOver50: tops.filter((d) => d > 50).length,
    worstTaskMs: Math.round(tops[0] ?? 0),
    mainFramesPerS: +(count("ProxyMain::BeginMainFrame") / seconds).toFixed(1),
    presentedPerS: Math.round(count("Display::DrawAndSwap") / seconds),
  };
};

const trace = async (app: ElectronApplication, path: string, during: () => Promise<void>) => {
  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({ included_categories: ["toplevel", "devtools.timeline", "viz", "cc", "benchmark", ...(process.env["PROBE_JS"] === "1" ? ["disabled-by-default-v8.cpu_profiler", "v8.execute", "disabled-by-default-devtools.timeline.stack"] : []), ...(process.env["PROBE_CATS"] ?? "").split(",").filter(Boolean)] });
  });
  await during();
  await app.evaluate(async ({ contentTracing }, out) => contentTracing.stopRecording(out), path);
  const raw = JSON.parse(await readFile(path, "utf8")) as { traceEvents?: Ev[] } | Ev[];
  return Array.isArray(raw) ? raw : (raw.traceEvents ?? []);
};

// ── the seeded world ────────────────────────────────────────────────────────

/** Deterministic prose of about `chars` characters: sectioned lines. */
const prose = (seed: number, chars: number): string => {
  const parts: string[] = [];
  let n = 0;
  let line = 0;
  while (n < chars) {
    const text = `Section ${line} of document ${seed}: the quick brown fox writes release notes, checks the diff, and ships the build with a straight face. `;
    parts.push(text);
    n += text.length + 2;
    line += 1;
  }
  return parts.join("\n\n").slice(0, Math.max(0, chars));
};

const TASK_STATES = ["backlog", "assigned", "working", "input-required", "in-review", "done", "canceled"] as const;
/** Weights into TASK_STATES: mostly backlog, a realistic spread of open and closed. */
const TASK_STATE_PLAN = [
  ...Array(55).fill(0), ...Array(15).fill(1), ...Array(10).fill(2), ...Array(5).fill(3),
  ...Array(5).fill(4), ...Array(8).fill(5), ...Array(2).fill(6),
];

interface ArtifactSeedRow {
  readonly id: string;
  readonly node: string;
  readonly type: string;
  readonly title: string;
  readonly bodyJson: string;
  readonly refJson: string;
  readonly updatedAt: number;
  readonly inlineBytes: number;
}
interface TaskSeedRow {
  readonly taskId: string;
  readonly node: string;
  readonly title: string;
  readonly body: string;
}
interface SeedPlan {
  readonly artifactRows: ReadonlyArray<ArtifactSeedRow>;
  readonly taskRows: ReadonlyArray<TaskSeedRow>;
}

const buildSeedPlan = (docs: ReadonlyArray<readonly [number, number]>): SeedPlan => {
  // The operator's anonymous shape: [artifacts-node index, document bytes],
  // 477 documents over 29 nodes (~4.6 MB, max 208 KB). 38 links make up the
  // rest of the 515.
  const artifactRows: ArtifactSeedRow[] = [];
  const BASE = 1_760_000_000_000;
  let inlineTotal = 0;
  const push = (node: string, type: string, title: string, body: unknown, updatedAt: number): void => {
    const inline = canonicalJson(body);
    const bytes = Buffer.from(inline, "utf8");
    inlineTotal += bytes.byteLength;
    artifactRows.push({
      id: ulid(),
      node,
      type,
      title,
      bodyJson: inline,
      refJson: JSON.stringify({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/json",
      }),
      updatedAt,
      inlineBytes: bytes.byteLength,
    });
  };
  docs.forEach(([nodeIndex, bytes], i) => {
    // The shape's byte count is the document's length; ~60 bytes of JSON
    // wrapper and newline escaping ride on top. Tiny docs keep a 20-char
    // floor so they still read as documents.
    const markdown = prose(i + 1, Math.max(20, bytes - 60));
    push(ART_NODES[nodeIndex]!, "document", `Doc-${String(i).padStart(3, "0")}`, { type: "document", markdown }, BASE - i * 1_000);
  });
  for (let i = 0; i < LINK_COUNT; i += 1) {
    push(ART_NODES[i % ART_NODES.length]!, "link", `link-${String(i).padStart(3, "0")}`, { type: "link", target: { kind: "url", url: `https://example.com/release-${i}` } }, BASE - (docs.length + i) * 1_000);
  }
  console.log(`ARTPROBE-SEED artifacts=${artifactRows.length} docs=${docs.length} inlineBytes=${inlineTotal}`);

  const taskRows: TaskSeedRow[] = [];
  const taskBodies: string[] = [];
  const perTask = Math.floor(TASK_BODY_TARGET_BYTES / TASK_COUNT);
  for (let i = 0; i < TASK_COUNT; i += 1) {
    taskBodies.push(prose(50_000 + i, perTask + ((i * 13) % 200) - 100));
    taskRows.push({
      taskId: ulid(),
      node: TASK_NODES[i % TASK_NODES.length]!,
      title: `Task-${String(i).padStart(3, "0")} ship the thing`,
      body: taskBodies[i]!,
    });
  }
  console.log(`ARTPROBE-SEED tasks=${TASK_COUNT} bodyBytes=${taskBodies.reduce((a, b) => a + Buffer.byteLength(b, "utf8"), 0)}`);
  return { artifactRows, taskRows };
};

interface TaskHeadSeed {
  readonly taskId: string;
  readonly number: number;
  readonly node: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly assignee: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const taskHeadsOf = (plan: SeedPlan, seatIds: ReadonlyArray<string>): ReadonlyArray<TaskHeadSeed> => {
  const BASE = 1_760_000_000_000;
  return plan.taskRows.map((row, i) => {
    const state = TASK_STATES[TASK_STATE_PLAN[i % TASK_STATE_PLAN.length]!]!;
    const open = state === "assigned" || state === "working" || state === "input-required" || state === "in-review";
    const closed = state === "done" || state === "canceled";
    const assignee = open || (closed && i % 3 === 0) ? seatIds[i % seatIds.length]! : null;
    const at = BASE + i * 500;
    return { taskId: row.taskId, number: i + 1, node: row.node, title: row.title, body: row.body, state, assignee, createdAt: at, updatedAt: at + 1_000 };
  });
};

const seedWork = (plan: SeedPlan, heads: ReadonlyArray<TaskHeadSeed>) => async (sandbox: Sandbox): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      for (const row of plan.artifactRows) {
        yield* sql`INSERT INTO artifact_heads(
            canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
          VALUES (${CANVAS}, ${row.id}, ${row.node}, ${row.type}, ${row.title}, 1, ${'{"kind":"operator"}'}, ${row.updatedAt}, 0, '[]')`;
        yield* sql`INSERT INTO artifact_versions(
            canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_ref_json, inline_body_json)
          VALUES (${CANVAS}, ${row.id}, 1, ${ulid()}, ${'{"kind":"operator"}'}, ${row.updatedAt}, NULL, ${row.refJson}, ${row.bodyJson})`;
      }
      for (const row of heads) {
        yield* sql`INSERT INTO task_heads(
            canvas_name, task_id, number, node_id, title, body, state, assignee_node_id, epoch,
            stamps_required, reviewers_json, depends_on_json, next_node_id, created_at, updated_at,
            state_since, checks_json, archived_from, evidence_json, handoff, derived_from)
          VALUES (${CANVAS}, ${row.taskId}, ${row.number}, ${row.node}, ${row.title}, ${row.body}, ${row.state},
            ${row.assignee}, 0, 0, '[]', '[]', NULL, ${row.createdAt}, ${row.updatedAt}, ${row.createdAt}, '[]',
            NULL, NULL, NULL, NULL)`;
      }
      yield* sql`INSERT INTO task_numbers(canvas_name, next_number) VALUES (${CANVAS}, ${TASK_COUNT + 1})`;
    })));
  } finally {
    await runtime.dispose();
  }
};

// ── the probe ───────────────────────────────────────────────────────────────

test("artifact/task probe: factory-shaped work data, opens and write busy", async () => {
  test.setTimeout(900_000);
  const parsed = JSON.parse(await readFile(join(process.cwd(), "e2e/scenarios/zz-idle-probe.factory.json"), "utf8")) as Omit<NestedCanvasFixture, "signals"> & { signalRows: ReturnType<NestedCanvasFixture["signals"]> };
  const seatIds = (parsed.model.nodes as ReadonlyArray<{ kind: string; id?: string }>)
    .filter((n) => n.kind === "agent" && n.id)
    .map((n) => n.id!);
  const shape = JSON.parse(await readFile(join(process.cwd(), "e2e/scenarios/zz-artifact-shape.factory.json"), "utf8")) as { docs: ReadonlyArray<readonly [number, number]> };
  expect(shape.docs, "operator shape: 477 documents").toHaveLength(477);
  const plan = buildSeedPlan(shape.docs);
  const heads = taskHeadsOf(plan, seatIds);

  // The work surfaces, parked in empty ground to the east of the board:
  // 29 Artifacts nodes in a 7-column grid, then the 3 task boards under them.
  const extraNodes = [
    ...ART_NODES.map((id, i) => ({ kind: "artifacts", id, label: `Artifacts ${i + 1}`, x: 13_000 + (i % 7) * 360, y: -3_600 + Math.floor(i / 7) * 260, width: 280, height: 160, z: 900 + i })),
    ...TASK_NODES.map((id, i) => ({ kind: "task", id, name: `Board ${i + 1}`, x: 13_000 + i * 360, y: -1_600, width: 320, height: 220, z: 940 + i })),
  ];
  const fixture: NestedCanvasFixture = {
    ...parsed,
    model: { ...parsed.model, nodes: [...parsed.model.nodes, ...(extraNodes as unknown as typeof parsed.model.nodes)] },
    signals: () => parsed.signalRows,
  };

  const junto = await launchJunto({ ...OPERATOR_DISPLAY, nestedCanvas: { fixture, name: CANVAS }, afterSeed: seedWork(plan, heads) });
  try {
    const { app, page } = junto;

    // Boot arm: the reads every mounted card fires land while the canvas
    // settles. Trace through the wait plus a settle beat.
    const bootTrace = want("boot");
    const events = bootTrace
      ? await trace(app, join(process.cwd(), "test-results/zz-arttask-boot.json"), async () => {
          await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 120_000 });
          await page.waitForTimeout(3_000);
        })
      : undefined;
    if (!bootTrace) {
      await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 120_000 });
      await page.waitForTimeout(3_000);
    }
    if (events) {
      const row = { phase: "boot", ...read(events, 3) };
      console.log(`ARTPROBE ${JSON.stringify(row)}`);
    }

    // Count resource IPC calls from here on (opens + writes).
    await page.evaluate(() => {
      const w = window as unknown as { __artIpc: { list: number; all: number; body: number; apply: number; taskApply: number } };
      w.__artIpc = { list: 0, all: 0, body: 0, apply: 0, taskApply: 0 };
      const res = (window as { junto?: { resource?: { artifact?: Record<string, (...a: never[]) => Promise<unknown>>; task?: Record<string, (...a: never[]) => Promise<unknown>> } } }).junto?.resource;
      const wrap = (api: Record<string, (...a: never[]) => Promise<unknown>> | undefined, key: "list" | "all" | "body" | "apply" | "taskApply", counter: "list" | "all" | "body" | "apply" | "taskApply"): void => {
        const fn = api?.[key];
        if (api && fn) api[key] = (...args: never[]) => { w.__artIpc[counter] += 1; return fn(...args); };
      };
      if (res?.artifact) {
        wrap(res.artifact, "list", "list");
        wrap(res.artifact, "body", "body");
        wrap(res.artifact, "apply", "apply");
      }
      if (res?.task) {
        wrap(res.task, "all", "all");
        wrap(res.task, "apply", "taskApply");
      }
    });

    /** Pan/zoom the camera until the node's box sits near viewport centre. */
    const centerOn = async (nodeId: string): Promise<void> => {
      const pane = page.locator(".react-flow__pane");
      for (let i = 0; i < 10; i += 1) {
        const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
        const pb = await pane.boundingBox();
        if (!box || !pb) return;
        const dx = pb.x + pb.width / 2 - (box.x + box.width / 2);
        const dy = pb.y + pb.height / 2 - (box.y + box.height / 2);
        if (Math.abs(dx) < 60 && Math.abs(dy) < 60 && box.width > 120) return;
        const cx = pb.x + pb.width / 2;
        const cy = pb.y + pb.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        // Still tiny: zoom in toward the node, then re-centre. If the wheel
        // went the wrong way the box shrinks — zoom back out once.
        if (box.width <= 120) {
          const nb = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
          if (nb) {
            await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
            await page.keyboard.down("Meta");
            await page.mouse.wheel(0, -240);
            await page.keyboard.up("Meta");
            await page.waitForTimeout(150);
            const after = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
            if (after && after.width < box.width * 0.8) {
              await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
              await page.keyboard.down("Meta");
              await page.mouse.wheel(0, 480);
              await page.keyboard.up("Meta");
              await page.waitForTimeout(150);
            }
          }
        }
      }
    };

    /** Click the row whose text holds `title`; ms until `doneSel` paints a frame. */
    const pickRowMs = (rowScope: string, title: string, doneSel: string): Promise<number> =>
      page.evaluate(
        ([scope, text, done]) =>
          new Promise<number>((resolve) => {
            const t0 = performance.now();
            const rows = [...document.querySelectorAll(`${scope} [role="listitem"]`)];
            const row = rows.find((el) => el.textContent?.includes(text));
            const target = row?.querySelector("button") ?? row;
            target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            const tick = (): void => {
              if (!document.querySelector(done)) {
                if (performance.now() - t0 > 8_000) resolve(-1);
                else requestAnimationFrame(tick);
                return;
              }
              // One more frame: the detail has committed and painted.
              requestAnimationFrame(() => resolve(performance.now() - t0));
            };
            requestAnimationFrame(tick);
          }),
        [rowScope, title, doneSel] as const,
      );

    let openSurface: { kind: "art" | "task"; node: string } | null = null;
    const openNodeSurface = async (kind: "art" | "task", nodeId: string): Promise<number> => {
      await centerOn(nodeId);
      if (openSurface?.kind === kind && openSurface.node === nodeId) return -1;
      if (openSurface !== null) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
      const t0 = await page.evaluate(() => performance.now());
      await page.locator(`.react-flow__node[data-id="${nodeId}"]`).dblclick();
      const listName = kind === "art" ? "Artifacts" : "Tasks";
      await expect(page.getByRole("list", { name: listName })).toBeVisible({ timeout: 20_000 });
      const ms = await page.evaluate(() => performance.now()) - t0;
      openSurface = { kind, node: nodeId };
      return Math.round(ms);
    };

    // Per node: prime with one row, then timed picks on different rows (a
    // re-pick of the selected row does not remount the detail). Nodes span
    // the operator's skew — 110 docs down to 4 — and each group's picks run
    // largest / middle / smallest so the body-size spread is exercised on
    // every node.
    const docsByNode = new Map<string, ArtifactSeedRow[]>();
    for (const row of plan.artifactRows) {
      if (row.type !== "document") continue;
      const list = docsByNode.get(row.node) ?? [];
      list.push(row);
      docsByNode.set(row.node, list);
    }
    const artGroups = [1, 6, 0, 3, 8, 16, 9, 10].flatMap((i) => {
      const node = ART_NODES[i]!;
      const rows = (docsByNode.get(node) ?? []).slice().sort((a, b) => b.inlineBytes - a.inlineBytes);
      if (rows.length < 4) return [];
      return [{
        node,
        prime: rows[1]!.title,
        picks: [rows[0]!, rows[Math.floor(rows.length / 2)]!, rows[rows.length - 1]!].map((r) => r.title),
      }];
    });
    const taskGroups = [
      { node: TASK_NODES[0]!, prime: "Task-252", picks: ["Task-000", "Task-003", "Task-249"] },
      { node: TASK_NODES[1]!, prime: "Task-253", picks: ["Task-001", "Task-250", "Task-499"] },
      { node: TASK_NODES[2]!, prime: "Task-254", picks: ["Task-002", "Task-251", "Task-500"] },
    ];
    const kbOf = new Map(plan.artifactRows.map((row) => [row.title, Math.round(row.inlineBytes / 1024)]));

    // Write storm payloads: artifact edit-replace cycling all 515 (each
    // artifact's version tracked so baseVersion stays honest across reps),
    // task edits cycling all 744.
    const artVersions = new Map<string, number>();
    const opIds = Array.from({ length: 4_000 }, () => ulid());
    let opCursor = 0;
    let artCursor = 0;
    let taskCursor = 0;
    const storm = async (): Promise<{ applies: number; notApplied: number; p50: number; p95: number; max: number }> => {
      const msList: number[] = [];
      let notApplied = 0;
      const gap = 1000 / WRITES;
      const t0 = Date.now();
      for (let i = 0; i < WRITES * SECONDS; i += 1) {
        const isArt = i % 2 === 0;
        const row = isArt ? plan.artifactRows[artCursor++ % ART_COUNT]! : plan.taskRows[taskCursor++ % TASK_COUNT]!;
        const node = isArt ? (row as ArtifactSeedRow).node : (row as TaskSeedRow).node;
        const id = isArt ? (row as ArtifactSeedRow).id : (row as TaskSeedRow).taskId;
        const base = isArt ? (artVersions.get(id) ?? 1) : undefined;
        const t = await page.evaluate(
          async ({ kind, canvas, node, id, base, opId }) => {
            const t0 = performance.now();
            const api = (window as { junto: { resource: { artifact: { apply: (...a: unknown[]) => Promise<{ kind: string }> }; task: { apply: (...a: unknown[]) => Promise<{ kind: string }> } } } }).junto.resource;
            try {
              const out = kind === "art"
                ? await api.artifact.apply(canvas, node, id, opId, {
                    op: "edit",
                    edit: { kind: "replace", baseVersion: base, body: { type: "document", markdown: `# update ${Date.now()}\n\n${"lorem ipsum dolor sit amet ".repeat(120)}` } },
                  })
                : await api.task.apply(canvas, node, id, opId, { kind: "edit", body: `update ${Date.now()}\n${"task body line. ".repeat(80)}` });
              return { ms: performance.now() - t0, kind: out.kind };
            } catch {
              return { ms: performance.now() - t0, kind: "threw" };
            }
          },
          { kind: isArt ? "art" : "task", canvas: CANVAS, node, id, base, opId: opIds[opCursor++ % opIds.length]! },
        );
        msList.push(t.ms);
        if (t.kind !== "applied" && t.kind !== "queued") notApplied += 1;
        else if (isArt) artVersions.set(id, (base ?? 1) + 1);
        const wait = t0 + (i + 1) * gap - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
      }
      msList.sort((a, b) => a - b);
      return {
        applies: msList.length,
        notApplied,
        p50: Math.round(msList[Math.floor(msList.length / 2)] ?? 0),
        p95: Math.round(msList[Math.floor(msList.length * 0.95)] ?? 0),
        max: Math.round(msList[msList.length - 1] ?? 0),
      };
    };

    const rows: Record<string, unknown>[] = [];
    for (let rep = 1; rep <= REPS; rep += 1) {
      if (want("open-art")) {
        for (const group of artGroups) {
          const surfaceMs = await openNodeSurface("art", group.node);
          const prime = await pickRowMs(".artifacts-list", group.prime, ".artifact-document");
          expect(prime, `prime pick ${group.prime} on ${group.node}`).toBeGreaterThan(0);
          for (const title of group.picks) {
            const ms = await pickRowMs(".artifacts-list", title, ".artifact-document");
            expect(ms, `pick ${title} on ${group.node}`).toBeGreaterThan(0);
            const row = { phase: "open-art", rep, node: group.node, title, kb: kbOf.get(title) ?? null, surfaceMs: surfaceMs > 0 ? surfaceMs : null, ms: Math.round(ms) };
            rows.push(row);
            console.log(`ARTPROBE ${JSON.stringify(row)}`);
          }
        }
      }
      if (want("open-task")) {
        for (const group of taskGroups) {
          const surfaceMs = await openNodeSurface("task", group.node);
          const prime = await pickRowMs(".tasks-list", group.prime, '[data-testid="task-detail"]');
          expect(prime, `prime pick ${group.prime} on ${group.node}`).toBeGreaterThan(0);
          for (const title of group.picks) {
            const ms = await pickRowMs(".tasks-list", title, '[data-testid="task-detail"]');
            expect(ms, `pick ${title} on ${group.node}`).toBeGreaterThan(0);
            const row = { phase: "open-task", rep, node: group.node, title, surfaceMs: surfaceMs > 0 ? surfaceMs : null, ms: Math.round(ms) };
            rows.push(row);
            console.log(`ARTPROBE ${JSON.stringify(row)}`);
          }
        }
      }
      if (want("writes")) {
        let outcome: Awaited<ReturnType<typeof storm>> | undefined;
        const events = await trace(app, join(process.cwd(), `test-results/zz-arttask-writes-${rep}.json`), async () => {
          outcome = await storm();
        });
        const row = { phase: "writes", rep, rate: WRITES, seconds: SECONDS, ...(outcome ?? {}), ...read(events, SECONDS) };
        rows.push(row);
        console.log(`ARTPROBE ${JSON.stringify(row)}`);
      }
    }
    const ipc = await page.evaluate(() => (window as { __artIpc?: Record<string, number> }).__artIpc ?? {});
    console.log(`ARTPROBE-IPC ${JSON.stringify(ipc)}`);
    console.log(`ARTPROBE-ALL ${JSON.stringify(rows)}`);
  } finally {
    await junto.close();
  }
});

