// Trailer scenario for the Vellum Command demo engine — active ONLY under
// --vellum-demo / VELLUM_COMMAND_DEMO=1 (see @shared/demo). This file is a pure data
// builder: fixed deterministic ids, no ulid, no Math.random, no runtime
// framework. It must not import anything beyond @shared/demo + @shared/canvas.

import type { CanvasEdge, CanvasNode, EtherFlag, GroupNode, TextNode } from "@shared/canvas";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";

// --- small deterministic helpers --------------------------------------------

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

// Golden-angle spiral layout, index-based, fully deterministic.
const pos = (i: number): { readonly x: number; readonly y: number } => ({
  x: 200 + Math.round(340 * Math.sqrt(i + 1) * Math.cos(i * 2.399963)),
  y: Math.round(340 * Math.sqrt(i + 1) * Math.sin(i * 2.399963)),
});

// Front-loaded chunk sizes across a fixed number of slots — e.g. 6 items over
// 4 slots -> [2, 2, 1, 1]; 22 items over 7 slots -> [4, 3, 3, 3, 3, 3, 3].
const chunkFrontLoaded = <T>(items: readonly T[], slots: number): T[][] => {
  const sizes: number[] = [];
  let remaining = items.length;
  let slotsLeft = slots;
  while (slotsLeft > 0) {
    const size = Math.ceil(remaining / slotsLeft);
    sizes.push(size);
    remaining -= size;
    slotsLeft -= 1;
  }
  const chunks: T[][] = [];
  let idx = 0;
  for (const size of sizes) {
    chunks.push(items.slice(idx, idx + size));
    idx += size;
  }
  return chunks;
};

// --- beat accumulator ---------------------------------------------------------
// Exactly one DemoBeat per distinct `.at` — ops sharing a beat are merged here.

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
const addEdgesOp = (edges: readonly CanvasEdge[]): DemoOp => ({ kind: "add-edges", edges });

const cameraFit = (
  nodeIds: readonly string[] | undefined,
  durationBeats: number,
  padding?: number,
  maxZoom?: number,
): DemoOp => ({ kind: "camera-fit", nodeIds, durationBeats, padding, maxZoom });

const cameraCenter = (x: number, y: number, durationBeats: number, zoom?: number): DemoOp => ({
  kind: "camera-center",
  x,
  y,
  zoom,
  durationBeats,
});

const flagOp = (nodeIds: readonly string[], flag: EtherFlag, on: boolean): DemoOp => ({
  kind: "flag",
  nodeIds,
  flag,
  on,
});

const selectOp = (nodeIds: readonly string[]): DemoOp => ({ kind: "select", nodeIds });
const sfxOp = (id: string): DemoOp => ({ kind: "sfx", id });
const hudOp = (show: boolean): DemoOp => ({ kind: "hud", show });

/**
 * A wire carries exactly one authored word, and only for a pair the grammar
 * admits (VERB_TABLE). The crew are terminal cards and terminal admits no
 * verb, so the only wire this film can hold is the queue handing work to the
 * one agent seat — a verb-less or terminal-touching edge would paint during
 * the take and then be dropped by the next decode.
 */
type EdgeVerb = NonNullable<CanvasEdge["ether"]>["verb"];

const mkEdge = (
  id: string,
  fromNode: string,
  toNode: string,
  verb: EdgeVerb,
): CanvasEdge => ({
  id,
  fromNode,
  toNode,
  ether: { verb },
});

const smallTextNode = (id: string, text: string, x: number, y: number): TextNode => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 200,
  height: 72,
});

// --- crew fleet ----------------------------------------------------------------

const AGENTS = ["claude", "codex", "kimi", "opencode", "hermes"] as const;
const SHORT_TASKS = [
  "ship ssh kernel",
  "regen sfx",
  "node shell chrome",
  "avatar library",
  "kernel cycle",
  "typecheck pass",
  "canvas sync",
  "release notes",
] as const;
const SHOWER_TEXTS = [
  "lint green",
  "pr #214",
  "canvas sync",
  "kernel tick",
  "review pass",
  "signal: forge",
  "watcher fire",
  "edge: blocks",
  "mirror fresh",
  "pane split",
  "typecheck 0",
  "vitest green",
] as const;

interface CrewSpec {
  readonly id: string;
  readonly n: number;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly shortTask: string;
  readonly label: string;
}

const crewSpec = (n: number): CrewSpec => {
  const agent = AGENTS[(n - 1) % AGENTS.length];
  const shortTask = SHORT_TASKS[(n - 1) % SHORT_TASKS.length];
  const nn = pad(n, 2);
  return {
    id: `demo-h${nn}`,
    n,
    host: n % 2 === 1 ? "local" : "mac_mini",
    paneId: `w1:p${nn}`,
    terminalId: `term-p${nn}`,
    agent,
    shortTask,
    label: `${agent} - ${shortTask}`,
  };
};

const CREW: readonly CrewSpec[] = Array.from({ length: 36 }, (_, i) => crewSpec(i + 1));
const h = (n: number): CrewSpec => CREW[n - 1];

const crewNode = (spec: CrewSpec): TextNode => {
  const { x, y } = pos(spec.n - 1);
  return {
    id: spec.id,
    type: "text",
    text: spec.label,
    x,
    y,
    width: 260,
    height: 110,
    ether: {
      entity: { kind: "terminal" },
      host: spec.host,
      terminal: { bindingId: spec.terminalId, label: spec.label },
    },
  };
};

/** Cleared: the seat's blocker flag comes off. */
const workingOp = (spec: CrewSpec): DemoOp => flagOp([spec.id], "blocker", false);

// Blocked ordering is tracked as it is authored (source order == beat order
// below) so the "10 blocked" camera-fit and the beat-66 "select all blocked"
// can be derived instead of hand-counted.
const blockedOrder: string[] = [];
const blockOp = (spec: CrewSpec): DemoOp => {
  blockedOrder.push(spec.id);
  return flagOp([spec.id], "blocker", true);
};

// Spawn a contiguous slice of the fleet across beat slots, front-loaded.
const spawnFleetStaggered = (
  specs: readonly CrewSpec[],
  beats: readonly number[],
): void => {
  const chunks = chunkFrontLoaded(specs, beats.length);
  chunks.forEach((chunk, i) => {
    if (chunk.length === 0) return;
    at(beats[i], addNodesOp(chunk.map(crewNode)));
  });
};

// --- shower / finale text batches ----------------------------------------------

const showerBatch = (startIdx: number, count: number): CanvasNode[] =>
  Array.from({ length: count }, (_, k) => {
    const i = startIdx + k;
    const text = SHOWER_TEXTS[i % SHOWER_TEXTS.length];
    const { x, y } = pos(30 + i);
    return smallTextNode(`demo-s${pad(i + 1, 2)}`, text, x, y);
  });

const finaleBatch = (startIdx: number, count: number): CanvasNode[] =>
  Array.from({ length: count }, (_, k) => {
    const i = startIdx + k;
    const text = SHOWER_TEXTS[i % SHOWER_TEXTS.length];
    const { x, y } = pos(70 + i);
    return smallTextNode(`demo-f${pad(i + 1, 3)}`, text, x, y);
  });

// --- fixed set-piece nodes -------------------------------------------------------

const demoT1: TextNode = {
  id: "demo-t1",
  type: "text",
  text: "v1 release",
  x: 0,
  y: 0,
  width: 240,
  height: 100,
};

const demoT2: TextNode = {
  id: "demo-t2",
  type: "text",
  text: "trailer shot list",
  x: 320,
  y: -40,
  width: 240,
  height: 100,
};

const demoRegion: GroupNode = {
  id: "demo-region",
  type: "group",
  label: "release ops",
  x: -120,
  y: -160,
  width: 900,
  height: 520,
};

const demoTask: TextNode = {
  id: "demo-task",
  type: "text",
  text: "record trailer\ncut soundtrack\nship v1",
  x: 60,
  y: 180,
  width: 260,
  height: 160,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [
        {
          id: "demo-task-i1",
          state: "submitted",
          history: [
            {
              messageId: "demo-msg-1",
              role: "user",
              parts: [{ kind: "text", text: "record trailer" }],
              taskId: "demo-task-i1",
              contextId: "release ops",
            },
          ],
        },
        {
          id: "demo-task-i2",
          state: "submitted",
          history: [
            {
              messageId: "demo-msg-2",
              role: "user",
              parts: [{ kind: "text", text: "cut soundtrack" }],
              taskId: "demo-task-i2",
              contextId: "release ops",
            },
          ],
        },
        {
          id: "demo-task-i3",
          state: "submitted",
          history: [
            {
              messageId: "demo-msg-3",
              role: "user",
              parts: [{ kind: "text", text: "ship v1" }],
              taskId: "demo-task-i3",
              contextId: "release ops",
            },
          ],
        },
      ],
    },
  },
};

const demoT3: TextNode = {
  id: "demo-t3",
  type: "text",
  text: "soundtrack — 110 bpm",
  x: -60,
  y: 320,
  width: 240,
  height: 100,
};

const demoAgent: TextNode = {
  id: "demo-agent",
  type: "text",
  text: "PROFILE-13",
  x: 420,
  y: 160,
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent", name: "local:profile-13" } },
};

// --- beat map --------------------------------------------------------------------

at(0, hudOp(false), cameraCenter(120, 50, 0, 1.35), addNodesOp([demoT1]));
at(2, cameraCenter(160, 30, 6, 1.28));
at(4, addNodesOp([demoT2]));
at(8, addNodesOp([demoRegion]), cameraFit(["demo-region"], 4, 0.18));
at(12, addNodesOp([demoTask]));
at(14, addNodesOp([demoT3]));
at(
  16,
  addNodesOp([demoAgent]),
  addEdgesOp([mkEdge("demo-e1", "demo-task", "demo-agent", "works")]),
  cameraFit(["demo-task", "demo-agent"], 3),
);
at(20, cameraCenter(420, 160, 4, 1.2));

// h01: the first crew card lands. Terminal cards take no wire.
at(24, addNodesOp([crewNode(h(1))]));
at(26, cameraFit(["demo-agent", "demo-h01"], 2));

// h02 / h03 — spawn straight into working.
at(28, addNodesOp([crewNode(h(2))]));
at(28.5, addNodesOp([crewNode(h(3))]));

// h04..h06, one per beat.
spawnFleetStaggered(CREW.slice(3, 6), [30, 30.5, 31]);

// h07..h10, one per half-beat; camera pulls back to frame the fleet forming.
at(32, cameraFit(undefined, 4));
spawnFleetStaggered(CREW.slice(6, 10), [32, 32.5, 33, 33.5]);

// h11..h16, two per beat.
at(36, addNodesOp([crewNode(h(11)), crewNode(h(12))]));
at(37, addNodesOp([crewNode(h(13)), crewNode(h(14))]));
at(
  38,
  addNodesOp([crewNode(h(15)), crewNode(h(16))]),
);

// h17..h24, staggered on 8th notes.
at(40, cameraFit(undefined, 4));
spawnFleetStaggered(CREW.slice(16, 24), [40, 40.5, 41, 41.5, 42, 42.5, 43, 43.5]);

// Long pullback + shower batches, with two early "done" beats mixed in.
at(44, cameraFit(undefined, 8));
const showerBeats = [44, 46, 48, 50];
showerBeats.forEach((beat, i) => {
  at(beat, addNodesOp(showerBatch(i * 10, 10)));
});

// Blocker storm.
at(52, blockOp(h(7)), cameraFit(["demo-h07"], 1, undefined, 1.6));
at(
  54,
  blockOp(h(13)),
  blockOp(h(2)),
  flagOp(["demo-s03", "demo-s07"], "blocker", true),
  cameraFit(["demo-h13", "demo-h02"], 2),
);
at(
  56,
  blockOp(h(19)),
  blockOp(h(5)),
  blockOp(h(22)),
  cameraFit(["demo-h19", "demo-h05", "demo-h22"], 2),
);
at(58, flagOp(["demo-task"], "blocker", true), cameraFit(["demo-task"], 2));
at(60, blockOp(h(9)), blockOp(h(16)), cameraFit(undefined, 4));
at(64, blockOp(h(3)), sfxOp("cycle"));
at(64.5, blockOp(h(11)));
// Snapshot right after h11 — the ten ids the beat-64 camera-fit frames,
// deliberately ahead of h20 (blocked one beat later, at 65).
const tenBlocked = [...blockedOrder];
at(64, cameraFit(tenBlocked, 2));
at(65, blockOp(h(20)));
at(66, selectOp([...blockedOrder].sort()));

// Recovery.
at(68, workingOp(h(7)), workingOp(h(2)));
at(69, workingOp(h(13)), workingOp(h(19)));
at(
  70,
  workingOp(h(5)),
  workingOp(h(22)),
  workingOp(h(9)),
  workingOp(h(16)),
  flagOp(["demo-task", "demo-s03", "demo-s07"], "blocker", false),
);
at(71, workingOp(h(3)), workingOp(h(11)), workingOp(h(20)));

// Done wave, part 1 + 2.
at(72, cameraFit(undefined, 4));



// Finale: twelve beats of shower text, three fresh crew batches, two pullbacks.
const finaleBeats = [76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87];
finaleBeats.forEach((beat, i) => {
  at(beat, addNodesOp(finaleBatch(i * 10, 10)));
});
at(76, cameraFit(undefined, 8));
spawnFleetStaggered(CREW.slice(24, 28), [76]);
spawnFleetStaggered(CREW.slice(28, 32), [80]);
at(84, cameraFit(undefined, 8));
spawnFleetStaggered(CREW.slice(32, 36), [84]);

// Final done sweep across everything still running.


at(92, cameraCenter(300, 60, 8, 0.55));
at(100, cameraFit(["demo-region", "demo-task", "demo-agent", "demo-h01"], 6));
at(106, selectOp([]));
at(110, hudOp(true));

const beats: DemoBeat[] = Array.from(beatOps.entries())
  .sort((a, b) => a[0] - b[0])
  .map(([beatAt, ops]) => ({ at: beatAt, ops }));

// --- dev-only sanity assertions ---------------------------------------------
// No runtime framework: a plain module-scope check, skipped in production
// builds. `process` is only referenced for its ambient @types/node typing —
// the typeof guard keeps this safe even where `process` does not exist.

const isDev = typeof process === "undefined" || process.env.NODE_ENV !== "production";

if (isDev) {
  const seenBeats = new Set<number>();
  const knownNodeIds = new Set<string>();
  for (const beat of beats) {
    if (seenBeats.has(beat.at)) {
      throw new Error(`trailer-60: duplicate beat at=${beat.at}`);
    }
    seenBeats.add(beat.at);

    for (const op of beat.ops) {
      if (op.kind === "add-nodes") {
        for (const node of op.nodes) knownNodeIds.add(node.id);
        continue;
      }
      if (op.kind === "add-edges") {
        for (const edge of op.edges) {
          if (!knownNodeIds.has(edge.fromNode)) {
            throw new Error(
              `trailer-60: edge ${edge.id} references unknown fromNode ${edge.fromNode} at beat ${beat.at}`,
            );
          }
          if (!knownNodeIds.has(edge.toNode)) {
            throw new Error(
              `trailer-60: edge ${edge.id} references unknown toNode ${edge.toNode} at beat ${beat.at}`,
            );
          }
        }
        continue;
      }
      if (op.kind === "flag") {
        for (const id of op.nodeIds) {
          if (!knownNodeIds.has(id)) {
            throw new Error(`trailer-60: flag references unknown node ${id} at beat ${beat.at}`);
          }
        }
        continue;
      }
      if (op.kind === "select") {
        for (const id of op.nodeIds) {
          if (!knownNodeIds.has(id)) {
            throw new Error(
              `trailer-60: select references unknown node ${id} at beat ${beat.at}`,
            );
          }
        }
        continue;
      }
      if (op.kind === "camera-fit" && op.nodeIds) {
        for (const id of op.nodeIds) {
          if (!knownNodeIds.has(id)) {
            throw new Error(
              `trailer-60: camera-fit references unknown node ${id} at beat ${beat.at}`,
            );
          }
        }
      }
    }
  }
}

export const trailer60: DemoScenario = {
  id: "trailer-60",
  title: "Vellum Command — 60s trailer",
  bpm: 110,
  beats,
};
