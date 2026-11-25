// @vitest-environment jsdom
/**
 * The seat's bubble is a live region: it speaks a change worth telling, never
 * a re-render after a closing. Driven as the app drives it: two signals raised
 * (the second waits behind the first's dwell), then the first withdrawn while a
 * thread on screen says that closing. Every node added to the bubble's live
 * region and not hidden from readers is something said.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { use$ } from "@legendapp/state/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import { PreambleBubbleView } from "../src/window/components/nodes/PreambleBubbleView";
import { agentSignals$ } from "../src/window/lib/agent-signals-state";
import { clearPreambles, preambleByNodeId$ } from "../src/window/lib/preamble-state";
import { startPreambleSources } from "../src/window/lib/preamble-sources";
import { resetSeatThreads, speakSignalsFor } from "../src/window/lib/seat-threads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEAT = "seat-ada";
const PLAIN = "Which build do you want shipped?";
const ASKS = "Need the deploy token";

const signal = (signalId: string, kind: AgentSignal["kind"], text: string, over: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId,
  canvasName: "c",
  nodeId: SEAT,
  kind,
  text,
  createdAt: Date.now(),
  state: "open",
  ...over,
});

function Bubble() {
  const bubble = use$(preambleByNodeId$[SEAT]);
  return bubble === undefined ? null : <PreambleBubbleView nodeId={SEAT} bubble={bubble} />;
}

let host: HTMLDivElement;
let root: Root;
let said: string[];
let observer: MutationObserver;
let stop: () => void;

const set = (next: AgentSignal) => {
  act(() => {
    agentSignals$[next.signalId].set(next);
  });
};
const later = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
  clearPreambles();
  resetSeatThreads();
  agentSignals$.set({});
  stop = startPreambleSources({ onWireTraffic: () => () => undefined });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Bubble />));
  said = [];
  observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const text = (node.textContent ?? "").trim();
        if (text === "" || node.closest("[aria-hidden]") !== null) continue;
        if (node.closest('[role="status"]') !== null || node.querySelector('[role="status"]') !== null) said.push(text);
      }
  });
  observer.observe(host, { subtree: true, childList: true });
});

afterEach(() => {
  observer.disconnect();
  act(() => root.unmount());
  host.remove();
  stop();
  clearPreambles();
  resetSeatThreads();
  agentSignals$.set({});
  vi.useRealTimers();
});

describe("the seat's bubble through a withdrawal", () => {
  it("says the raises as they come, and nothing at all when a closing is withdrawn that a thread on screen says", async () => {
    set(signal("S1", "escalate", PLAIN));
    set(signal("S2", "blocked", ASKS));
    await later(3_000);
    // The two raises are said, the second after the first's dwell.
    expect(said.map((text) => text.replace(/^.*?(wants you|blocked)/, "$1"))).toEqual([`wants you: ${PLAIN}`, `blocked: ${ASKS}`]);

    said.length = 0;
    const release = speakSignalsFor(["S1", "S2"]);
    set(signal("S1", "escalate", PLAIN, { state: "withdrawn", closedAt: Date.now() }));
    await later(5_000);
    expect(said).toEqual([]);
    release();
  });

  it("never says a raise note after its signal closed: a note still held by the dwell is dropped", async () => {
    set(signal("S1", "escalate", PLAIN));
    set(signal("S2", "blocked", ASKS));
    await later(1_000);
    // The second signal is withdrawn while its raise note still waits out the dwell; a thread on screen says it.
    const release = speakSignalsFor(["S1", "S2"]);
    set(signal("S2", "blocked", ASKS, { state: "withdrawn", closedAt: Date.now() }));
    await later(6_000);
    expect(said.map((text) => text.replace(/^.*?(wants you|blocked)/, "$1"))).toEqual([`wants you: ${PLAIN}`]);
    release();
  });

  it("says the held raise note of a signal that is still open once its dwell is up, whenever the other closes", async () => {
    set(signal("S1", "escalate", PLAIN));
    set(signal("S2", "blocked", ASKS));
    await later(1_000);
    // As the end-to-end line does: the first signal is withdrawn while the second waits its dwell.
    const release = speakSignalsFor(["S1"]);
    set(signal("S1", "escalate", PLAIN, { state: "withdrawn", closedAt: Date.now() }));
    await later(6_000);
    // The second raise is said once, at the end of the first note's dwell: its own time, not the withdrawal's.
    expect(said.map((text) => text.replace(/^.*?(wants you|blocked)/, "$1"))).toEqual([`wants you: ${PLAIN}`, `blocked: ${ASKS}`]);
    release();
  });

  it("tells a withdrawal no thread says", async () => {
    set(signal("S1", "escalate", PLAIN));
    await later(3_000);
    said.length = 0;
    set(signal("S1", "escalate", PLAIN, { state: "withdrawn", closedAt: Date.now() }));
    await later(100);
    expect(said.join(" ")).toContain(`cleared: ${PLAIN}`);
  });
});
