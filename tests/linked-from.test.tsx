// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedFrom } from "../src/renderer/components/artifacts/LinkedFrom";
import { installBodyLinks, readableLine, type BodyLink } from "../src/renderer/lib/linked-from";
import { mentionLink } from "../src/shared/mention";
import { modelStore } from "../src/renderer/lib/use-model";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import type { MentionedIn as Entry, MentionPage } from "../src/shared/mention-ipc";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/resource-command";
import { seat, taskBoard } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "factory";
const HERE = "01M5ESSJRFWT6RVS5HMWMGJXGA" as ItemId;
const PLAN = "01M5ESSJRFWT6RVS5HMWMGJXGB" as ItemId;
const NOTES = "01M5ESSJRFWT6RVS5HMWMGJXGC" as ItemId;
const shelf = asNodeId("board");
const target = { nodeId: shelf, artifactId: HERE };

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let bodiesChanged: ((event: { canvasName: string }) => void) | undefined;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

const link = (artifactId: ItemId, over: Partial<BodyLink>): BodyLink => ({
  source: { nodeId: shelf, artifactId },
  title: "Plan",
  type: "document",
  line: "",
  at: 0,
  ...over,
});

const installMentions = (page: MentionPage) => {
  (window as { junto?: unknown }).junto = { mentions: { list: vi.fn(async () => page), onChanged: () => () => undefined } };
};

const installBodies = (answers: ReadonlyArray<ReadonlyArray<BodyLink>>) => {
  const linkedFrom = vi.fn(async () => answers[Math.min(linkedFrom.mock.calls.length - 1, answers.length - 1)]!);
  installBodyLinks({
    linkedFrom,
    onChanged: (listener) => {
      bodiesChanged = listener;
      return () => undefined;
    },
  });
  return linkedFrom;
};

const rows = () => [...host.querySelectorAll('[data-testid="linked-from-row"]')];

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
  installBodyLinks(null);
  bodiesChanged = undefined;
  delete (window as { junto?: unknown }).junto;
  workDetailOpen$.set({ nodeId: "", itemId: "" });
});

describe("linked from", () => {
  it("shows nothing while nothing links to the artifact, its own body aside", async () => {
    installMentions({ entries: [] });
    installBodies([[link(HERE, { line: "see [[this]]" })]]);
    act(() => root.render(<LinkedFrom canvasName={CANVAS} target={target} now={0} />));
    await flush();
    expect(host.querySelector('[data-testid="linked-from"]')).toBeNull();
  });

  it("lists bodies with their line beside mail and comments, newest first, and opens the linking artifact", async () => {
    installMentions({
      entries: [
        { messageId: "m1", threadId: "m1", mailbox: asNodeId("seat-a"), author: { kind: "seat", name: "brook" }, at: 2_000 } as unknown as Entry,
      ],
    });
    const linkedFrom = installBodies([
      [
        link(PLAN, { title: "Plan", line: `Ship after ${mentionLink({ kind: "artifact", nodeId: shelf, artifactId: HERE }, "[[Notes]]", CANVAS)} lands`, at: 3_000 }),
        link(NOTES, { title: "Notes", type: "pad", at: 1_000 }),
      ],
    ]);
    act(() => root.render(<LinkedFrom canvasName={CANVAS} target={target} now={4_000} />));
    await flush();
    expect(linkedFrom).toHaveBeenCalledWith(CANVAS, target);
    expect(host.querySelector('[data-testid="linked-from"]')?.textContent).toContain("Linked from, 3");
    expect(rows().map((row) => row.getAttribute("data-kind"))).toEqual(["body", "post", "body"]);
    expect(rows()[0]!.querySelector(".linked-from__line")?.textContent).toBe("Ship after [[Notes]] lands");
    expect(rows()[1]!.textContent).toContain("mail by brook");
    expect(rows()[2]!.querySelector(".linked-from__line")).toBeNull();

    act(() => (rows()[0]!.querySelector("button") as HTMLButtonElement).click());
    expect(workDetailOpen$.get()).toEqual({ nodeId: "board", itemId: PLAN });
  });

  it("reads the bodies again when main says links changed on the canvas", async () => {
    installMentions({ entries: [] });
    installBodies([[], [link(PLAN, { title: "Plan", at: 1 })]]);
    act(() => root.render(<LinkedFrom canvasName={CANVAS} target={target} now={0} />));
    await flush();
    expect(rows()).toHaveLength(0);
    act(() => bodiesChanged?.({ canvasName: "elsewhere" }));
    await flush();
    expect(rows()).toHaveLength(0);
    act(() => bodiesChanged?.({ canvasName: CANVAS }));
    await flush();
    expect(rows()).toHaveLength(1);
  });

  it("shows a body's line with each link as its label, a link the bound cut through as the label it got", () => {
    const stored = mentionLink({ kind: "artifact", nodeId: shelf, artifactId: PLAN }, "Plan", CANVAS);
    expect(readableLine(`  See ${stored} and more  `)).toBe("See Plan and more");
    expect(readableLine(`See ${stored.slice(0, 30)}…`)).toBe("See Plan…");
    expect(readableLine("plain words")).toBe("plain words");
  });

  it("says you for the operator's own comment, whatever name main gives it", async () => {
    installMentions({
      entries: [
        {
          messageId: "m1",
          threadId: "m1",
          mailbox: shelf,
          subject: { kind: "artifact", nodeId: shelf, artifactId: NOTES },
          author: { kind: "operator", name: "operator" },
          at: 1,
        } as unknown as Entry,
      ],
    });
    installBodies([[]]);
    act(() => root.render(<LinkedFrom canvasName={CANVAS} target={target} now={1} nameOf={() => "Research notes"} />));
    await flush();
    expect(rows()[0]!.textContent).toContain("Research notes");
    expect(rows()[0]!.textContent).toContain("comment by you");
  });
});
