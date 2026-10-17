/**
 * SeatCard: the seat on the canvas, read from the node store by canvas and
 * id. It is given no document node, so what it shows is what the store holds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeNode, type Node } from "../src/shared/model";
import { SeatCard } from "../src/renderer/components/nodes/SeatCard";
import { harnessVerification$, resetHarnessVerification } from "../src/renderer/lib/harness-verification";
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
    resetHarnessVerification();
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

  it("notes a harness newer than tested, quietly, from the seat's own machine", () => {
    const newer = { verification: { verdict: "newer" as const, from: "2.0.0", through: "2.1.0" }, version: "2.4.1" };
    harnessVerification$.set({ [THIS_MACHINE]: { claude: newer } });
    stop = holdCanvas("factory", [
      seat("near", "lead"),
      seat("far", "builder", { host: OTHER_MACHINE, agentKey: `${OTHER_MACHINE}:far` }),
    ]);

    const near = card("near");
    expect(near).toContain('data-testid="seat-version-note"');
    expect(near).toContain(">unverified<");
    expect(near).toContain("Newer than tested (verified through 2.1.0). This machine has 2.4.1. It still launches.");
    // Steel ink, never an attention colour.
    expect(near).not.toMatch(/seat-version-note[^]*(amber|crimson)/);
    // This window's machine is not the far seat's: it says nothing until its own machine answers.
    expect(card("far")).not.toContain("seat-version-note");

    harnessVerification$.set({ [THIS_MACHINE]: { claude: { ...newer, verification: { ...newer.verification, verdict: "verified" } } } });
    expect(card("near")).not.toContain("seat-version-note");
  });

  it("renders nothing for an id the store does not hold as a seat", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead")]);

    expect(card("absent")).toBe("");
  });
});
