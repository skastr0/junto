// @vitest-environment jsdom
/**
 * A task a seat names in a card's sentence (0.11.4, task 378): "#42" becomes
 * the standard chip, and pressing it opens task 42. A canvas without that
 * number, or a card given no tasks at all (the kit, the tour), keeps every
 * word as it was.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { feedItemRank, type FeedItem } from "../src/shared/operator-feed";
import { FeedCardView } from "../src/renderer/components/feed/FeedCardView";
import type { FeedTaskRef } from "../src/renderer/components/feed/feed-text";

const NOW = 10_000_000;

const ITEM: FeedItem = {
  itemId: "signal:a",
  kind: "feedback",
  urgency: feedItemRank("feedback"),
  canvasName: "factory",
  seat: { nodeId: "seat-atlas", name: "atlas", portraitIdentity: "seat-atlas" },
  region: { regionId: null, label: "open field", path: [] },
  text: "#42 asks the release name, and the rest is done",
  since: NOW - 60_000,
  signalId: "a",
  signalKind: "feedback",
};

const TASK: FeedTaskRef = { nodeId: "board", taskId: "task-42", title: "ask the release name" };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const draw = async (
  props: { taskByNumber?: ReadonlyMap<number, FeedTaskRef>; onOpenTask?: (task: FeedTaskRef) => void; selected?: boolean },
): Promise<void> => {
  await act(async () =>
    root.render(
      <FeedCardView
        item={ITEM}
        nowMs={NOW}
        quickReplies={[]}
        selected={props.selected ?? false}
        reveal={false}
        leaving={false}
        sending={null}
        onSelect={() => {}}
        onQuickReply={() => {}}
        {...props}
      />,
    ),
  );
};

const chip = (): HTMLButtonElement | null => document.body.querySelector<HTMLButtonElement>(".operator-feed__text .resource-chip");

it("is a Tab stop only on the selected card, so a list does not grow one per card", async () => {
  await draw({ taskByNumber: new Map([[42, TASK]]), onOpenTask: () => {} });
  expect(chip()?.tabIndex).toBe(-1);
  await draw({ taskByNumber: new Map([[42, TASK]]), onOpenTask: () => {}, selected: true });
  expect(chip()?.tabIndex).toBe(0);
});

it("names itself by the number first, with no stray words after it", async () => {
  await draw({ taskByNumber: new Map([[42, TASK]]), onOpenTask: () => {} });
  // Everything spoken is in the button's own text: "#42", the title, and nothing else.
  const spoken = chip()!.textContent ?? "";
  expect(spoken.startsWith("#42")).toBe(true);
  expect(spoken).toContain("ask the release name");
  expect(spoken).not.toContain(",");
});

it("draws the number as a task chip, and a press opens that task", async () => {
  const opened: FeedTaskRef[] = [];
  await draw({ taskByNumber: new Map([[42, TASK]]), onOpenTask: (task) => opened.push(task) });
  const drawn = chip();
  expect(drawn?.dataset.kind).toBe("task");
  expect(drawn?.textContent).toContain("#42");
  expect(drawn?.textContent).toContain("ask the release name");
  await act(async () => drawn!.click());
  expect(opened).toEqual([TASK]);
  // The rest of the sentence is untouched, either side of the chip.
  expect(document.body.querySelector(".operator-feed__text")?.textContent).toContain("and the rest is done");
});

it("keeps the words as words when the canvas holds no such number", async () => {
  await draw({ taskByNumber: new Map([[43, { ...TASK, taskId: "task-43" }]]), onOpenTask: () => {} });
  expect(chip()).toBeNull();
  expect(document.body.querySelector(".operator-feed__text")?.textContent).toBe(ITEM.text);
});

it("draws a plain sentence when given no tasks at all", async () => {
  await draw({});
  expect(chip()).toBeNull();
  expect(document.body.querySelector(".operator-feed__text")?.textContent).toBe(ITEM.text);
});

it("a board's own need names its task once: the chip carries the title", async () => {
  const need: FeedItem = { ...ITEM, text: "#42 ask the release name wants your input" };
  await act(async () =>
    root.render(
      <FeedCardView
        item={need}
        nowMs={NOW}
        quickReplies={[]}
        selected={false}
        reveal={false}
        leaving={false}
        sending={null}
        taskByNumber={new Map([[42, TASK]])}
        onOpenTask={() => {}}
        onSelect={() => {}}
        onQuickReply={() => {}}
      />,
    ),
  );
  const sentence = document.body.querySelector(".operator-feed__text")!;
  expect(sentence.textContent).toContain("wants your input");
  // The title is said once: in the chip, never again in the words after it.
  expect((sentence.textContent ?? "").match(/ask the release name/gu) ?? []).toHaveLength(1);
});
