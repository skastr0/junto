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
