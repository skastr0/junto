// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { CanvasChrome } from "../src/renderer/components/CanvasChrome";
import { FocusSwitcherHud } from "../src/renderer/components/FocusSwitcherHud";
import { CommandGroupChip } from "../src/renderer/components/command-groups/CommandGroupChip";
import { FeedCard } from "../src/renderer/components/feed/OperatorFeed";
import type { FeedItem } from "../src/shared/operator-feed";
import { focusSwitcher$ } from "../src/renderer/lib/focus-switcher";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { note, region, seat } from "./support/model-nodes";

// The always-mounted chrome reads the node store. Each case mounts the real
// component with the window document empty, so a read of it would show nothing.

const canvas = "chrome-native-reads";
let root: Root;
let host: HTMLDivElement;
let release: () => void = () => undefined;
const oldCanvas = state$.canvasName.peek();
const oldDoc = state$.doc.peek();

const hold = (nodes: Parameters<typeof modelStore.adopt>[0]["nodes"]): void => {
  release();
  release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, nodes: nodes.map((node, z) => ({ ...node, z })), wires: [] });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  // A seat ring draws its portrait on a canvas, which jsdom does not have.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  state$.canvasName.set(canvas);
  state$.doc.set({ nodes: [], edges: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => focusSwitcher$.session.set(null));
  act(() => root.unmount());
  host.remove();
  release();
  release = () => undefined;
  state$.canvasName.set(oldCanvas);
  state$.doc.set(oldDoc);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("the empty-canvas hint counts cards in the store, and a region is not a card", async () => {
  hold([region("r", { x: 0, y: 0, width: 400, height: 300 })]);
  await act(async () => root.render(<CanvasChrome />));
  expect(host.querySelector(".field-empty")).not.toBeNull();

  await act(async () => hold([region("r", { x: 0, y: 0, width: 400, height: 300 }), note("n", "A note")]));
  expect(host.querySelector(".field-empty")).toBeNull();
});

it("the agent switcher draws each seat from the store, with the region it sits in", async () => {
  hold([
    region("team", { x: 0, y: 0, width: 800, height: 600 }, { label: "Team" as never }),
    seat("scout", { label: "Scout" as never, x: 40, y: 40, width: 240, height: 96 }),
    seat("far", { label: "Far" as never, x: 4000, y: 4000, width: 240, height: 96 }),
  ]);
  await act(async () => root.render(<FocusSwitcherHud />));
  await act(async () =>
    focusSwitcher$.session.set({
      selectedIndex: 0,
      entries: [
        { nodeId: "scout", title: "Scout", current: false, hotbarSlot: null },
        { nodeId: "far", title: "Far", current: false, hotbarSlot: null },
        // Deleted while the switcher was up: nothing is drawn for it.
        { nodeId: "gone", title: "Gone", current: false, hotbarSlot: null },
      ],
    }),
  );
  const cards = [...document.querySelectorAll<HTMLElement>(".focus-switcher__card")];
  expect(cards.map((card) => card.dataset.nodeId)).toEqual(["scout", "far"]);
  expect(cards[0]!.querySelector(".focus-switcher__title")?.textContent).toBe("Scout");
  expect(cards[0]!.querySelector(".focus-switcher__region")?.textContent).toContain("Team");
  expect(cards[1]!.querySelector(".focus-switcher__region")).toBeNull();
});

const feedItem = (nodeId: string, name: string): FeedItem => ({
  itemId: `item-${nodeId}`,
  kind: "blocked",
  urgency: 3,
  canvasName: canvas,
  seat: { nodeId, name, portraitIdentity: nodeId, harness: "claude" },
  region: { regionId: null, label: "open field", path: [] },
  text: "Needs a decision.",
  since: 0,
  ageMs: 0,
});
const NO_OP = (): void => undefined;
const card = (item: FeedItem, node: Parameters<typeof FeedCard>[0]["node"]) => (
  <FeedCard
    item={item}
    node={node}
    nowMs={0}
    quickReplies={[]}
    selected={false}
    reveal={false}
    leaving={false}
    replying={false}
    expanded={false}
    sending={null}
    error={null}
    onSelect={NO_OP}
    onReply={NO_OP}
    onQuickReply={NO_OP}
    onToggleDetail={NO_OP}
  />
);

it("a feed card draws a seat's ring or a card's kind mark from the store's node", async () => {
  const scout = seat("scout", { label: "Scout" as never });
  const jot = note("jot", "A note");
  await act(async () =>
    root.render(
      <>
        {card(feedItem("scout", "Scout"), scout)}
        {card(feedItem("jot", "A note"), jot)}
      </>,
    ),
  );
  const cards = [...host.querySelectorAll<HTMLElement>(".operator-feed__portrait")];
  expect(cards).toHaveLength(2);
  // The seat's card offers its seat; the note's card shows a kind mark and offers the card.
  expect(cards[0]!.querySelector(".operator-feed__node-mark")).toBeNull();
  expect(cards[1]!.querySelector(".operator-feed__node-mark")).not.toBeNull();
  expect(host.querySelector('[aria-label="Open seat Scout"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Open A note"]')).not.toBeNull();
});

it("a hotbar chip draws each member's face from that member's own node in the store", async () => {
  hold([seat("scout", { label: "Scout" as never }), note("jot", "A note")]);
  await act(async () =>
    root.render(
      <CommandGroupChip hotkey={1} testId="chip" tenure="group" memberIds={["scout", "jot", "gone"]} tone={undefined} selected={false} />,
    ),
  );
  // A seat's face and a card's kind mark; a member the canvas no longer holds draws none.
  expect(host.querySelectorAll(".group-chip__face")).toHaveLength(2);
  expect(host.querySelectorAll(".group-chip__mark")).toHaveLength(1);
});
