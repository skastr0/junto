// @vitest-environment jsdom
/**
 * Cues fire on real transitions only.
 *
 * The operator heard Junto's cues on a board where nothing was happening.
 * The alert queue was observed only when the rollups or the document changed,
 * never when a seat did (the seat store mutates in place, so its identity
 * never moved): a seat's change was heard late, on whatever unrelated write
 * came next, or not at all. These tests drive the real hook through the real
 * seat store and hold the law both ways: a real transition is heard when it
 * happens, and a state re-sent unchanged, a reason-only change, a gap where
 * the seat's state is unknown, a document write, the seats loading, and a
 * canvas switch are not.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSeatState, AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { CanvasNode } from "../src/shared/canvas";
import type { RegionRollup } from "../src/shared/region-rollup";
import { resetAlertQueue, useAlertAttention } from "../src/renderer/lib/alert-attention";
import {
  agentSeat$,
  applyAgentSeatStateEvent,
  markAgentSeatSeen,
  resetAgentSeatState,
  seatDoneAt,
} from "../src/renderer/lib/agent-seat-state";
import { seatSubjects } from "../src/renderer/lib/desktop-notify";
import * as sound from "../src/renderer/lib/sound";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seatNode = (id: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 240,
  height: 96,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `bind-${id}`, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
  },
});

let clock = 1_000;
const event = (
  id: string,
  state: AgentSeatState,
  reason = "rule:osc_title_idle",
  epoch = "ep-1",
): AgentSeatStateEvent => {
  clock += 1_000;
  return { bindingId: `bind-${id}`, epoch, state, reason, confidence: "high", at: clock, harness: "claude" };
};

// Stable, as the app's memoized rollups are: a fresh array per render would
// re-run the hook's effect on any render and hide what it misses.
const NO_ROLLUPS: ReadonlyArray<RegionRollup> = [];

function Attention() {
  useAlertAttention(NO_ROLLUPS);
  return null;
}

let root: Root;
let host: HTMLDivElement;
let play: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> }; mockClear: () => void; mockRestore: () => void };

const apply = (next: AgentSeatStateEvent): void => act(() => applyAgentSeatStateEvent(next));
const cues = (): ReadonlyArray<string> => play.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  resetAgentSeatState();
  resetAlertQueue();
  play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
  state$.canvasName.set("idle-board");
  state$.doc.set({ nodes: [seatNode("a"), seatNode("b")], edges: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Attention />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  play.mockRestore();
  resetAgentSeatState();
  resetAlertQueue();
  state$.doc.set({ nodes: [], edges: [] });
  state$.canvasName.set("");
});

/** The snapshot lands: both seats idle, the store hydrated. */
const hydrateIdle = (): void => {
  apply(event("a", "idle"));
  apply(event("b", "idle"));
  act(() => agentSeat$.hydrated.set(true));
};

describe("a real transition is heard when it happens", () => {
  it("started working, then done, each at its own event", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    expect(cues()).toEqual(["working"]);
    apply(event("a", "idle"));
    expect(cues()).toEqual(["working", "done"]);
  });

  it("a seat that stops for the operator is heard at once", () => {
    hydrateIdle();
    apply(event("b", "attention", "rule:permission_prompt"));
    expect(cues()).toEqual(["waiting"]);
  });
});

describe("nothing new is not heard", () => {
  it("the seats loading is not news, before or at hydration", () => {
    apply(event("a", "working", "rule:screen_working"));
    apply(event("b", "idle"));
    act(() => agentSeat$.hydrated.set(true));
    expect(cues()).toEqual([]);
  });

  it("an unchanged state re-sent, with a new time or a new reason, plays nothing", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    apply(event("a", "idle"));
    play.mockClear();
    apply(event("a", "idle"));
    apply(event("a", "idle", "hook:stop"));
    apply(event("b", "idle", "default_known_agent_idle_fallback"));
    expect(cues()).toEqual([]);
  });

  it("a gap where the seat's state is unknown, then back where it was, plays nothing", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    play.mockClear();
    apply(event("a", "unknown", "generation_bound"));
    apply(event("a", "working", "rule:screen_working"));
    expect(cues()).toEqual([]);
  });

  it("a document write while seats sit still plays nothing, and does not deliver an old change late", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    apply(event("a", "idle"));
    play.mockClear();
    act(() => state$.doc.set({ nodes: [...state$.doc.peek().nodes, { id: "note", type: "text", text: "moved", x: 9, y: 9, width: 10, height: 10 }], edges: [] }));
    expect(cues()).toEqual([]);
  });

  it("switching to a canvas whose seats are busy plays nothing", () => {
    hydrateIdle();
    apply(event("c", "working", "rule:screen_working"));
    play.mockClear();
    act(() => {
      state$.canvasName.set("other-board");
      state$.doc.set({ nodes: [seatNode("c")], edges: [] });
    });
    expect(cues()).toEqual([]);
    // And a real change there is heard.
    apply(event("c", "idle"));
    expect(cues()).toEqual(["done"]);
  });

  it("looking at a finished seat plays nothing", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    apply(event("a", "idle"));
    play.mockClear();
    act(() => markAgentSeatSeen("bind-a"));
    expect(cues()).toEqual([]);
  });
});

describe("a finished turn is one need for desktop notifications", () => {
  const subjectKeys = (): ReadonlyArray<string> =>
    seatSubjects({
      canvasName: "idle-board",
      doc: state$.doc.peek(),
      bindingOf: (node) => `bind-${node.id}`,
      seatState: (bindingId) => agentSeat$.byBindingId[bindingId].peek(),
      needsLook: (bindingId) => agentSeat$.needsLookByBindingId[bindingId].peek() === true,
      doneAt: seatDoneAt,
      failure: () => undefined,
      exitMessage: () => undefined,
      lastSaid: () => undefined,
    }).map((subject) => subject.key);

  it("keeps its key while the seat's state is re-sent, and gets a new one for the next turn", () => {
    hydrateIdle();
    apply(event("a", "working", "rule:screen_working"));
    apply(event("a", "idle"));
    const first = subjectKeys();
    expect(first).toHaveLength(1);
    apply(event("a", "idle", "hook:stop"));
    apply(event("a", "idle"));
    expect(subjectKeys()).toEqual(first);
    apply(event("a", "working", "rule:screen_working"));
    apply(event("a", "idle"));
    expect(subjectKeys()).toHaveLength(1);
    expect(subjectKeys()).not.toEqual(first);
  });
});
