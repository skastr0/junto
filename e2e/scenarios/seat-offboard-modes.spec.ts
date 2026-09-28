/**
 * Offboard from the seat — the operator's two actions, in the running product.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard-modes.spec.ts
 *
 * What this proves that a unit test cannot: the Sessions tab of a real seat
 * renders Offboard and Offboard and continue, a click travels renderer -> IPC
 * -> the ordinary mail path into the seat's mailbox with the offboard prompt
 * for that mode, and the tab shows the offboard as asked. The notes are the
 * agent's to write, so the prompt carries the command, never notes.
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

/** Open the seat's Customize editor on its Sessions tab. */
const openSessions = async (page: Page, seatId: string) => {
  const seat = page.locator(`.react-flow__node[data-id="${seatId}"]`);
  await expect(seat).toBeVisible({ timeout: 60_000 });
  await seat.click();
  await page.getByTestId("toolbar-customize-agent").click();
  const editor = page.getByTestId("agent-editor");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.getByRole("tab", { name: "sessions" }).click();
  await expect(editor.getByTestId("seat-offboard")).toBeVisible();
  return editor;
};

test("the seat's Offboard and Offboard and continue send the agent the prompt for that mode", async ({ junto }) => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const { page, sandbox } = junto;
  await page.setViewportSize({ width: 1440, height: 1100 });

  // Offboard: the prompt for a plain offboard, and the seat shows it asked.
  const rest = await openSessions(page, RESTER);
  await expect(rest.getByRole("button", { name: "Offboard", exact: true })).toBeEnabled();
  await expect(rest.getByRole("button", { name: "Offboard and continue" })).toBeEnabled();
  await rest.screenshot({ path: join(SHOTS, "sessions-tab.png") });
  expect(mailboxOf(sandbox.homeDir, RESTER)).toHaveLength(0);

  await rest.getByTestId("seat-offboard-rest").click();
  const restProgress = rest.getByTestId("seat-offboard-progress");
  await expect(restProgress).toHaveAttribute("data-stage", "asked", { timeout: 20_000 });
  await expect(restProgress).toHaveAttribute("data-mode", "rest");
  await expect(restProgress).toContainText("Asked");
  await expect(restProgress).toContainText("Notes saved");
  await expect(restProgress).toContainText("Session closed, seat resting");
  // Until the agent saves its notes the operator may ask again, or switch mode.
  await expect(rest.getByTestId("seat-offboard-rest")).toBeEnabled();
  await expect(rest.getByTestId("seat-offboard-continue")).toBeEnabled();
  await rest.screenshot({ path: join(SHOTS, "offboard-asked.png") });

  await expect.poll(() => mailboxOf(sandbox.homeDir, RESTER).length, { timeout: 20_000 }).toBe(1);
  const [restMail] = mailboxOf(sandbox.homeDir, RESTER);
  expect(restMail).toContain("The operator asks you to offboard this session.");
  expect(restMail).toContain('junto offboard "<notes>"');
  expect(restMail).not.toContain("--continue");
  expect(restMail).toContain("the seat rests");
  expect(restMail).not.toContain("·");
  await page.keyboard.press("Escape");
  await expect(rest).toBeHidden({ timeout: 5_000 });

  // Offboard and continue: the prompt names --continue and the fresh session.
  const cont = await openSessions(page, CONTINUER);
  await cont.getByTestId("seat-offboard-continue").click();
  const contProgress = cont.getByTestId("seat-offboard-progress");
  await expect(contProgress).toHaveAttribute("data-stage", "asked", { timeout: 20_000 });
  await expect(contProgress).toHaveAttribute("data-mode", "continue");
  await expect(contProgress).toContainText("New session started");
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
