/**
 * Message a seat from the canvas [fake-tui]: the seat toolbar's message
 * button, and the selection menu's "message" row for many seats at once.
 *   bun run test:e2e:fast e2e/scenarios/seat-message.spec.ts
 *
 * The composer sends operator prompt mail on the one delivery path all mail
 * takes, so a seat that is down is started by the message and gets it once it
 * is up. Evidence: the composer's own line (sent or queued), the fake seat
 * registering (it was started), the delivery receipt on its mailbox, and the
 * bytes on the seat's input. Also: the seat name's tooltip no longer covers
 * the toolbar above it.
 *
 * Seats are fake-tui: a planted `codex` that paints the real screens.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import { expect, launchJunto, test } from "../harness/launch";
import {
  crewDoc,
  crewOccupySeat,
  crewPlayFactory,
  crewReceipts,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type CrewSeat,
} from "../harness/crew-fixture";

const CANVAS = "seat-message";
const SHOTS = join(process.cwd(), "test-results", "seat-message");
const A = "seat-a";
const B = "seat-b";
const seatA = crewSeatNode({ id: A, label: "Ada", x: 120, y: 220 });
const seatB = crewSeatNode({ id: B, label: "Bo", x: 480, y: 220 });

const launch = () =>
  launchJunto({
    seedCanvases: { [CANVAS]: crewDoc([seatA, seatB]) },
    afterSeed: installCrewSeatHarness,
  });

/** A seat that was never opened: its fake has not registered. */
const asleep = (seat: CrewSeat): boolean => !existsSync(join(seat.dir, "ready.json"));

const seatState = async (page: Page, bindingId: string): Promise<string | undefined> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingId)?.state;
};

/** The seat took the text: a receipt on its mailbox and the words on its input. */
const received = async (page: Page, nodeId: string, seat: CrewSeat, text: string): Promise<void> => {
  await expect
    .poll(async () => (await crewReceipts(page, CANVAS, nodeId)).some((row) => row.deliveredAt !== undefined), {
      timeout: 60_000,
    })
    .toBe(true);
  await expect.poll(async () => (await seat.stdinLog()).includes(text), { timeout: 15_000 }).toBe(true);
  expect(await seat.stdinLog()).toContain("mail from operator");
};

test("[fake-tui] the seat toolbar messages a sleeping seat, which wakes and receives", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launch();
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const ada = crewSeat(sandbox, CANVAS, A);
    expect(asleep(ada)).toBe(true);

    const card = page.locator(`.react-flow__node[data-id="${A}"]`);
    await card.click();
    const open = page.getByTestId("seat-message-open");
    await expect(open).toBeVisible();

    // The name's tooltip goes below the seat, clear of the toolbar above it.
    await card.getByText("Ada", { exact: true }).first().hover();
    const tip = page.locator(".junto-tooltip[data-positioned='true']");
    await expect(tip).toHaveText("Ada");
    const tipBox = (await tip.boundingBox())!;
    const barBox = (await page.locator(".react-flow__node-toolbar").first().boundingBox())!;
    expect(tipBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
    await page.screenshot({ path: join(SHOTS, "name-tooltip-clear-of-toolbar.png") });

    await open.click();
    const composer = page.getByRole("dialog", { name: "Message Ada" });
    await expect(composer).toBeVisible();
    const field = composer.getByTestId("seat-message-field");
    await expect(field).toBeFocused();

    // Nothing covers the composer: the open button shows no tip (hovering it
    // again, even onto its icon), and the composer sits centred on the
    // button, above the toolbar, clear of it.
    await open.hover({ position: { x: 3, y: 3 } });
    await open.locator("svg").hover();
    await page.waitForTimeout(150);
    await expect(page.locator(".junto-tooltip")).toHaveCount(0);
    const openBox = (await open.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    const toolbarBox = (await page.locator(".react-flow__node-toolbar").first().boundingBox())!;
    expect(Math.abs(composerBox.x + composerBox.width / 2 - (openBox.x + openBox.width / 2))).toBeLessThan(2);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(toolbarBox.y);

    const text = "Please rerun the migration check and post the result";
    await field.fill(text);
    await field.press("Enter");
    const status = composer.getByTestId("seat-message-status");
    await expect(status).toHaveText("Queued. Ada gets it as soon as it is up.");
    await expect(status).toHaveAttribute("data-tone", "queued");
    // Sent text clears; focus stays for the next message.
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await page.screenshot({ path: join(SHOTS, "seat-message-queued.png") });

    // The message started the seat, and the seat got it.
    await ada.ready(60_000);
    await received(page, A, ada, text);

    // Once the seat is up the next one goes straight in, even mid-turn (the
    // fake seat is working on the first one).
    await expect.poll(() => seatState(page, `local:${A}`), { timeout: 30_000 }).toMatch(/^(idle|working)$/u);
    await field.fill("And tag me when it is green");
    await field.press("Enter");
    await expect(status).toHaveText("Sent to Ada.");
    await expect(status).toHaveAttribute("data-tone", "sent");
    await expect.poll(async () => (await ada.stdinLog()).includes("And tag me when it is green"), { timeout: 15_000 }).toBe(true);
    // The pointer is back on the button that opened it: still no tip, and
    // nothing from outside the composer lies over its Send button. (A
    // disabled button takes no pointer, so the hit lands on the composer.)
    await open.hover();
    await page.waitForTimeout(150);
    await expect(page.locator(".junto-tooltip")).toHaveCount(0);
    const sendBox = (await composer.getByRole("button", { name: "Send" }).boundingBox())!;
    const onTop = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest("[role='dialog']")?.getAttribute("aria-label") ?? "",
      [sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2] as const,
    );
    expect(onTop).toBe("Message Ada");
    await page.screenshot({ path: join(SHOTS, "seat-message-sent.png") });

    // Shift+Enter is a new line, not a send.
    await field.press("Shift+Enter");
    await expect(status).toHaveText("Sent to Ada.");

    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
  } finally {
    await junto.close();
  }
});

test("[fake-tui] the selection menu sends one message to every selected seat", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launch();
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const ada = crewSeat(sandbox, CANVAS, A);
    const bo = crewSeat(sandbox, CANVAS, B);
    // Ada is up and idle; Bo is asleep.
    await crewOccupySeat(page, CANVAS, seatA, ada);
    await expect.poll(() => seatState(page, `local:${A}`), { timeout: 30_000 }).toBe("idle");
    expect(asleep(bo)).toBe(true);

    await page.locator(`.react-flow__node[data-id="${A}"]`).click();
    await page.locator(`.react-flow__node[data-id="${B}"]`).click({ modifiers: ["Shift"] });
    await page.locator(`.react-flow__node[data-id="${B}"]`).click({ button: "right" });
    const menu = page.getByRole("toolbar", { name: "Actions for 2 nodes" });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Message 2 agents" }).click();

    const composer = page.getByRole("dialog", { name: "Message 2 agents" });
    await expect(composer).toBeVisible();
    const field = composer.getByTestId("seat-message-field");
    await expect(field).toBeFocused();
    const text = "Stand up: one line on what you are doing";
    await field.fill(text);
    await field.press("Enter");
    const status = composer.getByTestId("seat-message-status");
    await expect(status).toHaveText("Sent to 1 agent. Queued for Bo, who gets it as soon as it is up.");
    await expect(field).toHaveValue("");
    await page.screenshot({ path: join(SHOTS, "selection-message.png") });

    await received(page, A, ada, text);
    await bo.ready(60_000);
    await received(page, B, bo, text);

    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
  } finally {
    await junto.close();
  }
});
