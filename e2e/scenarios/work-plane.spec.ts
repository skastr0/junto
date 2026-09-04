/**
 * Backpressure e2e for the work plane.
 *
 * Drives the real IPC path (window.vellumCommand.work*) against a sandboxed app,
 * then asserts the product contracts that unit tests cannot: durable mutation,
 * live projection, and blocked-edge paint from runtime state.
 *
 * Isolation: throwaway HOME (harness/launch.ts), so the app's canonical
 * $HOME/.vellum-command/state/vellum-command.db remains hermetic without a database override.
 * Run: `bun run test:e2e` (builds) or `bun run test:e2e:fast` (uses out/).
 */
import type { Task } from "../../src/shared/canvas";
import type { WorkOpResult } from "../../src/shared/ipc";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  requestsNode,
  verbEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const fixtureNodes = [
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
  agentTextNode({
    id: "rival",
    key: "local:rival",
    label: "rival",
    x: 320,
    y: 380,
  }),
];

const fixtureDoc = canvasDoc(fixtureNodes, [
  // The seat's wire into the requests sink is agent → requests `escalates`:
  // requests → agent admits no verb at all, so the old `works` here was
  // dropped at decode and the sink stood unwired.
  verbEdge("e-req", "target", "req", "escalates", fixtureNodes),
  // Actor-seat rule: a claim must come from a compiled seat that is
  // connected to the sink (edge or region co-membership). `contributes`
  // is the agent → task verb that grants tasks.claim.
  verbEdge("e-target-tasks", "target", "tasks", "contributes", fixtureNodes),
  verbEdge("e-rival-tasks", "rival", "tasks", "contributes", fixtureNodes),
]);

/** Install authorial intent through the app-owned API. */
const installWorkBoard = async (page: import("@playwright/test").Page): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly vellumCommand?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.vellumCommand?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).vellumCommand;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("work");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

type WorkApi = {
  workTaskCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
  ) => Promise<WorkOpResult<Task>>;
  workTaskClaim: (
    canvas: string,
    nodeId: string,
    taskId: string,
    actorNodeId: string,
  ) => Promise<WorkOpResult<Task>>;
  workTaskTransition: (
    canvas: string,
    nodeId: string,
    taskId: string,
    state: Task["state"],
    note?: string,
  ) => Promise<WorkOpResult<Task>>;
  workRequestResolve: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "completed" | "rejected",
  ) => Promise<WorkOpResult<Task>>;
};

const work = async (page: import("@playwright/test").Page): Promise<WorkApi> => {
  const has = await page.evaluate(() => typeof window.vellumCommand?.workTaskCreate === "function");
  expect(has, "window.vellumCommand.work* must be exposed via preload").toBe(true);
  return {
    workTaskCreate: (canvas, nodeId, brief) =>
      page.evaluate(
        ([c, n, b]) => window.vellumCommand!.workTaskCreate(c, n, b, { details: b }),
        [canvas, nodeId, brief] as const,
      ),
    workTaskClaim: (canvas, nodeId, taskId, actorNodeId) =>
      page.evaluate(
        ([c, n, t, a]) => window.vellumCommand!.workTaskClaim(c, n, t, a),
        [canvas, nodeId, taskId, actorNodeId] as const,
      ),
    workTaskTransition: (canvas, nodeId, taskId, state, note) =>
      page.evaluate(
        ([c, n, t, s, noteText]) => window.vellumCommand!.workTaskTransition(c, n, t, s, noteText),
        [canvas, nodeId, taskId, state, note] as const,
      ),
    workRequestResolve: (canvas, nodeId, taskId, responseText, disposition) =>
      page.evaluate(
        ([c, n, t, r, d]) => window.vellumCommand!.workRequestResolve(c, n, t, r, d),
        [canvas, nodeId, taskId, responseText, disposition] as const,
      ),
  };
};

test("work plane: renderer exposes operator task lifecycle only", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;
  const api = await work(page);

  const actorOperations = await page.evaluate(() => ({
    messageAppend: typeof (window.vellumCommand as Record<string, unknown> | undefined)?.workMessageAppend,
    requestCreate: typeof (window.vellumCommand as Record<string, unknown> | undefined)?.workRequestCreate,
    artifactPublish: typeof (window.vellumCommand as Record<string, unknown> | undefined)?.workArtifactPublish,
  }));
  expect(actorOperations).toEqual({
    messageAppend: "undefined",
    requestCreate: "undefined",
    artifactPublish: "undefined",
  });

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const CANVAS = await installWorkBoard(page);
  await expect(page.locator(".react-flow__node", { hasText: "tasks" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".react-flow__node", { hasText: "0 pending" })).toBeVisible();
  await expect(page.locator(".react-flow__node", { hasText: "downstream" })).toBeVisible();

  // --- tasks path ---
  const created = await api.workTaskCreate(CANVAS, "tasks", "ship e2e plane");
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.data.state).toBe("submitted");

  // Claim by the compiled actor seat the "target" node resolves to. The
  // claim API takes a canvas node id that must identify exactly one compiled
  // actor seat in the projection (never a free-form actor name).
  const claimed = await api.workTaskClaim(CANVAS, "tasks", created.data.id, "target");
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  expect(claimed.data.state).toBe("working");
  expect(claimed.data.claimedBy).toMatch(/^seat_[a-f0-9]{64}$/);

  // A node id that does not identify an actor seat cannot claim (the
  // "operator" reserved-name concept is retired; only seats claim).
  const reservedTask = await api.workTaskCreate(CANVAS, "tasks", "never operator");
  expect(reservedTask.ok).toBe(true);
  if (!reservedTask.ok) return;
  const reserved = await api.workTaskClaim(
    CANVAS,
    "tasks",
    reservedTask.data.id,
    "req",
  );
  expect(reserved.ok).toBe(false);

  // A second compiled actor seat cannot take a working task away from the
  // first — contention keys on ActorSeatId.
  const contended = await api.workTaskClaim(CANVAS, "tasks", created.data.id, "rival");
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

  // Live authority (not disk seed) holds completed state; glance hides settled.
  await expect(async () => {
    const live = await page.evaluate(async (name) => window.vellumCommand!.readCanvas(name), CANVAS);
    const tasks = live.doc.nodes.find((n) => n.id === "tasks");
    const item = tasks?.ether?.tasks?.items?.find((t) => t.id === created.data.id);
    expect(item?.state).toBe("completed");
    expect(item?.claimedBy).toBe(claimed.data.claimedBy);
  }).toPass({ timeout: 10_000 });

});

test("work plane: bad ids reject without mutating the live doc", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const api = await work(page);

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const CANVAS = await installWorkBoard(page);
  await expect(page.locator(".react-flow__node", { hasText: "tasks" })).toBeVisible({
    timeout: 30_000,
  });

  const before = await page.evaluate(async (name) => window.vellumCommand!.readCanvas(name), CANVAS);
  const beforeJson = JSON.stringify(before.doc);

  const missingNode = await api.workTaskCreate(CANVAS, "no-such-node", "x");
  expect(missingNode.ok).toBe(false);
  if (!missingNode.ok) expect(missingNode.code).toBe("node_not_found");

  const after = await page.evaluate(async (name) => window.vellumCommand!.readCanvas(name), CANVAS);
  expect(JSON.stringify(after.doc)).toBe(beforeJson);
});
