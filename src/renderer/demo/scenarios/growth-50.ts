// Growth-ladder scenario for the Junto demo engine — active ONLY
// under --junto-demo / JUNTO_DEMO=1 (see @shared/demo). Landing-page demo:
// a crew that starts with two agents and only ever grows. Each rung
// introduces one product feature; label overlays are composited in post from
// the EDL (this file emits no copy beyond in-world card text).
//
// Pure data builder: fixed deterministic ids, no ulid, no Math.random, no
// runtime framework. Imports only native model and demo contracts.
//
// On-camera naming law (marketing frames carry no third-party marks): agents
// are the house avatar-crew names — rivet, brisk, mote, ward, relay, vector,
// gauge, folio — and card labels are plain product-true task briefs.

import { asNodeId, type BindingId, type Node, type NodeOf } from "@shared/model";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";
import { DEMO_THIS_MACHINE } from "../machine";

// --- beat accumulator ---------------------------------------------------------
// Exactly one DemoBeat per distinct `.at` — ops sharing a beat are merged.

const beatOps = new Map<number, DemoOp[]>();

const at = (atBeat: number, ...ops: DemoOp[]): void => {
  const existing = beatOps.get(atBeat);
  if (existing) {
    existing.push(...ops);
  } else {
    beatOps.set(atBeat, [...ops]);
  }
};

// --- op builders --------------------------------------------------------------

const addNodesOp = (nodes: readonly Node[]): DemoOp => ({ kind: "add-nodes", nodes });

const cameraFit = (
  nodeIds: readonly string[] | undefined,
  durationBeats: number,
  padding?: number,
  maxZoom?: number,
): DemoOp => ({ kind: "camera-fit", nodeIds, durationBeats, padding, maxZoom });

const selectOp = (nodeIds: readonly string[]): DemoOp => ({ kind: "select", nodeIds });
const sfxOp = (id: string): DemoOp => ({ kind: "sfx", id });
const hudOp = (show: boolean): DemoOp => ({ kind: "hud", show });

// --- crew ---------------------------------------------------------------------

interface CrewSpec {
  readonly id: string;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

const crew = (
  n: number,
  host: string,
  agent: string,
  brief: string,
  x: number,
  y: number,
): CrewSpec => {
  const nn = String(n).padStart(2, "0");
  return {
    id: `demo-g-h${nn}`,
    host,
    paneId: `w1:p${nn}`,
    terminalId: `term-p${nn}`,
    agent,
    label: `${agent} - ${brief}`,
    x,
    y,
  };
};

const crewNode = (spec: CrewSpec): NodeOf<"terminal"> => ({
  id: asNodeId(spec.id),
  kind: "terminal",
  label: spec.label,
  z: 0,
  x: spec.x,
  y: spec.y,
  width: 260,
  height: 110,
  host: spec.host,
  bindingId: spec.terminalId as BindingId,
  onRemove: "detach",
});

/** Spawn = the crew card entering on its beat. */
const spawn = (spec: CrewSpec): readonly DemoOp[] => [addNodesOp([crewNode(spec)])];

// --- the crew roster ----------------------------------------------------------
// Region A: build lane, on this machine. Region B: deep research, on this machine.
// Region C: on the mac_mini. Finale rows fill remaining seats.

const A = [
  crew(1, DEMO_THIS_MACHINE, "rivet", "typecheck pass", 0, 0),
  crew(2, DEMO_THIS_MACHINE, "brisk", "release notes", 300, 0),
  crew(3, DEMO_THIS_MACHINE, "mote", "canvas sync", 600, 0),
  crew(4, DEMO_THIS_MACHINE, "ward", "sfx regen", 900, 0),
  crew(5, DEMO_THIS_MACHINE, "relay", "landing copy pass", 0, 180),
  crew(6, DEMO_THIS_MACHINE, "vector", "og plates", 300, 180),
  crew(7, DEMO_THIS_MACHINE, "gauge", "kernel cycle", 600, 180),
  crew(8, DEMO_THIS_MACHINE, "folio", "session digests", 900, 180),
] as const;

const B = [
  crew(9, DEMO_THIS_MACHINE, "rivet", "pricing research", 0, 540),
  crew(10, DEMO_THIS_MACHINE, "brisk", "competitor scan", 300, 540),
  crew(11, DEMO_THIS_MACHINE, "mote", "docs outline", 600, 540),
  crew(12, DEMO_THIS_MACHINE, "ward", "reader survey", 0, 720),
  crew(13, DEMO_THIS_MACHINE, "relay", "citation check", 300, 720),
] as const;

const C = [
  crew(14, "mac_mini", "vector", "e2e suite", 1020, 540),
  crew(15, "mac_mini", "gauge", "perf trace", 1320, 540),
  crew(16, "mac_mini", "folio", "nightly build", 1620, 540),
  crew(17, "mac_mini", "rivet", "screenshot pass", 1020, 720),
  crew(18, "mac_mini", "brisk", "package audit", 1320, 720),
  crew(19, "mac_mini", "mote", "log triage", 1620, 720),
] as const;

const FINALE = [
  crew(20, DEMO_THIS_MACHINE, "ward", "changelog", 600, 720),
  crew(21, "mac_mini", "relay", "backup verify", 1920, 540),
  crew(22, "mac_mini", "vector", "queue drain", 1920, 720),
] as const;

// --- fixed set-piece nodes ----------------------------------------------------

const regionA: NodeOf<"region"> = {
  id: asNodeId("demo-g-region-a"),
  kind: "region",
  z: 0,
  hold: false,
  label: "build lane",
  x: -80,
  y: -80,
  width: 1300,
  height: 460,
};

const regionB: NodeOf<"region"> = {
  id: asNodeId("demo-g-region-b"),
  kind: "region",
  z: 0,
  hold: false,
  label: "deep research",
  x: -80,
  y: 460,
  width: 940,
  height: 440,
};

const regionC: NodeOf<"region"> = {
  id: asNodeId("demo-g-region-c"),
  kind: "region",
  z: 0,
  hold: false,
  label: "mac_mini",
  x: 940,
  y: 460,
  width: 1300,
  height: 440,
};

const noteBrief: NodeOf<"note"> = {
  id: asNodeId("demo-g-note1"),
  kind: "note",
  z: 0,
  text: "# Launch week\n\n- landing copy pass\n- og plates\n- ship the beta build",
  x: 1340,
  y: 0,
  width: 260,
  height: 200,
};

const noteScratch: NodeOf<"note"> = {
  id: asNodeId("demo-g-note2"),
  kind: "note",
  z: 0,
  text: "pricing call notes",
  x: 1340,
  y: 240,
  width: 260,
  height: 84,
};

const queueNode: NodeOf<"task"> = {
  id: asNodeId("demo-g-tasks"),
  kind: "task",
  z: 0,
  name: "launch tasks",
  x: -460,
  y: 0,
  width: 260,
  height: 140,
};

const requestsNode: NodeOf<"requests"> = {
  id: asNodeId("demo-g-requests"),
  kind: "requests",
  z: 0,
  name: "requests",
  x: -460,
  y: 220,
  width: 260,
  height: 120,
};

const artifactsNode: NodeOf<"artifacts"> = {
  id: asNodeId("demo-g-artifacts"),
  kind: "artifacts",
  z: 0,
  label: "artifacts",
  x: -460,
  y: 420,
  width: 260,
  height: 120,
};

// No wires in this scenario. The crew are terminal cards, and terminal admits
// no verb in the grammar (see VERB_TABLE) — every ordered pair here is empty,
// so an authored edge would paint during the take and then be dropped by the
// next decode. The film reads by proximity and region membership instead.

// --- the beat map (BPM 112; labels land in post from these beat windows) ------
//
// Rung 1  b0    two agents, one note — the "new game" board
// Rung 2  b8    the queue lands                       [L1: queues, not prompts]
// Rung 3  b14   play — crew pulls work on its own     [L2: press play, work flows]
// Rung 4  b26   growth + first blocker               [L3: blocked goes red]
// Rung 5  b42   requests inbox, answer, clear        [L4: questions, one inbox]
// Rung 6  b54   artifacts shelf                      [L5: results file themselves]
// Rung 7  b62   second machine joins                 [L6: every machine, one crew]
// Rung 8  b74   finale growth + slow pullback        [close card]

// Rung 1 — open small.
at(0, hudOp(false), addNodesOp([regionA, noteBrief]), ...spawn(A[0]), ...spawn(A[1]));
at(0.5, cameraFit(["demo-g-h01", "demo-g-h02", "demo-g-note1"], 1.5, 0.22, 1.05));
at(6, addNodesOp([noteScratch]));

// Rung 2 — the queue lands beside the crew.
at(
  8,
  addNodesOp([queueNode]),
  sfxOp("task"),
  cameraFit(["demo-g-tasks", "demo-g-h01", "demo-g-h02", "demo-g-note1"], 2, 0.18),
);

// Rung 3 — play: the two wake, then the row fills on its own.
at(14, sfxOp("wake"));
at(16, ...spawn(A[2]));
at(17.5, ...spawn(A[3]));
at(19, ...spawn(A[4]));
at(20.5, ...spawn(A[5]));
at(22, ...spawn(A[6]), ...spawn(A[7]));
at(23, cameraFit(undefined, 2, 0.16));

// Rung 4 — second region, more crew.
at(26, addNodesOp([regionB]));
at(28, ...spawn(B[0]), ...spawn(B[1]));
at(30, ...spawn(B[2]), ...spawn(B[3]));
at(32, ...spawn(B[4]));
at(33, cameraFit(undefined, 2, 0.16));
at(36, sfxOp("alert"));

// Rung 5 — the question surfaces, gets answered, the fleet re-greens.
at(
  42,
  addNodesOp([requestsNode]),
  selectOp(["demo-g-h06", "demo-g-requests"]),
  cameraFit(["demo-g-h06", "demo-g-requests", "demo-g-tasks"], 1.5, 0.2),
  sfxOp("request"),
);
at(46, sfxOp("clear"));
at(49, selectOp([]));
at(50, cameraFit(undefined, 2.5, 0.16));

// Rung 6 — results land somewhere real.
at(54, addNodesOp([artifactsNode]), sfxOp("artifact"));

// Rung 7 — the second machine joins the same board.
at(62, addNodesOp([regionC]), cameraFit(undefined, 2, 0.15));
at(64, ...spawn(C[0]), ...spawn(C[1]));
at(66, ...spawn(C[2]), ...spawn(C[3]));
at(68, ...spawn(C[4]), ...spawn(C[5]));
at(70, cameraFit(undefined, 2, 0.15));

// Rung 8 — the crew hums; slow pullback.
at(74, ...spawn(FINALE[0]), ...spawn(FINALE[1]));
at(76, ...spawn(FINALE[2]));
at(82, sfxOp("clear"));
at(86, cameraFit(undefined, 6, 0.2));

// --- assemble -----------------------------------------------------------------

const beats: DemoBeat[] = [...beatOps.entries()]
  .sort(([a], [b]) => a - b)
  .map(([atBeat, ops]) => ({ at: atBeat, ops }));

export const growth50: DemoScenario = {
  id: "growth-50",
  title: "Growth ladder — landing demo",
  bpm: 112,
  beats,
};
