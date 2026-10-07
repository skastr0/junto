/**
 * The wire writers, driven as the operator drives them.
 *
 * Drawing a wire by drag, connecting through the connect editor, connecting a
 * selection to a target and to each other, disconnecting a selection, and
 * deleting one relation. Each is one act: main reports one change and the
 * canvas count steps by one, however many wires the act carries, and undo
 * takes the whole act back. A refused or cancelled act sends nothing.
 *
 * Everything is read from what main stores (modelOpen) and from the changes
 * main reports, never from what the window draws.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/wire-writers.spec.ts`
 */
import type { Locator, Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, test } from "../harness/launch";
import { modelFixture, modelSeat, modelWire, readModelCanvas } from "../harness/model";

const CANVAS = "wire-writers";

const seats = [
  modelSeat({ id: "a", key: "local:wire-alpha", label: "alpha", x: 0, y: 0 }),
  modelSeat({ id: "b", key: "local:wire-bravo", label: "bravo", x: 420, y: 0 }),
  modelSeat({ id: "c", key: "local:wire-charlie", label: "charlie", x: 0, y: 260 }),
  modelSeat({ id: "d", key: "local:wire-delta", label: "delta", x: 420, y: 260 }),
];

const board = (id: string, name: string, x: number): Node =>
  Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
    kind: "task", id, name, x, y: 0, width: 320, height: 220, z: 0,
  });
const boards = [board("build", "Build", 0), board("review", "Review", 520)];

const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
const redoKey = process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z";

const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);

/** Count every change main reports for this canvas from here on. */
const watchChanges = async (page: Page): Promise<void> => {
  await page.evaluate((canvas) => {
    const held = window as unknown as { wireWriterChanges: number };
    held.wireWriterChanges = 0;
    window.junto!.onModelChanged((change) => {
      if (change.canvas === canvas) held.wireWriterChanges += 1;
    });
  }, CANVAS);
};

const changeCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { wireWriterChanges: number }).wireWriterChanges);

/** The wires main holds, as "from verb to", sorted. */
const storedWires = async (page: Page): Promise<string[]> =>
  (await readModelCanvas(page, CANVAS)).wires.map((wire) => `${wire.from} ${wire.verb} ${wire.to}`).sort();

/** Do one thing and hold that main took it as exactly one act. */
const oneAct = async (page: Page, act: () => Promise<void>): Promise<void> => {
  const seq = (await readModelCanvas(page, CANVAS)).seq;
  const changes = await changeCount(page);
  await act();
  await expect.poll(async () => (await readModelCanvas(page, CANVAS)).seq).toBe(seq + 1);
  await expect.poll(() => changeCount(page)).toBe(changes + 1);
  // Nothing follows it: a second command would land within this wait.
  await page.waitForTimeout(400);
  expect((await readModelCanvas(page, CANVAS)).seq).toBe(seq + 1);
  expect(await changeCount(page)).toBe(changes + 1);
};

/** Do one thing and hold that nothing reached main. */
const noAct = async (page: Page, act: () => Promise<void>): Promise<void> => {
  const seq = (await readModelCanvas(page, CANVAS)).seq;
  const changes = await changeCount(page);
  await act();
  await page.waitForTimeout(600);
  expect((await readModelCanvas(page, CANVAS)).seq).toBe(seq);
  expect(await changeCount(page)).toBe(changes);
};

/** Answer every confirm the window raises, and keep what it asked. */
const answerConfirms = async (page: Page, answer: boolean): Promise<void> => {
  await page.evaluate((yes) => {
    const held = window as unknown as { wireWriterConfirms: string[] };
    held.wireWriterConfirms = [];
    window.confirm = (message?: string) => {
      held.wireWriterConfirms.push(message ?? "");
      return yes;
    };
  }, answer);
};

const confirmsAsked = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { wireWriterConfirms: string[] }).wireWriterConfirms);

const ready = async (page: Page, ids: ReadonlyArray<string>): Promise<void> => {
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  for (const id of ids) await expect(card(page, id)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Fit all nodes", exact: true }).click();
  await page.waitForTimeout(900);
  await watchChanges(page);
};

/** The keys act on the canvas, not on a card or a field that holds focus. */
const toCanvas = async (page: Page): Promise<void> => {
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
};

/** Drag from a seat's right handle onto the `messages` landing zone of another. */
const drawMessages = async (page: Page, from: string, to: string): Promise<void> => {
  const handle = card(page, from).locator(".junto-handle--source.junto-handle--right");
  const start = await handle.boundingBox();
  const target = await card(page, to).boundingBox();
  expect(start).toBeTruthy();
  expect(target).toBeTruthy();
  if (!start || !target) return;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 14 });
  // Two seats admit two verbs, chosen by where the wire lands.
  const zone = card(page, to).locator('[data-verb="messages"]');
  await expect(zone).toHaveCount(1);
  const landing = await zone.boundingBox();
  expect(landing).toBeTruthy();
  if (landing) await page.mouse.move(landing.x + landing.width / 2, landing.y + landing.height / 2, { steps: 6 });
  await page.mouse.up();
};

const shiftSelect = async (page: Page, ids: ReadonlyArray<string>): Promise<void> => {
  for (const id of ids) {
    await card(page, id).click({ modifiers: ["Shift"] });
    await expect(card(page, id)).toHaveClass(/selected/);
  }
};

test.describe("wires between seats", () => {
  test.use({ juntoOptions: { seedModels: { [CANVAS]: modelFixture(seats) } } });

  test("drawing a wire by drag is one act, and drawing it again is refused", async ({ junto }) => {
    const { page } = junto;
    await ready(page, ["a", "b"]);
    expect(await storedWires(page)).toEqual([]);

    await oneAct(page, () => drawMessages(page, "a", "b"));
    expect(await storedWires(page)).toEqual(["a messages b"]);
    // The new wire is selected: its relation surface is what the bar shows.
    await expect(page.getByRole("button", { name: "Delete relation" })).toBeVisible();

    await toCanvas(page);
    await noAct(page, () => drawMessages(page, "a", "b"));
    await expect(page.locator(".error-banner__message")).toHaveText("That relation already exists.");
    expect(await storedWires(page)).toEqual(["a messages b"]);

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual([]);
    await oneAct(page, () => page.keyboard.press(redoKey));
    expect(await storedWires(page)).toEqual(["a messages b"]);
  });

  test("the connect editor wires the selected seat to the one picked by search", async ({ junto }) => {
    const { page } = junto;
    await ready(page, ["c", "d"]);

    await card(page, "c").click();
    await expect(card(page, "c")).toHaveClass(/selected/);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const search = page.getByTestId("connect-pick-input");
    await expect(search).toBeVisible();
    await search.fill("delta");
    await oneAct(page, () => search.press("Enter"));
    expect(await storedWires(page)).toEqual(["c messages d"]);

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual([]);
  });

  test("connecting a selection to a target is one act for all its wires", async ({ junto }) => {
    const { page } = junto;
    await ready(page, ["a", "b", "d"]);

    await shiftSelect(page, ["a", "b"]);
    // A right-click on a card outside the selection offers the connect.
    await card(page, "d").click({ button: "right" });
    const menu = page.getByRole("toolbar", { name: "Connect", exact: true });
    await expect(menu).toBeVisible();
    await oneAct(page, () => menu.getByRole("button", { name: /^Connect all → target: 2 sources to delta$/ }).click());
    expect(await storedWires(page)).toEqual(["a messages d", "b messages d"]);

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual([]);
    await oneAct(page, () => page.keyboard.press(redoKey));
    expect(await storedWires(page)).toEqual(["a messages d", "b messages d"]);
  });

  test("connecting and disconnecting a selection, and deleting one relation, are one act each", async ({ junto }) => {
    const { page } = junto;
    await ready(page, ["a", "b", "c"]);
    await answerConfirms(page, true);

    // Connect three seats to each other: three wires, one act.
    await shiftSelect(page, ["a", "b", "c"]);
    await card(page, "a").click({ button: "right" });
    await oneAct(page, () => page.getByRole("button", { name: "Connect 3 agents to each other", exact: true }).click());
    const mesh = await storedWires(page);
    expect(mesh).toHaveLength(3);
    expect(new Set(mesh.map((wire) => wire.split(" ")[1]))).toEqual(new Set(["messages"]));

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual([]);
    await oneAct(page, () => page.keyboard.press(redoKey));
    expect(await storedWires(page)).toEqual(mesh);

    // Disconnect them: the operator is asked once, then one act removes all three.
    await shiftSelect(page, ["a", "b", "c"]);
    await card(page, "a").click({ button: "right" });
    await oneAct(page, () => page.getByRole("button", { name: "Disconnect 3 edges between 3 agents", exact: true }).click());
    expect(await storedWires(page)).toEqual([]);
    expect(await confirmsAsked(page)).toEqual(["Delete 3 relations?"]);

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual(mesh);

    // Delete one relation from its surface.
    await answerConfirms(page, true);
    await page.getByRole("button", { name: /^Select edge -/ }).first().press("Enter");
    const remove = page.getByRole("button", { name: "Delete relation" });
    await expect(remove).toBeVisible();
    await oneAct(page, () => remove.click());
    expect(await storedWires(page)).toHaveLength(2);
    expect(await confirmsAsked(page)).toEqual(["Delete this relation?"]);

    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual(mesh);
  });
});

test.describe("a task path between two boards", () => {
  test.use({
    juntoOptions: {
      seedModels: { [CANVAS]: modelFixture(boards, [modelWire("path", "build", "review", "feeds", boards)]) },
    },
  });

  test("removing the path says what it does to the task on its way, and cancel sends nothing", async ({ junto }) => {
    const { page } = junto;
    await ready(page, ["build", "review"]);
    const made = await page.evaluate(
      (canvas) => window.junto!.workTaskCreate(canvas, "build", "Ship the wire spec", { title: "Ship the wire spec", details: "" }),
      CANVAS,
    );
    expect(made.ok).toBe(true);

    await page.getByRole("button", { name: /^Select edge -/ }).first().press("Enter");
    const remove = page.getByRole("button", { name: "Delete relation" });
    await expect(remove).toBeVisible();

    // The operator reads the warning and says no.
    await answerConfirms(page, false);
    await noAct(page, () => remove.click());
    expect(await confirmsAsked(page)).toEqual([
      "Delete this relation? “Build” has 1 live task that will lose “Review” as its Next board. This removes “Build”’s last Next board, so tasks will complete here.",
    ]);
    expect(await storedWires(page)).toEqual(["build feeds review"]);

    // Asked again, the operator says yes: one act, and undo puts the path back.
    await answerConfirms(page, true);
    await oneAct(page, () => remove.click());
    expect(await storedWires(page)).toEqual([]);
    await toCanvas(page);
    await oneAct(page, () => page.keyboard.press(undoKey));
    expect(await storedWires(page)).toEqual(["build feeds review"]);
  });
});
