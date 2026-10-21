// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionedIn } from "../src/renderer/components/threads/MentionedIn";
import { modelStore } from "../src/renderer/lib/use-model";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import type { MentionedIn as Entry, MentionPage } from "../src/shared/mention-ipc";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { seat, taskBoard } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "factory";
const TASK = "01M5ESSJRFWT6RVS5HMWMGJXGD";
const OTHER = "01M5ESSJRFWT6RVS5HMWMGJXGE";

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let changed: ((event: { canvasName: string }) => void) | undefined;

const entry = (messageId: string, over: Partial<Entry>): Entry =>
  ({ messageId, threadId: messageId, mailbox: asNodeId("seat-a"), author: { kind: "operator", name: "You" }, at: 0, ...over }) as Entry;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  release = modelStore.adopt({
    canvas: asCanvasName(CANVAS),
    seq: 0,
    wires: [],
    nodes: [seat("seat-a", { label: "atlas", z: 0 }), taskBoard("board", { x: 400, z: 1 })],
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
  changed = undefined;
  delete (window as { junto?: unknown }).junto;
  workDetailOpen$.set({ nodeId: "", itemId: "" });
});

const install = (pages: ReadonlyArray<MentionPage>) => {
  const list = vi.fn(async () => pages[Math.min(list.mock.calls.length - 1, pages.length - 1)]!);
  (window as { junto?: unknown }).junto = {
    mentions: {
      list,
      onChanged: (listener: (event: { canvasName: string }) => void) => {
        changed = listener;
        return () => undefined;
      },
    },
  };
  return list;
};

const target = { kind: "seat", nodeId: asNodeId("seat-a") } as const;
const rows = () => [...host.querySelectorAll('[data-testid="mentioned-in-row"]')];

describe("mentioned in", () => {
  it("shows nothing until it is mentioned somewhere", async () => {
    install([{ entries: [] }]);
    act(() => root.render(<MentionedIn canvasName={CANVAS} target={target} now={0} />));
    await flush();
    expect(host.querySelector('[data-testid="mentioned-in"]')).toBeNull();
  });

  it("lists each place newest first: a comment by its resource, mail by its seat's portrait, and opens it", async () => {
    const list = install([
      {
        entries: [
          entry("m2", { subject: { kind: "task", nodeId: asNodeId("board"), taskId: TASK } as Entry["subject"], mailbox: asNodeId("board") }),
          entry("m1", { author: { kind: "seat", name: "brook" } as Entry["author"] }),
        ],
        next: "cursor-1",
      },
      { entries: [entry("m0", { subject: { kind: "task", nodeId: asNodeId("board"), taskId: OTHER } as Entry["subject"], mailbox: asNodeId("board") })] },
    ]);
    act(() =>
      root.render(
        <MentionedIn canvasName={CANVAS} target={target} now={0} nameOf={(place) => (place.kind === "task" ? "fix tabs" : undefined)} />,
      ),
    );
    await flush();
    expect(list).toHaveBeenCalledWith(CANVAS, target, { limit: 20 });
    expect(rows().map((row) => row.querySelector(".resource-chip__label")?.textContent)).toEqual(["fix tabs", "@atlas"]);
    expect(rows()[1]!.querySelector('[data-testid="seat-portrait-mark"]')).not.toBeNull();
    expect(rows()[1]!.textContent).toContain("mail by brook");

    act(() => (host.querySelector('[data-testid="mentioned-in-more"]') as HTMLButtonElement).click());
    await flush();
    expect(list).toHaveBeenLastCalledWith(CANVAS, target, { before: "cursor-1", limit: 20 });
    expect(rows()).toHaveLength(3);
    expect(host.querySelector('[data-testid="mentioned-in-more"]')).toBeNull();

    act(() => (rows()[0]!.querySelector("button") as HTMLButtonElement).click());
    expect(workDetailOpen$.get()).toEqual({ nodeId: "board", itemId: TASK });
  });

  it("reads the first page again when a mention is added on its canvas", async () => {
    const list = install([{ entries: [entry("m1", {})] }]);
    act(() => root.render(<MentionedIn canvasName={CANVAS} target={target} now={0} />));
    await flush();
    const calls = list.mock.calls.length;
    act(() => changed?.({ canvasName: "other" }));
    await flush();
    expect(list.mock.calls.length).toBe(calls);
    act(() => changed?.({ canvasName: CANVAS }));
    await flush();
    expect(list.mock.calls.length).toBe(calls + 1);
  });
});
