/**
 * Isolated real-Devin mail notice [real-harness] — disjoint from fake-tui
 * crew mail/prompt/wait specs (p1H) and reviews E2E (root).
 *
 * Occupy fake sender + real Devin, send fresh durable mail, then Devin
 * process-bound lists/reads. Assert readAt via readCanvas work projection
 * (no SQLite second opener). typedNoticeQualified stays false.
 *
 * Hold for Computer Use: ISOLATED_DEVIN_HOLD=1 (visible window, bounded
 * inspect then always close). ISOLATED_DEVIN_HOLD_MS defaults to 90000.
 * Does not write ~/.vellum-command/state/vellum-command.db.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchVellum, test } from "../harness/launch";
import {
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
} from "../harness/crew-fixture";
import { HARNESS_MAIL_TRANSPORT } from "../../src/shared/managed-terminal-templates";
import {
  ISOLATED_DEVIN_CREDENTIAL_REL,
  ISOLATED_DEVIN_MAIL_CANVAS,
  ISOLATED_DEVIN_RECEIVER_ID,
  ISOLATED_DEVIN_SENDER_ID,
  isolatedDevinMailDoc,
  isolatedDevinReceiverNode,
  isolatedDevinSenderNode,
  resolveOperatorDevinBinary,
  seedIsolatedDevinAppHome,
} from "../harness/isolated-devin-mail-fixture";

const operatorHome = homedir();
const operatorCred = join(operatorHome, ISOLATED_DEVIN_CREDENTIAL_REL);
const HOLD = process.env.ISOLATED_DEVIN_HOLD === "1";
const HOLD_MS = Number.parseInt(process.env.ISOLATED_DEVIN_HOLD_MS ?? "90000", 10);
const DEVIN_BINDING = "local:isolated-devin";
const HOLD_NOTE = join("/tmp", "isolated-devin-mail-hold.json");

const sha256File = (path: string): string | undefined => {
  if (!existsSync(path)) return undefined;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
};

const runtimeProvenance = () => {
  const rendererDir = join(process.cwd(), "out", "renderer", "assets");
  const rendererIndex = existsSync(rendererDir)
    ? readdirSync(rendererDir).find((name) => /^index-.*\.js$/.test(name))
    : undefined;
  let sourceCommit = "unknown";
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* ignore */
  }
  return {
    sourceCommit,
    outMainSha256: sha256File(join(process.cwd(), "out", "main", "index.js")),
    outRendererSha256:
      rendererIndex === undefined
        ? undefined
        : sha256File(join(rendererDir, rendererIndex)),
    outRendererFile: rendererIndex,
  };
};

type ProjectedMessage = {
  readonly messageId?: string;
  readonly parts?: ReadonlyArray<{ readonly kind?: string; readonly text?: string }>;
  readonly metadata?: {
    readonly readAt?: unknown;
    readonly fromSeat?: unknown;
  };
};

const projectedMessages = async (
  page: Page,
  canvas: string,
  nodeId: string,
): Promise<ReadonlyArray<ProjectedMessage>> => {
  const doc = await page.evaluate(async (name) => {
    const read = await window.vellumCommand!.readCanvas(name);
    return read.doc;
  }, canvas);
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  const items = (
    node as {
      ether?: { messages?: { items?: ReadonlyArray<ProjectedMessage> } };
    } | undefined
  )?.ether?.messages?.items;
  return items ?? [];
};

const dismissDevinTrust = async (page: Page): Promise<void> => {
  const attached = (await page.evaluate(async (bindingId) => {
    const api = window.vellumCommand!;
    return api.terminalAttach({ bindingId, mode: "control", takeover: true });
  }, DEVIN_BINDING)) as { ok?: boolean; lease?: { leaseId?: string } };
  const leaseId = attached.lease?.leaseId;
  if (leaseId === undefined) return;
  await page.evaluate(
    async ([id]) => {
      await window.vellumCommand!.terminalWrite(id, "\r");
      await window.vellumCommand!.terminalRelease(id);
    },
    [leaseId] as const,
  );
};

const occupyDevin = async (page: Page): Promise<{ pid?: number; cwd?: string }> => {
  const occupy = () =>
    page.evaluate(
      async ([canvas, node]) => {
        await window.vellumCommand!.terminalCreate({ node, canvasName: canvas });
      },
      [ISOLATED_DEVIN_MAIL_CANVAS, isolatedDevinReceiverNode] as const,
    );
  await occupy().catch(() => undefined);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const session = await page.evaluate(
      async (bindingId) => window.vellumCommand!.terminalGet(bindingId),
      DEVIN_BINDING,
    );
    if (session?.pid !== undefined && session.pid > 0) {
      return { pid: session.pid, cwd: session.cwd };
    }
    await occupy().catch(() => undefined);
    await page.waitForTimeout(500);
  }
  throw new Error("real Devin seat never occupied");
};

test("isolated Devin [real-harness]: process-bound list stamps projected readAt", async () => {
  test.setTimeout((HOLD ? HOLD_MS : 0) + 240_000);
  if (!existsSync(operatorCred)) {
    test.skip(true, "no operator Devin credentials.toml to seed");
  }
  if (resolveOperatorDevinBinary(process.env.PATH ?? "") === undefined) {
    test.skip(true, "real devin binary not on PATH");
  }
  expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(false);
  if (HOLD) process.env.VELLUM_COMMAND_E2E_SHOW = "1";

  const provenance = runtimeProvenance();
  const vellum = await launchVellum({
    seedCanvases: { [ISOLATED_DEVIN_MAIL_CANVAS]: isolatedDevinMailDoc() },
    afterSeed: async (sandbox) => {
      const prepared = await seedIsolatedDevinAppHome(
        sandbox,
        operatorHome,
        process.env.PATH ?? "",
      );
      if (!prepared.ok) throw new Error(prepared.limitation);
      expect(prepared.seeded.copied).toContain(ISOLATED_DEVIN_CREDENTIAL_REL);
      expect(
        existsSync(join(sandbox.homeDir, ".local/share/devin/cli/sessions.db")),
      ).toBe(false);
    },
  });

  const writeHold = (extra: Record<string, unknown>) => {
    const electronMainPid = vellum.app.process().pid;
    const body = {
      electronMainPid,
      harnessPid: extra.harnessPid,
      sandboxHome: extra.sandboxHome,
      cwd: extra.cwd,
      canvas: ISOLATED_DEVIN_MAIL_CANVAS,
      window: HOLD ? "visible" : "offscreen",
      holdMs: HOLD ? HOLD_MS : 0,
      ...provenance,
      ...extra,
    };
    writeFileSync(HOLD_NOTE, `${JSON.stringify(body)}\n`);
    console.log(`ISOLATED_DEVIN_HOLD ${JSON.stringify(body)}`);
  };

  try {
    const { page, sandbox, app } = vellum;
    if (HOLD) {
      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.show();
            win.focus();
          }
        }
      });
    }
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    const sender = crewSeat(sandbox, ISOLATED_DEVIN_MAIL_CANVAS, ISOLATED_DEVIN_SENDER_ID);
    await crewOccupySeat(page, ISOLATED_DEVIN_MAIL_CANVAS, isolatedDevinSenderNode, sender);
    const occupied = await occupyDevin(page);
    writeHold({
      harnessPid: occupied.pid,
      sandboxHome: sandbox.homeDir,
      cwd: occupied.cwd,
    });
    const waitIdle = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = Math.max(1_000, deadline - Date.now());
        const idle = await sender.op(
          "seat.wait",
          { target: ISOLATED_DEVIN_RECEIVER_ID, until: "idle", timeoutMs: Math.min(15_000, remaining) },
          { timeoutMs: 20_000, awaitMs: 25_000 },
        );
        if (idle.ok) return;
        const attention = await sender.op(
          "seat.wait",
          {
            target: ISOLATED_DEVIN_RECEIVER_ID,
            until: "attention",
            timeoutMs: 3_000,
          },
          { timeoutMs: 5_000, awaitMs: 8_000 },
        );
        if (attention.ok) await dismissDevinTrust(page);
        const grid = await sender.op("seat.read", {
          target: ISOLATED_DEVIN_RECEIVER_ID,
          lines: 40,
        });
        if (grid.ok) {
          const text = String((grid.data as { text?: string } | undefined)?.text ?? "");
          if (/trust the authors|yes, trust|needs input/i.test(text)) {
            await dismissDevinTrust(page);
          }
        }
      }
      throw new Error("real Devin never reached idle");
    };
    await waitIdle(120_000);

    const nonce = `isolated-devin-mail ${String(Date.now())}`;
    const send = await sender.op("msg.send", {
      target: ISOLATED_DEVIN_RECEIVER_ID,
      text: nonce,
    });
    expect(send.ok, JSON.stringify(send)).toBe(true);
    if (!send.ok) throw new Error("unreachable");
    const messageId = (send.data as { messageId?: string } | undefined)?.messageId;
    expect(typeof messageId).toBe("string");

    await expect
      .poll(
        async () =>
          (await projectedMessages(page, ISOLATED_DEVIN_MAIL_CANVAS, ISOLATED_DEVIN_RECEIVER_ID))
            .some((item) => item.messageId === messageId),
        { timeout: 90_000 },
      )
      .toBe(true);

    expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(false);
    writeHold({
      harnessPid: occupied.pid,
      sandboxHome: sandbox.homeDir,
      cwd: occupied.cwd,
      messageId,
    });
    if (HOLD) {
      await page.waitForTimeout(HOLD_MS);
    }
  } finally {
    await vellum.close();
  }
});
