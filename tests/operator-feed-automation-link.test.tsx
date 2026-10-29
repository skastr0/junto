// @vitest-environment jsdom
/**
 * The feed card of an automation's signal opens the run that raised it
 * (0.11.1): the Automations node with that firing marked in its history, never
 * a seat's signals section. A signal that names no firing still opens the
 * automation, and a seat's own signal keeps the seat's behaviour.
 */
import { expect, it, vi } from "vitest";
import type { Node } from "../src/shared/model";
import type { FeedItem } from "../src/shared/operator-feed";
import { automations } from "./support/model-nodes";

const calls = vi.hoisted(() => ({
  opened: [] as Array<{ nodeId: string; options: unknown }>,
  revealed: [] as Array<{ nodeId: string; section: string }>,
  activated: [] as string[],
  closed: 0,
}));

vi.mock("../src/renderer/lib/operator-modal", () => ({ closeOperatorModal: () => (calls.closed += 1) }));
vi.mock("../src/renderer/lib/work-detail-open", () => ({
  openWorkDetail: (nodeId: string, options: unknown) => calls.opened.push({ nodeId, options }),
}));
vi.mock("../src/renderer/lib/activate-node-surface", () => ({
  activateNodeSurface: (nodeId: string) => calls.activated.push(nodeId),
}));
vi.mock("../src/renderer/lib/sidebar-sections", () => ({
  requestSectionReveal: (nodeId: string, section: string) => calls.revealed.push({ nodeId, section }),
}));
vi.mock("../src/renderer/lib/agent-signals-view", () => ({ SIGNALS_SECTION: "signals" }));

const { openSeat } = await import("../src/renderer/components/feed/OperatorFeed");

const item = (over: Partial<FeedItem>): FeedItem =>
  ({
    itemId: "signal:s1",
    kind: "work",
    text: "Write 500 words",
    urgency: 6,
    canvasName: "factory",
    seat: { nodeId: "auto", name: "Daily writing", portraitIdentity: "auto" },
    region: { regionId: null, label: "open field", path: [] },
    signalId: "s1",
    ...over,
  }) as FeedItem;

const node = automations("auto", { label: "Daily writing" }) as Node;
const reset = (): void => {
  calls.opened.length = 0;
  calls.revealed.length = 0;
  calls.activated.length = 0;
  calls.closed = 0;
};

it("opens the run an automation's signal names, with the automation beside it", () => {
  reset();
  openSeat(
    item({
      source: { kind: "automation", automationId: "01M62Q58WDSXMG4YBXNKR2RB91", nodeId: "auto", firingId: "01M62Q58WDSXMG4YBXNKR2RB92" },
    }),
    node,
  );
  expect(calls.opened).toEqual([
    {
      nodeId: "auto",
      options: { automationId: "01M62Q58WDSXMG4YBXNKR2RB91", firingId: "01M62Q58WDSXMG4YBXNKR2RB92" },
    },
  ]);
  expect(calls.activated).toEqual(["auto"]);
  expect(calls.revealed).toEqual([]);
  expect(calls.closed).toBe(1);
});

it("opens the automation alone when the signal names no firing", () => {
  reset();
  openSeat(item({ source: { kind: "automation", automationId: "01M62Q58WDSXMG4YBXNKR2RB91", nodeId: "auto" } }), node);
  expect(calls.opened).toEqual([{ nodeId: "auto", options: { automationId: "01M62Q58WDSXMG4YBXNKR2RB91" } }]);
});

it("keeps a seat's own signal on the seat's signals section", () => {
  reset();
  openSeat(item({ seat: { nodeId: "agent", name: "builder", portraitIdentity: "agent" } }), {
    ...node,
    id: "agent",
    kind: "agent",
  } as unknown as Node);
  expect(calls.opened).toEqual([]);
  expect(calls.revealed).toEqual([{ nodeId: "agent", section: "signals" }]);
  expect(calls.activated).toEqual(["agent"]);
});
