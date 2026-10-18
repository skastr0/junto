/**
 * SeatCard: the seat on the canvas, read from the node store by canvas and
 * id. It is given no document node, so what it shows is what the store holds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeNode, type Node } from "../src/shared/model";
import { SeatCard } from "../src/renderer/components/nodes/SeatCard";
import { agentSeat$ } from "../src/renderer/lib/agent-seat-state";
import { replaceAgentSignals } from "../src/renderer/lib/agent-signals-state";
import { seatNextTurn$ } from "../src/renderer/lib/seat-next-launch";
import { state$ } from "../src/renderer/lib/state";
import { holdModelCanvas as holdCanvas } from "./support/hold-canvas";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const seat = (id: string, label: string, extra: Record<string, unknown> = {}): Node =>
  Effect.runSync(decodeNode({
    kind: "agent", id, label, x: 0, y: 0, width: 216, height: 96, z: 0,
    agentKey: `${THIS_MACHINE}:${id}`, host: THIS_MACHINE, overseer: false, onRemove: "detach",
    bindingId: `binding-${id}`, harness: "claude", ...extra,
  }));

const card = (id: string): string => renderToStaticMarkup(<SeatCard canvas="factory" id={id} />);

describe("SeatCard", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    state$.machines.set([]);
    state$.machineFacts.set({});
    state$.settings.machine.name.set("");
    seatNextTurn$.set({});
    agentSeat$.byBindingId.set({});
  });

  it("marks an overseer seat", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead", { overseer: true })]);

    expect(card("lead")).toContain('data-overseer="true"');
  });

  it("follows a rename", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead")]);
    const renamed = holdCanvas("factory", [seat("lead", "lead")]);
    stop();
    stop = renamed;

    expect(card("lead")).toContain('title="lead"');
  });

  it("says why a seat cannot run when its machine is the reason, naming the machine", () => {
    state$.settings.machine.name.set(THIS_MACHINE);
    state$.machines.set([
      { id: THIS_MACHINE, label: "Studio", isThisMachine: true, capabilities: ["terminal"] },
      { id: OTHER_MACHINE, label: "Atlas", isThisMachine: false, capabilities: ["terminal"] },
    ]);
    state$.machineFacts.set({ [OTHER_MACHINE]: { setUp: false, needsUpdate: false } });
    stop = holdCanvas("factory", [
      seat("far", "builder", { host: OTHER_MACHINE, agentKey: `${OTHER_MACHINE}:far` }),
      seat("near", "lead", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:near` }),
    ]);

    const far = card("far");
    expect(far).toContain('data-machine-state="not-set-up"');
    expect(far).toContain("Junto is not on Atlas yet. Send it from Machines.");
    // A seat on this machine says nothing about machines.
    expect(card("near")).not.toContain("data-machine-state");

    state$.machineFacts.set({ [OTHER_MACHINE]: { setUp: true, needsUpdate: false, reachable: true, harnesses: ["codex"] } });
    expect(card("far")).toContain("Claude Code is not on Atlas. Install it there, or move this seat.");
    state$.machineFacts.set({ [OTHER_MACHINE]: { setUp: true, needsUpdate: false, reachable: true, harnesses: ["claude"] } });
    expect(card("far")).not.toContain("data-machine-state");
  });

  it("says fresh next only when a still seat's next turn starts fresh, and nothing when it continues", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead"), seat("scout", "scout")]);
    // Before main answers, it says only that it is not running.
    expect(card("lead")).toContain("not running");
    expect(card("lead")).not.toContain("fresh next");

    seatNextTurn$.set({ factory: { lead: { fresh: false, freshAt: Date.now() + 60_000 }, scout: { fresh: true } } });
    expect(card("lead")).toContain("not running");
    expect(card("lead")).not.toContain("fresh next");
    expect(card("scout")).toContain("fresh next");
    // No cache wording on the seat, ever.
    expect(card("scout").toLowerCase()).not.toContain("cache");
  });

  it("never says fresh next on a seat that is blocked or needs the operator", () => {
    stop = holdCanvas("factory", [seat("calm", "calm"), seat("stuck", "stuck"), seat("asks", "asks")]);
    const idle = (id: string, state: "idle" | "attention") =>
      agentSeat$.byBindingId[`binding-${id}`].set({ bindingId: `binding-${id}`, epoch: "ep_1", state, reason: "", confidence: "high", at: 1 });
    for (const id of ["calm", "stuck"]) idle(id, "idle");
    idle("asks", "attention");
    seatNextTurn$.set({ factory: { calm: { fresh: true }, stuck: { fresh: true }, asks: { fresh: true } } });
    const render = (id: string, graphBlocked = false) =>
      renderToStaticMarkup(<SeatCard canvas="factory" id={id} graphBlocked={graphBlocked} />);

    expect(render("calm")).toContain("fresh next");
    // Blocked by the work it holds, though its screen is idle.
    expect(render("stuck", true)).not.toContain("fresh next");
    // Waiting on the operator.
    expect(render("asks")).not.toContain("fresh next");
  });

  it("never says fresh next while the seat's hand is raised blocked or escalated, and does for feedback", () => {
    state$.canvasName.set("factory");
    stop = holdCanvas("factory", [seat("stopped", "stopped"), seat("raised", "raised"), seat("review", "review")]);
    const signal = (nodeId: string, kind: "blocked" | "escalate" | "feedback") =>
      ({ signalId: `sig-${nodeId}`, canvasName: "factory", nodeId, kind, text: "needs the operator", createdAt: 1, state: "open" }) as never;
    replaceAgentSignals("factory", [signal("stopped", "blocked"), signal("raised", "escalate"), signal("review", "feedback")]);
    for (const id of ["stopped", "raised", "review"])
      agentSeat$.byBindingId[`binding-${id}`].set({ bindingId: `binding-${id}`, epoch: "ep_1", state: "idle", reason: "", confidence: "high", at: 1 });
    seatNextTurn$.set({ factory: { stopped: { fresh: true }, raised: { fresh: true }, review: { fresh: true } } });

    expect(card("stopped")).not.toContain("fresh next");
    expect(card("raised")).not.toContain("fresh next");
    // Ready for review is a finished turn: the session is cut under it all the same.
    expect(card("review")).toContain("fresh next");
    replaceAgentSignals("", []);
    state$.canvasName.set("");
  });

  it("renders nothing for an id the store does not hold as a seat", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead")]);

    expect(card("absent")).toBe("");
  });
});
