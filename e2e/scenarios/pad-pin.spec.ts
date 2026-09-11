/**
 * Pad pin e2e: mention a wired seat, look-here returns a crop,
 * an unwired mention is refused. No real harnesses.
 */
import type { WorkOpResult } from "../../src/shared/ipc";
import type { Pad, PadPatch } from "../../src/shared/pad";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "pad-pin";
const PAD_ID = "pad-1";

const padNode = {
  id: PAD_ID,
  type: "text" as const,
  text: "pad",
  x: 320,
  y: 40,
  width: 240,
  height: 120,
  ether: { entity: { kind: "pad" as const } },
};

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc(
        [
          agentTextNode({
            id: "seat",
            key: "local:pad-pin-seat",
            label: "seat",
            x: 40,
            y: 40,
          }),
          agentTextNode({
            id: "stranger",
            key: "local:pad-pin-stranger",
            label: "stranger",
            x: 40,
            y: 200,
          }),
          padNode,
        ],
        [{ id: "e-seat-pad", fromNode: "seat", toNode: PAD_ID }],
      ),
    },
  },
});

type PadBody = {
  readonly revision: number;
  readonly pad: Pad;
  readonly digest: string;
  readonly lookHere?: {
    readonly bounds: { readonly w: number; readonly h: number };
    readonly digest: string;
    readonly svg: string;
  };
};

const waitForApi = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = window.vellumCommand;
          return (
            typeof api?.workPadRead === "function" &&
            typeof api.workPadPatch === "function"
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const readPad = (page: import("@playwright/test").Page, pinId?: string) =>
  page.evaluate(
    ([canvas, id, pin]) => window.vellumCommand!.workPadRead(canvas, id, pin),
    [CANVAS, PAD_ID, pinId] as const,
  );

const patchPad = (
  page: import("@playwright/test").Page,
  patches: ReadonlyArray<PadPatch>,
): Promise<WorkOpResult<PadBody>> =>
  page.evaluate(
    ([canvas, id, next]) => window.vellumCommand!.workPadPatch(canvas, id, next),
    [CANVAS, PAD_ID, patches] as const,
  );

test("pad pin: wired mention look-here crop; unwired mention refused", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 15_000 });

  const pinId = "look-here-pin" as Pad["pins"][number]["id"];
  const pinned = await patchPad(page, [
    {
      op: "pin.upsert",
      pin: {
        id: pinId,
        x: 40,
        y: 40,
        bounds: { w: 80, h: 60 },
        mentions: ["seat"],
      },
    },
  ]);
  expect(pinned.ok).toBe(true);
  if (!pinned.ok) return;
  expect(pinned.data.pad.pins).toHaveLength(1);
  expect(pinned.data.pad.pins[0]?.mentions).toEqual(["seat"]);

  const focused = await readPad(page, pinId);
  expect(focused.ok).toBe(true);
  if (!focused.ok) return;
  expect(focused.data.lookHere?.digest).toMatch(/look-here/);
  expect(focused.data.lookHere?.svg).toMatch(/<svg/i);
  expect(focused.data.lookHere?.bounds.w).toBeGreaterThan(0);
  expect(focused.data.lookHere?.bounds.h).toBeGreaterThan(0);

  const before = await readPad(page);
  expect(before.ok).toBe(true);
  if (!before.ok) return;

  const unwired = await patchPad(page, [
    {
      op: "pin.upsert",
      pin: {
        id: "ghost-pin" as Pad["pins"][number]["id"],
        x: 8,
        y: 8,
        mentions: ["stranger"],
      },
    },
  ]);
  expect(unwired.ok).toBe(false);
  if (unwired.ok) return;
  expect(unwired.code).toBe("invalid");
  expect(unwired.message).toMatch(/mention/i);

  const after = await readPad(page);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.data.pad.pins.map((pin) => pin.id)).toEqual([pinId]);
  expect(after.data.pad.pins[0]?.mentions).toEqual(["seat"]);
});

test("pad pin: draft survives Escape, mention picks by click, replies arrive live", async ({
  vellumCommand,
}) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 15_000 });

  const pinId = "thread-pin" as Pad["pins"][number]["id"];
  const seeded = await patchPad(page, [
    {
      op: "pin.upsert",
      pin: { id: pinId, x: 60, y: 60, mentions: ["seat"] },
    },
    {
      op: "pin.reply",
      pinId,
      post: {
        postId: "seed-post" as Pad["pins"][number]["posts"][number]["postId"],
        author: { kind: "operator", label: "operator" },
        parts: [{ kind: "text", text: "seed reply" }],
      },
    },
  ]);
  expect(seeded.ok).toBe(true);
  if (!seeded.ok) return;

  await page.locator(".react-flow__node").filter({ has: page.getByTestId("pad-card") }).dblclick();
  await expect(page.getByTestId("pad-detail")).toBeVisible({ timeout: 15_000 });

  // Select the pin to open its thread.
  await page.getByTestId("pad-pin").click();
  const replyBox = page.getByTestId("pad-pin-reply");
  await expect(replyBox).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pad-pin-thread")).toContainText("seed reply");

  // Mention menu opens on @, and an option activates on click (mouse users
  // must not lose the textarea focus or the draft).
  await replyBox.fill("draft ");
  await page.keyboard.type("@s");
  await expect(page.getByTestId("pad-mention-list")).toBeVisible();
  await page.locator('[data-testid="pad-mention-option"][data-node-id="seat"]').click();
  // The pick inserts the actor's name (the seeded key) and a trailing space.
  await expect(replyBox).toHaveValue("draft @local:pad-pin-seat ");

  // Escape dismisses the menu and never destroys the draft.
  await page.keyboard.type("hello @s");
  await expect(page.getByTestId("pad-mention-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pad-mention-list")).toHaveCount(0);
  await expect(replyBox).toHaveValue("draft @local:pad-pin-seat hello @s");

  // Post the reply (⌘ Enter), then an external write — what a wired agent
  // would do — surfaces in the open thread without closing the pad.
  await page.keyboard.press("Meta+Enter");
  await expect
    .poll(async () => {
      const read = await readPad(page);
      return read.ok
        ? (read.data.pad.pins.find((pin) => pin.id === "thread-pin")?.posts.length ?? 0)
        : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);

  const agentReply = await patchPad(page, [
    {
      op: "pin.reply",
      pinId,
      post: {
        postId: "agent-live-post" as Pad["pins"][number]["posts"][number]["postId"],
        author: { kind: "operator", label: "operator" },
        parts: [{ kind: "text", text: "agent live reply" }],
      },
    },
  ]);
  expect(agentReply.ok).toBe(true);
  if (!agentReply.ok) return;
  await expect(
    page.getByTestId("pad-pin-thread").getByText("agent live reply"),
  ).toBeVisible({ timeout: 15_000 });
});

