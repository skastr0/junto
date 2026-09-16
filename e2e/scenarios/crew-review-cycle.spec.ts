/** Generated canvas, real process-bound work ops and SQLite owner, fake TUI seats. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, launchVellum, test } from "../harness/launch";
import {
  crewDoc, crewOccupySeat, crewPlayFactory, crewReviewsEdge, crewRule,
  crewSeat, crewSeatNode, crewTasksNode, crewWorksEdge, installCrewSeatHarness,
  crewMessagePasteWrites, crewReceipts,
  type CrewSeat, type WorkEnvelope,
} from "../harness/crew-fixture";
import { taskItem } from "../harness/sandbox";
import type { Message, Task } from "../../src/shared/work-model";
import type { WorkTaskShowView } from "../../src/main/junto/work/service";
import type { VerdictPostArgs } from "../../src/shared/work-control";
import { composeMessageDeliveryPayload } from "../../src/shared/message-delivery";
import { transportLogDirectory } from "../../src/shared/transport-trace";
import type { Page, TestInfo } from "@playwright/test";
import type { Sandbox } from "../harness/sandbox";

const CANVAS = "crew-reviews";
const AUTHOR = "author";
const REVIEWER = "reviewer";
const BOARD = "review-work";
const TASK = "review-candidate";
const TITLE = "Prove the independent review cycle";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const authorNode = crewSeatNode({ id: AUTHOR, label: "Author", x: 40, y: 40 });
const reviewerNode = crewSeatNode({ id: REVIEWER, label: "Reviewer", x: 360, y: 40 });
const boardNode = crewTasksNode({
  id: BOARD, x: 680, y: 40,
  items: [taskItem(TASK, TITLE)],
  contract: {
    incoming: { admission: "auto" },
    rules: [crewRule("independent-review", "An independent reviewer must approve the candidate", "requires-review")],
  },
});
const nodes = [authorNode, reviewerNode, boardNode];
const doc = crewDoc(nodes, [
  crewWorksEdge("author-works", BOARD, AUTHOR, nodes),
  crewReviewsEdge("reviewer-reviews", REVIEWER, AUTHOR, nodes),
]);

const data = <T>(result: WorkEnvelope): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as T;
};

const show = async (author: CrewSeat): Promise<WorkTaskShowView> =>
  data(await author.op("tasks.show", { target: BOARD, task: TASK }));

const claim = async (author: CrewSeat): Promise<void> => {
  // The normal factory may already have assigned the only eligible author.
  if ((await show(author)).task.state === "submitted") {
    data(await author.op("tasks.claim", { target: BOARD, task: TASK }));
  }
  expect((await show(author)).task.state).toBe("working");
};

const evidence = (sha: string) => ({ artifacts: [], git: { commits: [sha] } });

/** Checkout identity is not proof of which source produced existing out bytes. */
const launchProvenance = async () => {
  const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
  const checkout = (() => {
    try {
      return {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        diffSha256: hash(execFileSync("git", ["diff", "HEAD"])),
      };
    } catch (error) { return { error: String(error) }; }
  })();
  const rendererDirectory = join(process.cwd(), "out", "renderer", "assets");
  const assets = await readdir(rendererDirectory).then(
    (names) => ({ ok: true as const, names: names.filter((name) => /\.(js|css)$/.test(name)).sort() }),
    (error: unknown) => ({ ok: false as const, error: String(error) }),
  );
  const files = [
    "out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html",
    ...(assets.ok ? assets.names.map((name) => `out/renderer/assets/${name}`) : []),
  ];
  const bundles = await Promise.all(files.map(async (file) => {
    try {
      const body = await readFile(join(process.cwd(), file));
      return { file, bytes: body.length, sha256: hash(body) };
    } catch (error) { return { file, error: String(error) }; }
  }));
  return {
    capturedAt: new Date().toISOString(), checkout, bundles,
    rendererAssets: assets,
    builtSourceCorrespondence: "unverified-by-spec",
  };
};

const preserveFinalEvidence = async (
  app: Awaited<ReturnType<typeof launchVellum>>,
  testInfo: TestInfo,
  provenance: Awaited<ReturnType<typeof launchProvenance>>,
) => {
  const { page, sandbox } = app;
  const capturedAt = new Date().toISOString();
  const boundedAppRead = async <T>(read: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Final app evidence read timed out after 10000ms")), 10_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const capture = async (
    name: string,
    contentType: string,
    read: () => Promise<Buffer | string>,
    optional = false,
  ) => {
    try {
      const body = await read();
      const path = testInfo.outputPath(name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await testInfo.attach(name, { path, contentType });
      return {
        name, path, status: "preserved" as const,
        bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
      };
    } catch (error) {
      if (optional && error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { name, status: "not-present" as const };
      }
      return { name, status: "failed" as const, error: String(error) };
    }
  };
  const logs = transportLogDirectory(sandbox.homeDir);
  const artifacts = await Promise.all([
    capture("pty-delivery.jsonl", "application/x-ndjson", () => readFile(join(logs, "pty-delivery.jsonl"))),
    capture("pty-delivery.jsonl.1", "application/x-ndjson", () => readFile(join(logs, "pty-delivery.jsonl.1")), true),
    ...[AUTHOR, REVIEWER].map((nodeId) => capture(`${nodeId}-events.ndjson`, "application/x-ndjson",
      () => readFile(join(crewSeat(sandbox, CANVAS, nodeId).dir, "events.ndjson")))),
    capture("canvas-final.json", "application/json", async () => JSON.stringify(
      await boundedAppRead(() => page.evaluate(async (name) => window.vellumCommand!.readCanvas(name), CANVAS)), null, 2)),
    capture("runtime-final.json", "application/json", async () => {
      const sessions = await boundedAppRead(() => page.evaluate(async (canvas) =>
        (await window.vellumCommand!.terminalList()).filter((session) => session.canvasName === canvas), CANVAS));
      return JSON.stringify({
        capturedAt, provenance, mainPid: app.app.process().pid,
        home: sandbox.homeDir, canvas: CANVAS, sessions,
      }, null, 2);
    }),
  ]);
  const manifest = {
    capturedAt, phase: "final-before-close", provenance,
    mainPid: app.app.process().pid, home: sandbox.homeDir, canvas: CANVAS,
    artifacts,
  };
  const manifestPath = testInfo.outputPath("evidence-final.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await testInfo.attach("final-evidence", { path: manifestPath, contentType: "application/json" });
  const failures = artifacts.filter((entry) => entry.status === "failed");
  if (failures.length > 0) throw new Error(`Final review evidence is incomplete: ${JSON.stringify(failures)}`);
};

const receiptSubject = async (
  page: Page,
  sandbox: Sandbox,
  reviewer: CrewSeat,
  epoch: number,
  pasteCounts: Map<string, number>,
): Promise<Extract<VerdictPostArgs["subject"], { kind: "task" }>> => {
  let found: Message | undefined;
  await expect.poll(async () => {
    const inbox = await page.evaluate(async ({ canvas, nodeId }) => {
      const read = await window.vellumCommand!.readCanvas(canvas);
      return read.doc.nodes.find((node) => node.id === nodeId)?.ether?.messages?.items ?? [];
    }, { canvas: CANVAS, nodeId: REVIEWER });
    found = inbox.find((message) => {
      const subject = message.metadata?.reviewSubject as { taskId?: string; epoch?: number } | undefined;
      return message.metadata?.mailKind === "receipt" && subject?.taskId === TASK && subject.epoch === epoch;
    });
    return found !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  // A durable mailbox row alone cannot qualify the PTY delivery path.
  await expect.poll(async () => (await crewReceipts(page, CANVAS, REVIEWER))
    .some((receipt) => receipt.messageId === found!.messageId && receipt.deliveredAt !== undefined),
  { timeout: 30_000 }).toBe(true);
  const payload = composeMessageDeliveryPayload(found!);
  const count = await crewMessagePasteWrites(page, sandbox, CANVAS, REVIEWER, found!.messageId);
  // Distinct messages may produce identical compact notices; compare each
  // sequential review turn with the prior count for that exact payload.
  expect(count - (pasteCounts.get(payload) ?? 0)).toBe(1);
  pasteCounts.set(payload, count);
  data(await reviewer.op("msg.list", {}));
  const subject = found!.metadata!.reviewSubject as Extract<VerdictPostArgs["subject"], { kind: "task" }>;
  expect(subject.subjectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(found!.metadata!.fromSeat).toBeTruthy();
  return subject;
};

test("crew reviews [fake-tui]: receipt, blocking, repair and green reach the live verdict chain", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const provenance = await launchProvenance();
  const app = await launchVellum({
    seedCanvases: { [CANVAS]: doc },
    afterSeed: installCrewSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });
  let testFailed = false;
  try {
    const { page, sandbox } = app;
    const runtime = { mainPid: app.app.process().pid, home: sandbox.homeDir, canvas: CANVAS };
    console.log("CREW_REVIEW_RUNTIME", JSON.stringify(runtime));
    await testInfo.attach("runtime", { body: JSON.stringify(runtime), contentType: "application/json" });
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const author = crewSeat(sandbox, CANVAS, AUTHOR);
    const reviewer = crewSeat(sandbox, CANVAS, REVIEWER);
    const pasteCounts = new Map<string, number>();
    await crewOccupySeat(page, CANVAS, authorNode, author);
    await crewOccupySeat(page, CANVAS, reviewerNode, reviewer);
    await expect.poll(async () => (await author.events())
      .filter((event) => event.event === "submit" && typeof event.text === "string" && event.text.length > 0)
      .length, { timeout: 30_000 }).toBeGreaterThan(0);
    await claim(author);

    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "working", completionEvidence: evidence(SHA_A) }));
    const firstSubject = await receiptSubject(page, sandbox, reviewer, 0, pasteCounts);
    expect((await show(author)).reviewSubject.subjectHash).toBe(firstSubject.subjectHash);

    // A reviews edge grants verdicts, not task reads or terminal input/observation.
    for (const [op, args] of [
      ["tasks.show", { target: BOARD, task: TASK }],
      ["seat.read", { target: AUTHOR, lines: 10 }],
    ] as const) {
      const denied = await reviewer.op(op, args);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.type).toBe("ScopeError");
    }
    const noGreen = await author.op("tasks.update", { target: BOARD, task: TASK, state: "completed", completionEvidence: evidence(SHA_A) });
    expect(noGreen.ok, JSON.stringify(noGreen)).toBe(false);
    expect((await show(author)).task.state).toBe("working");
    const self = await author.op("verdict.post", { target: BOARD, subject: firstSubject, kind: "green" });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.type).toBe("ReviewerIsAuthor");

    const blocked = data<{ effect: string; newEpoch: number }>(await reviewer.op("verdict.post", {
      target: BOARD, subject: firstSubject, kind: "blocking",
      findings: ["Add the missing acceptance case"], refs: [{ kind: "commit", sha: SHA_A }],
    }));
    expect(blocked).toMatchObject({ effect: "rejected", newEpoch: 1 });
    const afterBlock = await show(author);
    expect(afterBlock.task.epoch).toBe(1);
    expect(afterBlock.task.defects).toHaveLength(1);
    expect(afterBlock.task.completionEvidence).toBeUndefined();
    expect(afterBlock.verdicts.map((verdict) => verdict.kind)).toEqual(["blocking"]);

    const stale = await reviewer.op("verdict.post", { target: BOARD, subject: firstSubject, kind: "green" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details?.reason).toBe("stale-subject");
    await author.control({ screen: { mode: "idle" } });
    await reviewer.control({ screen: { mode: "idle" } });
    await claim(author);
    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "working", completionEvidence: evidence(SHA_B) }));
    const repairedSubject = await receiptSubject(page, sandbox, reviewer, 1, pasteCounts);
    expect(repairedSubject.subjectHash).not.toBe(firstSubject.subjectHash);
    data(await reviewer.op("verdict.post", { target: BOARD, subject: repairedSubject, kind: "green", refs: [{ kind: "commit", sha: SHA_B }] }));
    data(await author.op("tasks.update", { target: BOARD, task: TASK, state: "completed", completionEvidence: evidence(SHA_B) }));
    expect((await show(author)).task.state).toBe("completed");

    // Read the app's canonical projection, never a second database connection.
    const projected = await page.evaluate(async ({ canvas, board, task }) => {
      const read = await window.vellumCommand!.readCanvas(canvas);
      return read.doc.nodes.find((node) => node.id === board)?.ether?.tasks?.items.find((item) => item.id === task);
    }, { canvas: CANVAS, board: BOARD, task: TASK }) as Task;
    expect(projected.subjectHash).toBe(repairedSubject.subjectHash);
    expect(projected.verdicts?.map((verdict) => [verdict.kind, verdict.epoch])).toEqual([["blocking", 0], ["green", 1]]);

    await page.locator(`.react-flow__node[data-id="${BOARD}"]`).getByTestId("tasks-card").dispatchEvent("dblclick");
    const board = page.getByRole("dialog", { name: "Task board" });
    await board.getByTestId("task-board-card").filter({ hasText: TITLE }).click();
    const chain = page.getByTestId("verdict-chain");
    await expect(chain).toBeVisible();
    await expect(chain.locator('[data-verdict="blocking"][data-epoch="0"]')).toContainText("Add the missing acceptance case");
    await expect(chain.locator('[data-verdict="green"][data-epoch="1"]')).toHaveAttribute("data-current", "true");
    const screenshot = testInfo.outputPath("crew-verdict-chain.png");
    await chain.screenshot({ path: screenshot });
    await testInfo.attach("verdict-chain", { path: screenshot, contentType: "image/png" });

    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-bar-input").fill("> Open canvas digest");
    await page.getByRole("option", { name: /Open canvas digest/ }).click();
    const digest = page.getByTestId("canvas-digest-body");
    await expect(digest).toBeVisible();
    await expect(digest).toContainText("blocking");
    await expect(digest).toContainText("green");
    await expect(digest).toContainText(repairedSubject.subjectHash.slice(0, 12));
    const digestScreenshot = testInfo.outputPath("crew-review-digest.png");
    await page.getByTestId("canvas-digest").screenshot({ path: digestScreenshot });
    await testInfo.attach("review-digest", { path: digestScreenshot, contentType: "image/png" });
    if (process.env.CREW_REVIEW_VISUAL_HOLD === "1") await page.waitForTimeout(60_000);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    try {
      await preserveFinalEvidence(app, testInfo, provenance);
    } catch (error) {
      // Keep the original assertion failure. Preservation errors remain in the
      // manifest and console; an otherwise successful run must fail on them.
      if (!testFailed) throw error;
      console.error("CREW_REVIEW_EVIDENCE_ERROR", String(error));
    } finally {
      try {
        await app.close();
      } catch (error) {
        if (!testFailed) throw error;
        console.error("CREW_REVIEW_CLOSE_ERROR", String(error));
      }
    }
  }
});
