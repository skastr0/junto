/**
 * Backpressure e2e for the A2A work plane.
 *
 * Drives the real IPC path (window.vellum.work*) against a sandboxed app,
 * then asserts the product contracts that unit tests cannot: file write,
 * hot-reload, and blocked-edge paint from live document state.
 *
 * Isolation: throwaway VELLUM_CANVASES_DIR + HOME (harness/launch.ts).
 * Run: `bun run test:e2e` (builds) or `bun run test:e2e:fast` (uses out/).
 */
import type { A2ATask, Artifact, Message } from "../../src/shared/canvas";
import type { WorkOpResult } from "../../src/shared/ipc";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  readCanvasFile,
  requestsNode,
  tasksCriteriaEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "a2a-work";

test.use({
  vellumOptions: {
    seedCanvases: {
      // Name sorts first so boot opens this canvas (App.tsx list[0]).
      // Target is a physics **actor** — only actors enter the blocked set.
      [CANVAS]: canvasDoc(
        [
          tasksNode({ id: "tasks", x: 40, y: 40 }),
          requestsNode({ id: "req", x: 320, y: 40 }),
          artifactsNode({ id: "art", x: 600, y: 40 }),
          agentTextNode({
            id: "target",
            key: "local:downstream",
            label: "downstream",
            x: 320,
            y: 240,
          }),
        ],
        [tasksCriteriaEdge("e-req", "req", "target")],
      ),
    },
  },
});

type WorkApi = {
  workTaskCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  workTaskClaim: (
    canvas: string,
    nodeId: string,
    taskId: string,
    actor: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  workTaskTransition: (
    canvas: string,
    nodeId: string,
    taskId: string,
    state: A2ATask["state"],
    note?: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  workRequestCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  workRequestResolve: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "completed" | "rejected",
  ) => Promise<WorkOpResult<A2ATask>>;
  workArtifactPublish: (
    canvas: string,
    nodeId: string,
    artifact: Artifact,
  ) => Promise<WorkOpResult<Artifact>>;
  workMessageAppend: (
    canvas: string,
    nodeId: string,
    taskId: string | null,
    message: Message,
  ) => Promise<WorkOpResult<Message>>;
};

const work = async (page: import("@playwright/test").Page): Promise<WorkApi> => {
  const has = await page.evaluate(() => typeof window.vellum?.workTaskCreate === "function");
  expect(has, "window.vellum.work* must be exposed via preload").toBe(true);
  return {
    workTaskCreate: (canvas, nodeId, brief) =>
      page.evaluate(
        ([c, n, b]) => window.vellum!.workTaskCreate(c, n, b),
        [canvas, nodeId, brief] as const,
      ),
    workTaskClaim: (canvas, nodeId, taskId, actor) =>
      page.evaluate(
        ([c, n, t, a]) => window.vellum!.workTaskClaim(c, n, t, a),
        [canvas, nodeId, taskId, actor] as const,
      ),
    workTaskTransition: (canvas, nodeId, taskId, state, note) =>
      page.evaluate(
        ([c, n, t, s, noteText]) => window.vellum!.workTaskTransition(c, n, t, s, noteText),
        [canvas, nodeId, taskId, state, note] as const,
      ),
    workRequestCreate: (canvas, nodeId, brief) =>
      page.evaluate(
        ([c, n, b]) => window.vellum!.workRequestCreate(c, n, b),
        [canvas, nodeId, brief] as const,
      ),
    workRequestResolve: (canvas, nodeId, taskId, responseText, disposition) =>
      page.evaluate(
        ([c, n, t, r, d]) => window.vellum!.workRequestResolve(c, n, t, r, d),
        [canvas, nodeId, taskId, responseText, disposition] as const,
      ),
    workArtifactPublish: (canvas, nodeId, artifact) =>
      page.evaluate(
        ([c, n, art]) => window.vellum!.workArtifactPublish(c, n, art as Artifact),
        [canvas, nodeId, artifact] as const,
      ),
    workMessageAppend: (canvas, nodeId, taskId, message) =>
      page.evaluate(
        ([c, n, t, m]) => window.vellum!.workMessageAppend(c, n, t, m as Message),
        [canvas, nodeId, taskId, message] as const,
      ),
  };
};

test("A2A work plane: task claim/transition, request blocks then clears, artifact on disk", async ({
  vellum,
}) => {
  const { page, sandbox } = vellum;
  const api = await work(page);

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".react-flow__node", { hasText: "tasks" })).toBeVisible();
  await expect(page.locator(".react-flow__node", { hasText: "0 pending" })).toBeVisible();
  await expect(page.locator(".react-flow__node", { hasText: "downstream" })).toBeVisible();

  // --- tasks path ---
  const created = await api.workTaskCreate(CANVAS, "tasks", "ship e2e plane");
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.data.state).toBe("submitted");

  const claimed = await api.workTaskClaim(CANVAS, "tasks", created.data.id, "e2e-worker");
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  expect(claimed.data.state).toBe("working");
  expect(claimed.data.metadata?.claimedBy).toBe("e2e-worker");

  const reservedTask = await api.workTaskCreate(CANVAS, "tasks", "never operator");
  expect(reservedTask.ok).toBe(true);
  if (!reservedTask.ok) return;
  const reserved = await api.workTaskClaim(
    CANVAS,
    "tasks",
    reservedTask.data.id,
    "operator",
  );
  expect(reserved.ok).toBe(false);

  const contended = await api.workTaskClaim(CANVAS, "tasks", created.data.id, "intruder");
  expect(contended.ok).toBe(false);
  if (!contended.ok) expect(contended.code).toBe("claim_contention");

  const done = await api.workTaskTransition(
    CANVAS,
    "tasks",
    created.data.id,
    "completed",
    "shipped via e2e",
  );
  expect(done.ok).toBe(true);

  // Card mirror + file
  await expect(page.locator(".react-flow__node", { hasText: "ship e2e plane" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(async () => {
    const doc = await readCanvasFile(sandbox, CANVAS);
    const tasks = doc.nodes.find((n) => n.id === "tasks");
    const item = tasks?.ether?.tasks?.items.find((t) => t.id === created.data.id);
    expect(item?.state).toBe("completed");
    expect(item?.metadata?.claimedBy).toBe("e2e-worker");
  }).toPass({ timeout: 10_000 });

  // --- requests block → resolve clear ---
  // data-blocked lives on the inner .vellum-node shell, not the RF wrapper.
  const targetShell = page.locator('.react-flow__node[data-id="target"] .vellum-node');
  await expect(targetShell).toBeVisible();
  await expect(targetShell).not.toHaveAttribute("data-blocked", "true");

  const req = await api.workRequestCreate(CANVAS, "req", "need review");
  expect(req.ok).toBe(true);
  if (!req.ok) return;
  expect(req.data.state).toBe("input-required");

  await expect(async () => {
    const doc = await readCanvasFile(sandbox, CANVAS);
    const items = doc.nodes.find((n) => n.id === "req")?.ether?.requests?.items ?? [];
    expect(items.some((t) => t.id === req.data.id && t.state === "input-required")).toBe(true);
  }).toPass({ timeout: 10_000 });

  await expect(async () => {
    await expect(targetShell).toHaveAttribute("data-blocked", "true");
  }).toPass({ timeout: 15_000 });

  const resolved = await api.workRequestResolve(
    CANVAS,
    "req",
    req.data.id,
    "lgtm",
    "completed",
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.data.state).toBe("completed");

  await expect(async () => {
    await expect(targetShell).not.toHaveAttribute("data-blocked", "true");
  }).toPass({ timeout: 15_000 });

  // --- artifacts ---
  const art = await api.workArtifactPublish(CANVAS, "art", {
    artifactId: "art-e2e-1",
    name: "report.txt",
    parts: [{ kind: "text", text: "e2e body" }],
    taskId: created.data.id,
  });
  expect(art.ok).toBe(true);

  await expect(page.locator(".react-flow__node", { hasText: "report.txt" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(async () => {
    const doc = await readCanvasFile(sandbox, CANVAS);
    const items = doc.nodes.find((n) => n.id === "art")?.ether?.artifacts?.items ?? [];
    expect(items.some((a) => a.artifactId === "art-e2e-1" && a.taskId === created.data.id)).toBe(
      true,
    );
  }).toPass({ timeout: 10_000 });
});

test("A2A work plane: bad ids reject without mutating the file", async ({ vellum }) => {
  const { page, sandbox } = vellum;
  const api = await work(page);

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  const before = await readCanvasFile(sandbox, CANVAS);
  const beforeJson = JSON.stringify(before);

  const missingNode = await api.workTaskCreate(CANVAS, "no-such-node", "x");
  expect(missingNode.ok).toBe(false);
  if (!missingNode.ok) expect(missingNode.code).toBe("node_not_found");

  const after = await readCanvasFile(sandbox, CANVAS);
  expect(JSON.stringify(after)).toBe(beforeJson);
});
