/**
 * Board detail e2e: the operator's authored board title survives topic
 * creation and persistence, counts stay singular, the detail surface opens
 * with a stable testid, a mock-seat board.post lands live in the open
 * surface and clears through Mark read, and Notify all reports its outcome.
 * No real Claude, Codex, or Grok.
 */
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const CANVAS = "board-detail";
const BOARD_ID = "board-1";
const SEAT_ID = "seat";

const boardNode = (text: string): TextNode => ({
  id: BOARD_ID,
  type: "text",
  text,
  x: 320,
  y: 40,
  width: 240,
  height: 120,
  ether: { entity: { kind: "board" as const } },
});

/**
 * Process-bound mock seat: polls an inbox file, calls the named work op on
 * the Command Center control socket, and writes the envelope to an outbox
 * file. The same pattern as pad-agent-refusal.spec.ts.
 */
const MOCK_SEAT = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const inbox = process.env.BOARD_E2E_INBOX;
const outbox = process.env.BOARD_E2E_OUTBOX;
const workHome =
  process.env.JUNTO_WORK_HOME ||
  path.join(process.env.HOME || "", ".vellum-command", "work");
const sock = path.join(workHome, "control.sock");
const tokPath = path.join(workHome, "token");

const call = (op, args) =>
  new Promise((resolve, reject) => {
    let token;
    try {
      token = fs.readFileSync(tokPath, "utf8").trim();
    } catch (error) {
      reject(error);
      return;
    }
    const socket = net.createConnection({ path: sock });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("work call timed out"));
    }, 15_000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ token, op, args }) + "\\n");
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buf.subarray(0, nl).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const loop = async () => {
  if (!inbox || !outbox || !fs.existsSync(inbox)) return;
  try {
    const job = JSON.parse(fs.readFileSync(inbox, "utf8"));
    fs.unlinkSync(inbox);
    const result = await call(job.op, job.args);
    fs.writeFileSync(outbox, JSON.stringify(result));
  } catch (error) {
    try {
      fs.writeFileSync(
        outbox,
        JSON.stringify({
          ok: false,
          error: { type: "InternalError", message: String(error && error.message ? error.message : error) },
        }),
      );
    } catch {
      // ignore
    }
  }
};
setInterval(() => {
  void loop();
}, 100);
`;

type WorkEnvelope =
  | { readonly ok: true; readonly data?: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly type: string; readonly message: string };
    };

const e2ePath = (mockDir: string): string => {
  const fakes = join(process.cwd(), "e2e/fakes/bin");
  const nodeDir = dirname(process.execPath);
  return `${mockDir}:${fakes}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
};

const callSeat = async (
  inbox: string,
  outbox: string,
  op: string,
  args?: unknown,
): Promise<WorkEnvelope> => {
  await unlink(outbox).catch(() => undefined);
  await writeFile(inbox, JSON.stringify({ op, args }), "utf8");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(outbox, "utf8");
      await unlink(outbox).catch(() => undefined);
      return JSON.parse(raw) as WorkEnvelope;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`seat work ${op} produced no envelope`);
};

const openBoardDetail = async (
  page: import("@playwright/test").Page,
): Promise<void> => {
  await page
    .locator(".react-flow__node", { hasText: "Fleet announcements" })
    .first()
    .click();
  const kindStrip = page.locator(".rts-kind-surface .rts-kind-strip");
  await expect(kindStrip).toBeVisible();
  await kindStrip.getByRole("button", { name: "Open board" }).click();
  await expect(page.getByTestId("board-detail")).toBeVisible();
};

const createTopicUi = async (
  page: import("@playwright/test").Page,
  title: string,
  body: string,
): Promise<void> => {
  // The header key, not the empty-state CTA (both read "New topic").
  await page
    .getByTestId("board-detail")
    .locator(".board-header")
    .getByRole("button", { name: "New topic" })
    .click();
  const composer = page.getByRole("textbox", { name: "Topic title" });
  await composer.fill(title);
  await page.getByRole("textbox", { name: "Opening note" }).fill(body);
  await page
    .getByTestId("board-detail")
    .getByRole("button", { name: "Create topic" })
    .click();
  await expect(
    page.locator(".board-topic-row", { hasText: title }).first(),
  ).toBeVisible();
};

const SHOTS = ".amp/in/artifacts/board-detail-e2e";

test.describe(() => {
  test.use({
    vellumOptions: {
      seedCanvases: {
        [CANVAS]: canvasDoc([boardNode("Fleet announcements")]),
      },
    },
  });

  test("board detail: authored title survives, counts stay singular, notify reports", async ({
    vellumCommand,
  }) => {
    test.setTimeout(120_000);
    const { page } = vellumCommand;

    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".react-flow__node", { hasText: "Fleet announcements" }),
    ).toBeVisible({ timeout: 30_000 });

    await openBoardDetail(page);
    const detail = page.getByTestId("board-detail");

    // The empty board reads the authored title, not the kind name.
    await expect(detail.locator(".board-header")).toContainText(
      "Fleet announcements",
    );
    await expect(detail).toContainText("No topics yet");

    await page.screenshot({
      path: join(SHOTS, "01-empty-board.png"),
      fullPage: false,
    });

    await createTopicUi(page, "Ship the receiver", "Receiver primer");
    await expect(detail.locator(".board-header")).toContainText("1 topic");
    await expect(detail.locator(".board-conversation__header")).toContainText(
      "1 post",
    );
    await page.screenshot({
      path: join(SHOTS, "02-one-topic.png"),
      fullPage: false,
    });

    // Reply: post count goes plural, topic count does not.
    await page.getByRole("textbox", { name: "Reply" }).fill("standing by");
    await detail.getByRole("button", { name: "Post reply" }).click();
    await expect(
      detail.locator(".board-post", { hasText: "standing by" }),
    ).toBeVisible();
    await expect(detail.locator(".board-conversation__header")).toContainText(
      "2 posts",
    );
    await expect(detail.locator(".board-header")).toContainText("1 topic");

    // Notify all with no connected seats: an honest, empty result.
    await detail.getByRole("button", { name: "Notify all" }).click();
    await expect(page.getByTestId("board-notify-note")).toContainText(
      "No seats notified",
    );

    // The authored title survives the work writes on the persisted document.
    const persisted = await page.evaluate(async (canvas) => {
      const read = await window.vellumCommand!.readCanvas(canvas);
      const node = read.doc.nodes.find((n) => n.id === "board-1");
      return node?.type === "text" ? node.text : "";
    }, CANVAS);
    expect(persisted.split("\n")[0]).toBe("Fleet announcements");

    // Reopen after reload: title and topic persist (SQLite owns truth).
    await page.reload();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".react-flow__node", { hasText: "Fleet announcements" }),
    ).toBeVisible({ timeout: 30_000 });
    await openBoardDetail(page);
    await expect(
      page.locator(".board-topic-row", { hasText: "Ship the receiver" }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("board-detail")).toContainText(
      "Fleet announcements",
    );
    await page.screenshot({
      path: join(SHOTS, "03-reopened.png"),
      fullPage: false,
    });
  });
});

test.describe(() => {
  // The mock seat's inbox/outbox paths are only known at test time, so this
  // scenario launches manually (extraEnv) instead of through the fixture.
  test("board detail: agent post lands live and Mark read clears the lane", async () => {
    test.setTimeout(120_000);
    const mockDir = await mkdtemp(join(tmpdir(), "vellum-command-board-seat-"));
    const inbox = join(mockDir, "inbox.json");
    const outbox = join(mockDir, "outbox.json");
    const mockBin = join(mockDir, "codex");
    await writeFile(mockBin, MOCK_SEAT, "utf8");
    await chmod(mockBin, 0o755);

    const seatNode = agentTextNode({
      id: SEAT_ID,
      key: "local:board-detail",
      label: "seat",
      x: 40,
      y: 40,
    });

    const vellumCommand = await launchVellum({
      extraEnv: {
        PATH: e2ePath(mockDir),
        BOARD_E2E_INBOX: inbox,
        BOARD_E2E_OUTBOX: outbox,
      },
      seedCanvases: {
        [CANVAS]: canvasDoc(
          [seatNode, boardNode("Fleet announcements")],
          [{ id: "e-seat-board", fromNode: SEAT_ID, toNode: BOARD_ID }],
        ),
      },
    });

    try {
      const { page } = vellumCommand;

      await expect(page.locator(".react-flow")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.locator(".react-flow__node", { hasText: "seat" }),
      ).toBeVisible({ timeout: 30_000 });

      // Start the factory and occupy the seat so the mock harness process
      // runs and joins the Command Center control socket.
      const pause = page.getByTestId("factory-pause");
      await expect(pause).toBeVisible({ timeout: 30_000 });
      if ((await pause.getAttribute("data-pause-state")) !== "playing") {
        await pause.click();
        const confirm = page.getByTestId("first-play-confirm");
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.getByRole("button", { name: /play/i }).click();
        }
        await expect(pause).toHaveAttribute("data-pause-state", "playing");
      }

      const occupySeat = () =>
        page.evaluate(
          async ([canvas, node]) => {
            const api = window.vellumCommand!;
            if (typeof api.terminalCreate !== "function") {
              throw new Error("terminalCreate missing");
            }
            await api.terminalCreate({ node, canvasName: canvas });
          },
          [CANVAS, seatNode] as const,
        );
      await occupySeat().catch(() => undefined);
      await expect
        .poll(async () => {
          const ping = await callSeat(inbox, outbox, "ping");
          if (ping.ok) return true;
          await occupySeat().catch(() => undefined);
          return false;
        }, { timeout: 30_000 })
        .toBe(true);

      await openBoardDetail(page);
      const detail = page.getByTestId("board-detail");
      await createTopicUi(page, "Ship the receiver", "Receiver primer");

      const topicId = await page.evaluate(
        async ([canvas, id]) => {
          const list = await window.vellumCommand!.workBoardList(canvas, id);
          if (!list.ok) throw new Error(list.message);
          return list.data.topics[0]?.topicId ?? "";
        },
        [CANVAS, BOARD_ID] as const,
      );
      expect(topicId.length).toBeGreaterThan(0);

      // The mock seat posts through the real control socket.
      const posted = await callSeat(inbox, outbox, "board.post", {
        target: BOARD_ID,
        topicId,
        text: "agent checking in",
      });
      expect(posted.ok).toBe(true);

      // The open surface refreshes live (coalesced canvasChanged), without
      // reopening: the new post appears and the topic lane shows unread.
      await expect(
        detail.locator(".board-post", { hasText: "agent checking in" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator(".react-flow__node").getByTestId("board-glance"),
      ).toContainText("1 new post");
      await expect(detail.getByTestId("board-topic-unread")).toBeVisible();
      await page.screenshot({
        path: join(SHOTS, "04-agent-post-live.png"),
        fullPage: false,
      });

      // Mark read acknowledges exactly what the operator has displayed.
      await detail.getByRole("button", { name: "Mark read" }).click();
      await expect(
        page.locator(".react-flow__node").getByTestId("board-glance"),
      ).not.toContainText("new post", { timeout: 15_000 });
      await expect(detail.getByTestId("board-topic-unread")).toHaveCount(0);
      await page.screenshot({
        path: join(SHOTS, "05-marked-read.png"),
        fullPage: false,
      });
    } finally {
      await vellumCommand.close();
      await rm(mockDir, { recursive: true, force: true });
    }
  });
});
