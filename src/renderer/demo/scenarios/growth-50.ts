// Growth-ladder scenario for the Vellum Command demo engine — active ONLY
// under --vellum-demo / VELLUM_COMMAND_DEMO=1 (see @shared/demo). Landing-page demo:
// a factory that starts with two agents and only ever grows. Each rung
// introduces one product feature; label overlays are composited in post from
// the EDL (this file emits no copy beyond in-world card text).
//
// Pure data builder: fixed deterministic ids, no ulid, no Math.random, no
// runtime framework. Imports only @shared/demo + @shared/canvas.
//
// On-camera naming law (marketing frames carry no third-party marks): agents
// are the house avatar-crew names — rivet, brisk, mote, ward, relay, vector,
// gauge, folio — and card labels are plain product-true task briefs.

import type {
  Artifact,
  CanvasNode,
  EtherFlag,
  GroupNode,
  Task,
  TextNode,
} from "@shared/canvas";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";

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

const addNodesOp = (nodes: readonly CanvasNode[]): DemoOp => ({ kind: "add-nodes", nodes });

const cameraFit = (
  nodeIds: readonly string[] | undefined,
  durationBeats: number,
  padding?: number,
  maxZoom?: number,
): DemoOp => ({ kind: "camera-fit", nodeIds, durationBeats, padding, maxZoom });

const flagOp = (nodeIds: readonly string[], flag: EtherFlag, on: boolean): DemoOp => ({
  kind: "flag",
  nodeIds,
  flag,
  on,
});

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

const crewNode = (spec: CrewSpec): TextNode => ({
  id: spec.id,
  type: "text",
  text: spec.label,
  x: spec.x,
  y: spec.y,
  width: 260,
  height: 110,
  ether: {
    entity: { kind: "terminal" },
    host: spec.host,
    terminal: { bindingId: spec.terminalId, label: spec.label },
  },
});

/** Spawn = the crew card entering on its beat. */
const spawn = (spec: CrewSpec): readonly DemoOp[] => [addNodesOp([crewNode(spec)])];

// --- the crew roster ----------------------------------------------------------
// Region A: build lane (local). Region B: deep research (local).
// Region C: mac_mini remote. Finale rows fill remaining seats.

const A = [
  crew(1, "local", "rivet", "typecheck pass", 0, 0),
  crew(2, "local", "brisk", "release notes", 300, 0),
  crew(3, "local", "mote", "canvas sync", 600, 0),
  crew(4, "local", "ward", "sfx regen", 900, 0),
  crew(5, "local", "relay", "landing copy pass", 0, 180),
  crew(6, "local", "vector", "og plates", 300, 180),
  crew(7, "local", "gauge", "kernel cycle", 600, 180),
  crew(8, "local", "folio", "session digests", 900, 180),
] as const;

const B = [
  crew(9, "local", "rivet", "pricing research", 0, 540),
  crew(10, "local", "brisk", "competitor scan", 300, 540),
  crew(11, "local", "mote", "docs outline", 600, 540),
  crew(12, "local", "ward", "reader survey", 0, 720),
  crew(13, "local", "relay", "citation check", 300, 720),
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
  crew(20, "local", "ward", "changelog", 600, 720),
  crew(21, "mac_mini", "relay", "backup verify", 1920, 540),
  crew(22, "mac_mini", "vector", "queue drain", 1920, 720),
] as const;

// --- work-plane fixtures ------------------------------------------------------

const task = (id: string, brief: string, state: Task["state"] = "submitted"): Task => ({
  id,
  state,
  history: [
    {
      messageId: `${id}-m0`,
      role: "user",
      parts: [{ kind: "text", text: brief }],
      taskId: id,
      contextId: "demo",
    },
  ],
});

const QUEUE_TASKS: readonly Task[] = [
  task("demo-g-t1", "ship the beta build"),
  task("demo-g-t2", "landing copy pass"),
  task("demo-g-t3", "og plates"),
  task("demo-g-t4", "release notes"),
  task("demo-g-t5", "docs outline"),
  task("demo-g-t6", "nightly build"),
];

const REQUEST_TASKS: readonly Task[] = [
  task("demo-g-rq1", "signing key choice needed", "input-required"),
];

const ARTIFACTS: readonly Artifact[] = [
  { artifactId: "demo-g-a1", name: "release-notes.md", parts: [] },
  { artifactId: "demo-g-a2", name: "og-plate-01.png", parts: [] },
  { artifactId: "demo-g-a3", name: "beta-build.dmg", parts: [] },
];

// --- fixed set-piece nodes ----------------------------------------------------

const regionA: GroupNode = {
  id: "demo-g-region-a",
  type: "group",
  label: "build lane",
  x: -80,
  y: -80,
  width: 1300,
  height: 460,
};

const regionB: GroupNode = {
  id: "demo-g-region-b",
  type: "group",
  label: "deep research",
  x: -80,
  y: 460,
  width: 940,
  height: 440,
};

const regionC: GroupNode = {
  id: "demo-g-region-c",
  type: "group",
  label: "mac_mini",
  x: 940,
  y: 460,
  width: 1300,
  height: 440,
};

const noteBrief: TextNode = {
  id: "demo-g-note1",
  type: "text",
  text: "# Launch week\n\n- landing copy pass\n- og plates\n- ship the beta build",
  x: 1340,
  y: 0,
  width: 260,
  height: 200,
};

const noteScratch: TextNode = {
  id: "demo-g-note2",
  type: "text",
  text: "pricing call notes",
  x: 1340,
  y: 240,
  width: 260,
  height: 84,
};

const queueNode: TextNode = {
  id: "demo-g-tasks",
  type: "text",
  text: QUEUE_TASKS.map((t) => {
    const part = t.history[0]?.parts.find((p) => p.kind === "text");
    return part && part.kind === "text" ? part.text : t.id;
  }).join("\n"),
  x: -460,
  y: 0,
  width: 260,
  height: 140,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [...QUEUE_TASKS] },
  },
};

const requestsNode: TextNode = {
  id: "demo-g-requests",
  type: "text",
  text: "1 pending",
  x: -460,
  y: 220,
  width: 260,
  height: 120,
  ether: {
    entity: { kind: "requests" },
    requests: { items: [...REQUEST_TASKS] },
  },
};

const artifactsNode: TextNode = {
  id: "demo-g-artifacts",
  type: "text",
  text: "artifacts",
  x: -460,
  y: 420,
  width: 260,
  height: 120,
  ether: {
    entity: { kind: "artifacts" },
    artifacts: { items: [...ARTIFACTS] },
  },
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
// Rung 7  b62   second machine joins                 [L6: every machine, one factory]
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

// Rung 4 — second region, more crew, then the first blocker.
at(26, addNodesOp([regionB]));
at(28, ...spawn(B[0]), ...spawn(B[1]));
at(30, ...spawn(B[2]), ...spawn(B[3]));
at(32, ...spawn(B[4]));
at(33, cameraFit(undefined, 2, 0.16));
at(36, flagOp(["demo-g-h06"], "blocker", true), sfxOp("alert"));
at(40, flagOp(["demo-g-h13"], "blocker", true));

// Rung 5 — the question surfaces, gets answered, the fleet re-greens.
at(
  42,
  addNodesOp([requestsNode]),
  flagOp(["demo-g-requests"], "attention", true),
  selectOp(["demo-g-h06", "demo-g-requests"]),
  cameraFit(["demo-g-h06", "demo-g-requests", "demo-g-tasks"], 1.5, 0.2),
  sfxOp("request"),
);
at(46, flagOp(["demo-g-h06"], "blocker", false), sfxOp("clear"));
at(48, flagOp(["demo-g-h13"], "blocker", false));
at(49, flagOp(["demo-g-requests"], "attention", false), selectOp([]));
at(50, cameraFit(undefined, 2.5, 0.16));

// Rung 6 — results land somewhere real.
at(54, addNodesOp([artifactsNode]), sfxOp("artifact"));

// Rung 7 — the second machine joins the same board.
at(62, addNodesOp([regionC]), cameraFit(undefined, 2, 0.15));
at(64, ...spawn(C[0]), ...spawn(C[1]));
at(66, ...spawn(C[2]), ...spawn(C[3]));
at(68, ...spawn(C[4]), ...spawn(C[5]));
at(70, cameraFit(undefined, 2, 0.15));

// Rung 8 — the factory hums; one last ambient block clears; slow pullback.
at(74, ...spawn(FINALE[0]), ...spawn(FINALE[1]));
at(76, ...spawn(FINALE[2]));
at(80, flagOp(["demo-g-h15"], "blocker", true));
at(82, flagOp(["demo-g-h15"], "blocker", false), sfxOp("clear"));
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
