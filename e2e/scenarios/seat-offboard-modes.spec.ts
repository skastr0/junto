/**
 * Offboard from the seat — asking the agent, in the running product.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard-modes.spec.ts
 *
 * What this proves that a unit test cannot: the popup above a real seat's
 * card offers Ask to offboard and Ask, then rest, a click travels renderer
 * -> IPC -> the ordinary mail path into the seat's mailbox with the offboard
 * prompt for that mode, and the seat's Sessions tab shows the offboard as
 * asked (and no longer holds the buttons). The notes are the agent's to
 * write, so the prompt carries the command, never notes.
 *
 * The seats are seeded cold (no harness spawns): the canvas starts paused, so
 * the mail waits in the mailbox, which is what the assertions read.
 */
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const RESTER = "e2e-offboard-rest";
const CONTINUER = "e2e-offboard-continue";
const SHOTS = join(process.cwd(), "test-results", "seat-offboard-modes");

test.use({
  juntoOptions: {
    seedCanvases: {
      offboard: canvasDoc([
        agentTextNode({ id: RESTER, key: "e2e-offboard-rest-binding", label: "Rester", harness: "claude", x: 80, y: 40 }),
        agentTextNode({
          id: CONTINUER,
          key: "e2e-offboard-continue-binding",
          label: "Continuer",
          harness: "claude",
          x: 460,
          y: 40,
        }),
      ]),
    },
  },
});

type MailRow = { readonly parts_json: string; readonly metadata_json: string | null };

/** Mail durably queued on one seat, read from the sandbox delivery table. */
const mailboxOf = (appHome: string, nodeId: string): readonly string[] => {
  const db = new DatabaseSync(join(appHome, ".junto", "state", "junto.db"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT parts_json, metadata_json FROM work_messages WHERE node_id = ? ORDER BY position")
      .all(nodeId) as unknown as readonly MailRow[];
    return rows.map((row) =>
      (JSON.parse(row.parts_json) as ReadonlyArray<{ readonly text?: string }>).map((part) => part.text ?? "").join("\n"),
    );
  } catch {
    return [];
  } finally {
    db.close();
  }
};

/** Open the offboard popup from the toolbar above the seat's card. */
const openOffboard = async (page: Page, seatId: string, name: string) => {
  const seat = page.locator(`.react-flow__node[data-id="${seatId}"]`);
  await expect(seat).toBeVisible({ timeout: 60_000 });
  await seat.click();
  await page.getByTestId("seat-offboard-open").click();
  const panel = page.getByRole("dialog", { name: `Offboard ${name}` });
  await expect(panel).toBeVisible({ timeout: 10_000 });
  return panel;
};

/** Open the seat's Customize editor on its Sessions tab. */
const openSessions = async (page: Page, seatId: string) => {
  const seat = page.locator(`.react-flow__node[data-id="${seatId}"]`);
  await seat.click();
  await page.getByTestId("toolbar-customize-agent").click();
  const editor = page.getByTestId("agent-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.getByRole("tab", { name: "sessions" }).click();
  await expect(editor.getByTestId("seat-offboard")).toBeVisible();
  return editor;
};

test("the seat popup's Ask to offboard and Ask, then rest send the agent the prompt for that mode", async ({ junto }) => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const { page, sandbox } = junto;
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Ask, then rest: the prompt for a plain offboard, and the popup says it asked.
  const rest = await openOffboard(page, RESTER, "Rester");
  await expect(rest.getByRole("button", { name: "Ask to offboard", exact: true })).toBeEnabled();
  await expect(rest.getByRole("button", { name: "Ask, then rest" })).toBeEnabled();
  await expect(rest.getByTestId("seat-offboard-now")).toBeVisible();
  await rest.screenshot({ path: join(SHOTS, "offboard-popup.png") });
  expect(mailboxOf(sandbox.homeDir, RESTER)).toHaveLength(0);

  await rest.getByTestId("seat-offboard-ask-rest").click();
  await expect(rest.getByTestId("seat-offboard-status")).toHaveText("Asked to offboard and rest.", { timeout: 20_000 });
  await rest.screenshot({ path: join(SHOTS, "offboard-asked.png") });

  await expect.poll(() => mailboxOf(sandbox.homeDir, RESTER).length, { timeout: 20_000 }).toBe(1);
  const [restMail] = mailboxOf(sandbox.homeDir, RESTER);
  expect(restMail).toContain("The operator asks you to offboard this session.");
  expect(restMail).toContain('junto offboard "<notes>"');
  expect(restMail).not.toContain("--continue");
  expect(restMail).toContain("The seat then rests");
  expect(restMail).not.toContain("·");
  await page.keyboard.press("Escape");
  await expect(rest).toBeHidden({ timeout: 5_000 });

  // The Sessions tab follows the offboard, and starts none itself.
  const sessions = await openSessions(page, RESTER);
  const restProgress = sessions.getByTestId("seat-offboard-progress");
  await expect(restProgress).toHaveAttribute("data-stage", "asked", { timeout: 20_000 });
  await expect(restProgress).toHaveAttribute("data-mode", "rest");
  await expect(restProgress).toContainText("Asked");
  await expect(restProgress).toContainText("Notes saved");
  await expect(restProgress).toContainText("Session closed, seat resting");
  await expect(sessions.getByTestId("seat-offboard").getByRole("button")).toHaveCount(0);
  await sessions.screenshot({ path: join(SHOTS, "sessions-tab.png") });
  await page.keyboard.press("Escape");
  await expect(sessions).toBeHidden({ timeout: 5_000 });

  // Ask to offboard: the prompt names --continue and the fresh session.
  const cont = await openOffboard(page, CONTINUER, "Continuer");
  await cont.getByTestId("seat-offboard-ask-continue").click();
  await expect(cont.getByTestId("seat-offboard-status")).toHaveText("Asked to offboard and continue.", { timeout: 20_000 });
  await cont.screenshot({ path: join(SHOTS, "offboard-continue-asked.png") });

  await expect.poll(() => mailboxOf(sandbox.homeDir, CONTINUER).length, { timeout: 20_000 }).toBe(1);
  const [contMail] = mailboxOf(sandbox.homeDir, CONTINUER);
  expect(contMail).toContain("The operator asks you to offboard and continue in a fresh session.");
  expect(contMail).toContain('junto offboard "<notes>" --continue "<note for your next session>"');
  expect(contMail).toContain("reads your continuation first");
  expect(contMail).not.toContain("·");

  // Each seat got only its own prompt.
  expect(mailboxOf(sandbox.homeDir, RESTER)).toHaveLength(1);
});
