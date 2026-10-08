// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asCanvasName, type Node, type Wire } from "../src/shared/model";
import { ActorRail } from "../src/renderer/components/terminal/ActorRail";
import { SeatCollaborationBlock } from "../src/renderer/components/terminal/SeatCollaborationBlock";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { board, seat, wire } from "./support/model-nodes";

// The terminal family reads the node store. Each case mounts the real
// component with the window document empty, so a read of it would show nothing.

const canvas = "terminal-family-native-reads";
let root: Root;
let host: HTMLDivElement;
let release: () => void = () => undefined;
const oldCanvas = state$.canvasName.peek();

const hold = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire>): void => {
  release();
  release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, nodes: nodes.map((node, z) => ({ ...node, z })), wires: [...wires] });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  state$.canvasName.set(canvas);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
  release = () => undefined;
  state$.canvasName.set(oldCanvas);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("the agent rail draws a seat's connected agents and its other connections from the store", async () => {
  hold(
    [
      seat("lead", { label: "Lead" as never }),
      seat("ada", { label: "Ada" as never }),
      seat("bea", { label: "Bea" as never }),
      seat("solo", { label: "Solo" as never }),
      board("talk"),
    ],
    [
      wire("w1", "lead", "ada", "messages"),
      wire("w2", "bea", "lead", "messages"),
      wire("w3", "lead", "talk", "participates"),
    ],
  );
  await act(async () => root.render(<ActorRail node={{ id: "lead" }} />));
  const seats = [...host.querySelectorAll<HTMLElement>('[data-testid="actor-rail-seat"]')];
  expect(seats.map((element) => element.dataset.peerNodeId).sort()).toEqual(["ada", "bea"]);
  expect(host.querySelector('[aria-label^="Go to Ada"]')).not.toBeNull();
  const others = [...host.querySelectorAll<HTMLElement>('[data-testid="actor-rail-others"] li')];
  expect(others.map((element) => [element.dataset.peerNodeId, element.dataset.peerKind])).toEqual([["talk", "board"]]);
  expect(others[0]!.textContent).toContain("wakes");

  // A wire that goes takes its seat out of the rail, with no document to say so.
  await act(async () => hold([seat("lead"), seat("ada")], []));
  expect(host.querySelector('[data-testid="actor-rail"]')).toBeNull();
});

it("a seat connected to nothing has no rail", async () => {
  hold([seat("solo")], []);
  await act(async () => root.render(<ActorRail node={{ id: "solo" }} />));
  expect(host.querySelector('[data-testid="actor-rail"]')).toBeNull();
});

it("the collaboration block finds its seat among the store's seats", async () => {
  hold([seat("builder", { label: "Builder" as never }), seat("iris", { label: "Iris" as never })], []);
  await act(async () => root.render(<SeatCollaborationBlock nodeId="builder" />));
  // With the document empty a document reader would find no source seat and draw nothing.
  expect(host.innerHTML).not.toBe("");

  await act(async () => root.render(<SeatCollaborationBlock nodeId="nobody" />));
  expect(host.innerHTML).toBe("");
});
