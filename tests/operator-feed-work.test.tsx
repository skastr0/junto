// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { buildOperatorFeed, type FeedItem, type OperatorFeed as Feed } from "../src/shared/operator-feed";
import { OperatorFeed } from "../src/renderer/components/feed/OperatorFeed";
import type { SignalForm, WorkTiming } from "../src/renderer/lib/signal-work";
import { state$ } from "../src/renderer/lib/state";
import { settleLazy } from "./support/settle-lazy";

// The real feed, fed by hand, as in operator-feed-held.
const live = vi.hoisted(() => {
  let feed: Feed | undefined;
  const listeners = new Set<() => void>();
  return {
    set: (next: Feed): void => {
      feed = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: (): Feed => feed!,
  };
});

vi.mock("../src/renderer/lib/operator-feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/lib/operator-feed")>()),
  useOperatorFeed: (): Feed => useSyncExternalStore(live.subscribe, live.read),
}));

// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const CANVAS = "feed-work";
const HOUR = 3_600_000;

/**
 * One signal in the feed, made the operator's work or a notice the way N1
 * will carry it (stand-in until FeedItem names kind, form and work).
 */
const feedWith = (as: { readonly kind: "work" | "notice"; readonly form?: SignalForm; readonly work?: WorkTiming }): Feed => {
  const signal: AgentSignal = {
    signalId: "s1",
    canvasName: CANVAS,
    nodeId: "automations-1",
    kind: "feedback",
    text: "Write 500 words",
    createdAt: Date.now() - HOUR,
    state: "open",
  };
  const feed = buildOperatorFeed({
    canvasName: CANVAS,
    nowMs: Date.now(),
    seats: [{ seat: { nodeId: "automations-1", name: "Daily", portraitIdentity: "daily" }, region: { regionId: null, label: "open field", path: [] } }],
    signals: [signal],
  });
  return {
    ...feed,
    sections: feed.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, ...as }) as unknown as FeedItem),
    })),
  };
};

let root: Root;
let host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();
const pane = (): HTMLElement => document.body.querySelector<HTMLElement>("[data-testid='operator-feed-detail']")!;
const card = (): HTMLElement => document.body.querySelector<HTMLElement>("[data-testid='operator-feed-card']")!;
const buttons = (): string[] => [...pane().querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  state$.canvasName.set(CANVAS);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  state$.canvasName.set(oldCanvas);
  vi.unstubAllGlobals();
});

it("work with an artifact form is answered by writing in the signal, and says it is past due", async () => {
  live.set(
    feedWith({
      kind: "work",
      form: { kind: "artifact", nodeId: "shelf-1", title: "Morning pages", labels: [], minWords: 500 },
      work: { dueAt: Date.now() - HOUR },
    }),
  );
  await act(async () => root.render(<OperatorFeed />));
  await settleLazy();
  expect(pane().querySelector("[data-testid='signal-work-form']")).not.toBeNull();
  expect(pane().querySelector(".signal-work__count")?.textContent).toBe("0 words of 500");
  // The form is the whole answer: no reply to write beside it.
  expect(buttons()).not.toContain("Write reply");
  expect(buttons()).toContain("Hand in");
  const due = card().querySelector(".operator-feed__due");
  expect(due?.textContent).toMatch(/^was due /u);
  expect(due?.hasAttribute("data-urgent")).toBe(true);
});

it("work not yet due shows when, quietly", async () => {
  live.set(feedWith({ kind: "work", form: { kind: "proof" }, work: { dueAt: Date.now() + 2 * 24 * HOUR } }));
  await act(async () => root.render(<OperatorFeed />));
  expect(card().querySelector(".operator-feed__due")?.textContent).toMatch(/^due /u);
  expect(card().querySelector(".operator-feed__due")?.hasAttribute("data-urgent")).toBe(false);
  expect(pane().querySelector("[data-testid='signal-work-form']")?.getAttribute("data-form")).toBe("proof");
});

it("a notice is read and cleared, with no reply to write, and Clear acknowledges it quietly", async () => {
  const respond = vi.fn(async () => ({ ok: false as const, message: "kept open for the test" }));
  vi.stubGlobal("junto", { agentSignalRespond: respond, agentSignalDismiss: vi.fn() });
  live.set(feedWith({ kind: "notice" }));
  await act(async () => root.render(<OperatorFeed />));
  expect(buttons()).toContain("Clear");
  expect(buttons()).not.toContain("Write reply");
  expect(card().querySelector(".operator-feed__due")).toBeNull();
  const clear = [...pane().querySelectorAll("button")].find((button) => button.textContent?.trim() === "Clear")!;
  await act(async () => clear.click());
  expect(respond).toHaveBeenCalledWith("s1", "", { silent: true });
});

it("a notice that carries a form is still cleared, never handed in", async () => {
  live.set(feedWith({ kind: "notice", form: { kind: "artifact", nodeId: "shelf-1", title: "x", labels: [], minWords: 1 } }));
  await act(async () => root.render(<OperatorFeed />));
  expect(buttons()).toContain("Clear");
  expect(pane().querySelector("[data-testid='signal-work-form']")).toBeNull();
});

it("a secret form is never answered in text: it says the vault is not set up, and the keys send nothing", async () => {
  const respond = vi.fn(async () => ({ ok: true as const }));
  vi.stubGlobal("junto", { agentSignalRespond: respond, agentSignalDismiss: vi.fn() });
  live.set(feedWith({ kind: "work", form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN", regionId: "region-1", machine: "studio" } }));
  await act(async () => root.render(<OperatorFeed />));
  expect(pane().querySelector("[role='note']")?.textContent).toContain("This asks for a secret.");
  expect(buttons()).not.toContain("Write reply");
  expect(pane().querySelector("textarea")).toBeNull();
  for (const key of ["1", "a", "d", "Enter"]) {
    await act(async () => card().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  }
  expect(respond).not.toHaveBeenCalled();
  expect(document.body.querySelector("[data-testid='operator-feed-keys']")?.textContent).not.toContain("dismiss");
});

it("an empty feed says the day's work is done", async () => {
  live.set(buildOperatorFeed({ canvasName: CANVAS, nowMs: Date.now(), seats: [], signals: [] }));
  await act(async () => root.render(<OperatorFeed />));
  expect(document.body.querySelector("[data-testid='operator-feed']")?.textContent).toContain("Your work for today is done");
});
