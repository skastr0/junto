/**
 * The companion demo's data, and nothing else: the regions, seats, signals,
 * mail history, health readings and clock that `junto companion-stdio --demo`
 * serves. A wire module (effect-only closure), so another client (the in-app
 * demo transport in junto-app) can sync the same fixture instead of copying
 * it. The projections that turn it into feeds and seats live in
 * `src/shared/companion-demo.ts`.
 */

import { Result } from "effect";
import type { AgentSignal } from "./agent-signals";
import {
  emptyBody,
  ruleArtifactEdit,
  FIRST_ARTIFACT_VERSION,
  type Artifact,
  type ArtifactActor,
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactHead,
  type ArtifactVersion,
  type ArtifactVersionRecord,
} from "./artifact";
import { artifactLabelOf, type ArtifactLabel, type ArtifactLabelColour } from "./artifact-labels";
import type { ContentRef } from "./content-ref";
import type { ItemId, NodeId } from "./ids";
import { asPadElementId } from "./pad";
import type { ActorSeatId } from "./resource-actor";
import type {
  CompanionActivity,
  CompanionMachine,
  CompanionMachineLogRow,
  CompanionMachineStatus,
  CompanionMail,
  CompanionPreamble,
  CompanionTailnetPeer,
  CompanionThreadMessage,
} from "./companion-protocol";
import type { ThreadHealthValue } from "./thread-health";

export const DEMO_CANVAS = "demo";
export const DEMO_CANVAS_TITLE = "Demo";
export const DEMO_DEVICE_ID = "dev_00000000000000000000DEM000";
export const DEMO_DEVICE_NAME = "Demo phone";
export const DEMO_STATION = "Junto demo";
/** 2026-09-21T16:26:40Z. Every demo timestamp is relative to it. */
export const DEMO_T0 = 1_790_000_000_000;
const MIN = 60_000;
/** When the attention seat's dialog appeared, and the seats' last activity. */
export const DEMO_ACTIVITY_AT = DEMO_T0 - 2 * MIN;
/** When every health reading was observed (fresh at DEMO_T0). */
export const DEMO_HEALTH_OBSERVED_AT = DEMO_T0 - MIN;
export const DEMO_HEALTH_CONFIDENCE = 0.93;

export type DemoRegion = {
  readonly id: string;
  readonly label: string;
  /** Region palette preset colour. */
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export const DEMO_REGIONS: ReadonlyArray<DemoRegion> = [
  { id: "r-backend", label: "Backend", color: "4", x: 0, y: 0, width: 900, height: 700 },
  { id: "r-frontend", label: "Frontend", color: "5", x: 1000, y: 0, width: 900, height: 700 },
  { id: "r-research", label: "Research", color: "6", x: 2000, y: 0, width: 900, height: 700 },
];

/** The seat state machine's words (`AgentSeatState`). */
export type DemoControlState = "idle" | "working" | "attention" | "unknown" | "gone";

export type DemoSeat = {
  readonly id: string;
  readonly name: string;
  readonly harness: "claude" | "codex" | "amp" | "hermes";
  /** Left edge of the seat's region; the seat sits inside it. */
  readonly regionX: number;
  readonly slot: number;
  readonly control: DemoControlState;
  readonly reason?: string;
  readonly process: "running" | "starting" | "stopped";
  readonly doneUnread?: boolean;
  readonly health?: ThreadHealthValue;
};

/** Seat geometry on the canvas, inside its region. */
export const demoSeatPosition = (seat: DemoSeat): { readonly x: number; readonly y: number } => ({
  x: seat.regionX + 40 + seat.slot * 280,
  y: 120,
});

export const DEMO_SEATS: ReadonlyArray<DemoSeat> = [
  { id: "atlas", name: "Atlas", harness: "claude", regionX: 0, slot: 0, control: "idle", process: "running" },
  { id: "forge", name: "Forge", harness: "codex", regionX: 0, slot: 1, control: "attention", reason: "permission prompt", process: "running" },
  { id: "relay", name: "Relay", harness: "claude", regionX: 0, slot: 2, control: "working", process: "running", health: "going_well" },
  { id: "quill", name: "Quill", harness: "claude", regionX: 1000, slot: 0, control: "idle", process: "running" },
  { id: "prism", name: "Prism", harness: "amp", regionX: 1000, slot: 1, control: "idle", process: "running", doneUnread: true },
  { id: "ember", name: "Ember", harness: "codex", regionX: 1000, slot: 2, control: "idle", process: "running", health: "waiting_on_operator" },
  { id: "sage", name: "Sage", harness: "hermes", regionX: 2000, slot: 0, control: "working", process: "running", health: "thrashing" },
  { id: "lumen", name: "Lumen", harness: "claude", regionX: 2000, slot: 1, control: "idle", process: "stopped" },
];

/**
 * The demo's stored files: a ref and the exact UTF-8 text its digest and
 * length are of, so `content.get` serves them like any store object.
 */
export type DemoContent = { readonly ref: ContentRef; readonly text: string };

const demoContent = (sha256: string, byteLength: number, mediaType: string, displayName: string, text: string): DemoContent => ({
  ref: { sha256, byteLength, mediaType, displayName } as ContentRef,
  text,
});

export const DEMO_CONTENT_NOTES = demoContent(
  "9165917e794ecf12afe96968051d9e450272e632486a9be839646fd1449bb95e", 112, "text/markdown", "pricing-notes.md",
  "# Pricing page\n\n- Three tiers: Free, Pro, Team\n- Annual billing saves two months\n- The FAQ sits below the table\n",
);
export const DEMO_CONTENT_BEFORE = demoContent(
  "4c4e3b4d88885b5671387cd47a0efecd3e23d401efe7b3bede78d84da6b6a01a", 52, "text/html", "pricing.html",
  "<h1>Choose a plan</h1>\n<p>Monthly billing only.</p>\n",
);
export const DEMO_CONTENT_AFTER = demoContent(
  "2914dcdc5a8d893f0f463606bdef5204127ebc7a9b418e1ac627347b70d18a4d", 94, "text/html", "pricing.html",
  "<h1>Pick the plan that fits your team</h1>\n<p>Pay monthly, or yearly and save two months.</p>\n",
);
export const DEMO_CONTENT_CHECKLIST = demoContent(
  "b1f8762ba9a9795b5af7b945a9263d82f7e0ec3dc97388087a8e42524f7ede9d", 128, "text/csv", "launch-checklist.csv",
  "item,owner,done\nTier table copy,atlas,yes\nAnnual toggle screenshot,quill,no\nFAQ anchors,prism,yes\nSupport macro update,forge,no\n",
);
export const DEMO_CONTENT: ReadonlyArray<DemoContent> = [DEMO_CONTENT_NOTES, DEMO_CONTENT_BEFORE, DEMO_CONTENT_AFTER, DEMO_CONTENT_CHECKLIST];

/** A real ULID for a demo resource row: fixed time prefix, a kind tag, a sequence tail. */
export const demoItemId = (tag: "ART" | "TSK" | "THR", seq: number): string =>
  `01J9DEM0${tag}${String(seq).padStart(15, "0")}`;

/** A seat's compiled identity, as `ResourceActor` and comment authors carry one. */
export const demoSeatId = (seed: number): ActorSeatId =>
  `seat_${seed.toString(16).padStart(4, "0").repeat(16)}` as ActorSeatId;

/**
 * The resource nodes the demo canvas carries for the artifact ops (03/8):
 * the Inbox and two more Artifacts nodes, a task board and a page, so every
 * mention kind in a document resolves against a real node.
 */
export type DemoResourceNode = {
  readonly id: string;
  readonly kind: "artifacts" | "task" | "page";
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** A page node's address; only `kind: "page"` carries one. */
  readonly url?: string;
};

export const DEMO_RESOURCE_NODES: ReadonlyArray<DemoResourceNode> = [
  { id: "art-notes", kind: "artifacts", label: "Working notes", x: 40, y: 420, width: 280, height: 180 },
  { id: "page-docs", kind: "page", label: "Pricing docs", url: "https://example.com/pricing", x: 360, y: 420, width: 280, height: 180 },
  { id: "art-inbox", kind: "artifacts", label: "Inbox", x: 1040, y: 420, width: 280, height: 180 },
  { id: "task-roadmap", kind: "task", label: "Roadmap", x: 1360, y: 420, width: 240, height: 180 },
  { id: "art-launch", kind: "artifacts", label: "Launch", x: 2040, y: 420, width: 280, height: 180 },
];

/**
 * A label a demo artifact carries: the wire's canonical form, folded here at
 * the fixture's edge exactly as the ruler folds typed input. `x/y` reads as
 * a level under `x`.
 */
const demoLabel = (raw: string): ArtifactLabel => {
  const label = artifactLabelOf(raw);
  if (label === undefined) throw new Error(`demo fixture label is not canonical: ${raw}`);
  return label;
};

/**
 * The colours set in each Artifacts node, by label: a colour is a node's
 * setting, never an artifact's, and stays when no artifact carries the label.
 */
export const DEMO_ARTIFACT_LABEL_COLOURS: Readonly<Record<string, Readonly<Record<string, ArtifactLabelColour>>>> = {
  "art-inbox": { launch: "blue", "launch/pricing": "teal" },
  "art-notes": { launch: "green", review: "pink" },
  "art-launch": { launch: "orange", "launch/pricing": "purple", review: "yellow" },
};

/**
 * An artifact as the demo holds it: the wire `Artifact` head, its body at
 * head, and every version oldest first, as `artifact.history` pages it.
 * Nothing here is hand-shaped: each version is the create's body, or a real
 * `ArtifactEdit` ruled against the version before it, so the fixture cannot
 * drift from what a Mac would accept.
 */
export type DemoArtifact = {
  readonly head: Artifact;
  readonly body: ArtifactBody;
  readonly versions: ReadonlyArray<ArtifactVersionRecord>;
};

const demoArtifact = (input: {
  readonly id: string;
  readonly nodeId: string;
  readonly title: string;
  readonly createdBy: ArtifactActor;
  readonly createdAt: number;
  readonly body: ArtifactBody;
  /** One ruled edit per version after the first; each names the version it was written against. */
  readonly edits?: ReadonlyArray<{
    readonly edit: ArtifactEdit;
    readonly at: number;
    readonly by?: ArtifactActor;
  }>;
  readonly labels?: ReadonlyArray<string>;
  readonly taskIds?: ReadonlyArray<string>;
  readonly archived?: boolean;
}): DemoArtifact => {
  const artifactId = input.id as ItemId;
  let head: ArtifactHead = { version: FIRST_ARTIFACT_VERSION, body: input.body };
  const versions: ArtifactVersionRecord[] = [
    { artifactId, version: head.version, author: input.createdBy, at: input.createdAt, body: head.body },
  ];
  let updatedAt = input.createdAt;
  for (const step of input.edits ?? []) {
    const ruled = ruleArtifactEdit(head, step.edit);
    if (!Result.isSuccess(ruled)) {
      throw new Error(`demo artifact ${input.id} edit refused: ${ruled.failure.message}`);
    }
    head = { version: ruled.success.version, body: ruled.success.body };
    versions.push({ artifactId, version: head.version, author: step.by ?? input.createdBy, at: step.at, body: head.body });
    updatedAt = step.at;
  }
  const labels = (input.labels ?? []).map(demoLabel);
  return {
    head: {
      artifactId,
      nodeId: input.nodeId as NodeId,
      type: head.body.type,
      title: input.title,
      version: head.version,
      createdBy: input.createdBy,
      updatedAt,
      archived: input.archived ?? false,
      taskIds: (input.taskIds ?? []).map((taskId) => taskId as ItemId),
      labels,
    },
    body: head.body,
    versions,
  };
};

export const DEMO_ARTIFACT_PRICING_NOTES = demoItemId("ART", 1);
export const DEMO_ARTIFACT_COMPETITOR = demoItemId("ART", 2);
export const DEMO_ARTIFACT_SKETCH = demoItemId("ART", 3);
export const DEMO_ARTIFACT_ROADMAP_DRAFT = demoItemId("ART", 4);
export const DEMO_ARTIFACT_TIERS = demoItemId("ART", 5);
export const DEMO_ARTIFACT_CHECKLIST = demoItemId("ART", 6);
export const DEMO_ARTIFACT_BRAINSTORM = demoItemId("ART", 7);
export const DEMO_TASK_PRICING = demoItemId("TSK", 1);

const ATLAS = { kind: "seat", seatId: demoSeatId(1), nodeId: "atlas" as NodeId } as const;
const QUILL = { kind: "seat", seatId: demoSeatId(4), nodeId: "quill" as NodeId } as const;
const OPERATOR = { kind: "operator" } as const;

const PRICING_NOTES_V1 = `# Pricing notes\n\n[@Atlas](junto://canvas/demo?node=atlas) ran the numbers on staging.\n\nAnnual billing saves two months. The FAQ sits below the table.\n`;

/**
 * One of each type, spread over the three nodes: an Inbox document that
 * mentions a seat, a task, an artifact and a page; a link; a pad; a second
 * document; a sheet; a file; and one archived document for the archive
 * filter.
 */
export const DEMO_ARTIFACTS: ReadonlyArray<DemoArtifact> = [
  demoArtifact({
    id: DEMO_ARTIFACT_PRICING_NOTES,
    nodeId: "art-inbox",
    title: "Pricing notes",
    createdBy: ATLAS,
    createdAt: DEMO_T0 - 2 * 24 * 60 * MIN,
    body: { type: "document", markdown: PRICING_NOTES_V1 },
    edits: [
      {
        // The task and page mentions came in with the second draft.
        edit: {
          kind: "replace",
          baseVersion: 1 as ArtifactVersion,
          body: {
            type: "document",
            markdown:
              `# Pricing notes\n\n` +
              `[@Atlas](junto://canvas/demo?node=atlas) ran the numbers on staging.\n\n` +
              `- Compare against [#1 launch pricing](junto://canvas/demo?node=task-roadmap&item=${DEMO_TASK_PRICING})\n` +
              `- Screenshots live on [Pricing docs](junto://canvas/demo?node=page-docs)\n\n` +
              `Annual billing saves two months. The FAQ sits below the table.\n`,
          },
        },
        at: DEMO_T0 - 45 * MIN,
        by: ATLAS,
      },
      {
        // A splice against the head: the draft's link to the roadmap doc.
        edit: {
          kind: "patch",
          type: "document",
          baseVersion: 2 as ArtifactVersion,
          patches: [
            {
              op: "splice",
              at: PRICING_NOTES_V1.indexOf("Annual billing"),
              remove: 0,
              insert: `- Keep it in step with [Roadmap draft](junto://canvas/demo?node=art-notes&item=${DEMO_ARTIFACT_ROADMAP_DRAFT})\n`,
            },
          ],
        },
        at: DEMO_T0 - 35 * MIN,
      },
    ],
    labels: ["launch", "launch/pricing"],
    taskIds: [DEMO_TASK_PRICING],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_COMPETITOR,
    nodeId: "art-inbox",
    title: "Competitor pricing",
    createdBy: OPERATOR,
    createdAt: DEMO_T0 - 30 * 60 * 1000,
    body: { type: "link", target: { kind: "url", url: "https://example.com/pricing" } },
    labels: ["launch/pricing"],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_SKETCH,
    nodeId: "art-notes",
    title: "Onboarding sketch",
    createdBy: QUILL,
    createdAt: DEMO_T0 - 3 * 24 * 60 * MIN,
    body: emptyBody("pad"),
    edits: [
      {
        edit: {
          kind: "patch",
          type: "pad",
          baseVersion: 1 as ArtifactVersion,
          patches: [
            {
              op: "upsert",
              layer: "shape",
              shape: { id: asPadElementId("s-inbox"), type: "box", x: 20, y: 30, w: 120, h: 80, z: 1, stroke: "#4a90d9" },
            },
            {
              op: "upsert",
              layer: "shape",
              shape: { id: asPadElementId("s-feed"), type: "box", x: 180, y: 60, w: 120, h: 80, z: 2, stroke: "#4a90d9" },
            },
          ],
        },
        at: DEMO_T0 - 2 * 24 * 60 * MIN,
        by: QUILL,
      },
      {
        edit: {
          kind: "patch",
          type: "pad",
          baseVersion: 2 as ArtifactVersion,
          patches: [
            {
              op: "upsert",
              layer: "edge",
              edge: { id: asPadElementId("e-flow"), from: asPadElementId("s-inbox"), to: asPadElementId("s-feed") },
            },
            {
              op: "upsert",
              layer: "shape",
              shape: {
                id: asPadElementId("s-atlas"),
                type: "card",
                x: 180,
                y: 150,
                w: 120,
                h: 48,
                z: 3,
                href: "junto://canvas/demo?node=atlas",
                label: "Atlas",
              },
            },
          ],
        },
        at: DEMO_T0 - 3 * 60 * MIN,
      },
      {
        edit: {
          kind: "patch",
          type: "pad",
          baseVersion: 3 as ArtifactVersion,
          patches: [
            {
              op: "upsert",
              layer: "ink",
              ink: {
                id: asPadElementId("i-check"),
                z: 4,
                color: "#e07b39",
                width: 3,
                points: [
                  { x: 40, y: 130 },
                  { x: 60, y: 145 },
                  { x: 95, y: 115 },
                ],
              },
            },
          ],
        },
        at: DEMO_T0 - 90 * MIN,
        by: QUILL,
      },
    ],
    labels: ["review"],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_ROADMAP_DRAFT,
    nodeId: "art-notes",
    title: "Roadmap draft",
    createdBy: ATLAS,
    createdAt: DEMO_T0 - 4 * 24 * 60 * MIN,
    body: { type: "document", markdown: `# Roadmap draft\n\n- Launch pricing lands first\n- The inbox workflow follows\n` },
    edits: [
      {
        edit: {
          kind: "replace",
          baseVersion: 1 as ArtifactVersion,
          body: {
            type: "document",
            markdown: `# Roadmap draft\n\n- Launch pricing lands first\n- The inbox workflow follows\n- Automations pick up the weekly digest\n`,
          },
        },
        at: DEMO_T0 - 5 * MIN,
      },
    ],
    labels: ["launch"],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_TIERS,
    nodeId: "art-launch",
    title: "Tier comparison",
    createdBy: OPERATOR,
    createdAt: DEMO_T0 - 5 * 24 * 60 * MIN,
    body: emptyBody("sheet"),
    edits: [
      {
        edit: {
          kind: "patch",
          type: "sheet",
          baseVersion: 1 as ArtifactVersion,
          patches: [
            { op: "column.rename", columnId: "c1", name: "tier" },
            { op: "column.rename", columnId: "c2", name: "price" },
            { op: "column.add", columnId: "c3", name: "seats" },
          ],
        },
        at: DEMO_T0 - 5 * 24 * 60 * MIN + MIN,
      },
      { edit: { kind: "patch", type: "sheet", baseVersion: 2 as ArtifactVersion, patches: [{ op: "cell", rowId: "r1", columnId: "c1", value: "Free" }, { op: "cell", rowId: "r1", columnId: "c2", value: "0" }, { op: "cell", rowId: "r1", columnId: "c3", value: "1" }] }, at: DEMO_T0 - 4 * 24 * 60 * MIN },
      { edit: { kind: "patch", type: "sheet", baseVersion: 3 as ArtifactVersion, patches: [{ op: "row.add", rowId: "r2" }, { op: "cell", rowId: "r2", columnId: "c1", value: "Pro" }, { op: "cell", rowId: "r2", columnId: "c2", value: "12" }, { op: "cell", rowId: "r2", columnId: "c3", value: "5" }] }, at: DEMO_T0 - 3 * 24 * 60 * MIN },
      { edit: { kind: "patch", type: "sheet", baseVersion: 4 as ArtifactVersion, patches: [{ op: "row.add", rowId: "r3" }, { op: "cell", rowId: "r3", columnId: "c1", value: "Team" }, { op: "cell", rowId: "r3", columnId: "c2", value: "24" }, { op: "cell", rowId: "r3", columnId: "c3", value: "25" }] }, at: DEMO_T0 - 2 * 60 * MIN },
      { edit: { kind: "patch", type: "sheet", baseVersion: 5 as ArtifactVersion, patches: [{ op: "cell", rowId: "r2", columnId: "c2", value: "12" }] }, at: DEMO_T0 - 60 * MIN },
    ],
    labels: ["launch/pricing"],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_CHECKLIST,
    nodeId: "art-launch",
    title: "Launch checklist",
    createdBy: OPERATOR,
    createdAt: DEMO_T0 - 26 * 60 * 1000,
    body: { type: "file", content: DEMO_CONTENT_CHECKLIST.ref },
    labels: ["launch", "review"],
  }),
  demoArtifact({
    id: DEMO_ARTIFACT_BRAINSTORM,
    nodeId: "art-notes",
    title: "Old brainstorm",
    createdBy: ATLAS,
    createdAt: DEMO_T0 - 9 * 24 * 60 * MIN,
    body: { type: "document", markdown: `# Old brainstorm\n\nIdeas that did not make the cut.\n` },
    labels: [],
    archived: true,
  }),
];

/** One post in a demo artifact thread: who wrote it and when. */
export type DemoThreadPost = {
  readonly postId: string;
  readonly from:
    | { readonly kind: "operator" }
    | { readonly kind: "seat"; readonly seatId: ActorSeatId; readonly nodeId: string; readonly name: string };
  readonly at: number;
  readonly text: string;
};

/** A comment thread on an artifact, with the anchor it hangs on. */
export type DemoArtifactThread = {
  readonly threadId: string;
  readonly artifactId: string;
  readonly anchor: { readonly kind: "text"; readonly quote: string };
  readonly posts: ReadonlyArray<DemoThreadPost>;
};

export const DEMO_ARTIFACT_THREADS: ReadonlyArray<DemoArtifactThread> = [
  {
    threadId: demoItemId("THR", 1),
    artifactId: DEMO_ARTIFACT_PRICING_NOTES,
    anchor: { kind: "text", quote: "Annual billing saves two months." },
    posts: [
      { postId: demoItemId("THR", 2), from: { kind: "seat", seatId: demoSeatId(4), nodeId: "quill", name: "Quill" }, at: DEMO_T0 - 33 * MIN, text: "Is the two months before or after the launch discount?" },
      { postId: demoItemId("THR", 3), from: { kind: "operator" }, at: DEMO_T0 - 31 * MIN, text: "After. It stacks on whatever the launch price is." },
    ],
  },
];

/** One demo machine: what `machines.list` lists, and what `machine.get` reads from it. */
export type DemoMachine = {
  readonly machine: CompanionMachine;
  readonly status: CompanionMachineStatus;
  readonly logs: ReadonlyArray<CompanionMachineLogRow> | string;
};

const demoLog = (minutesAgo: number, level: CompanionMachineLogRow["level"], area: string, message: string, extra: Partial<CompanionMachineLogRow> = {}): CompanionMachineLogRow => ({
  time: new Date(DEMO_T0 - minutesAgo * MIN).toISOString(),
  level,
  area,
  message,
  ...extra,
});

const harnesses: CompanionMachineStatus["harnesses"] = [
  { harness: "claude", installed: true },
  { harness: "codex", installed: true, signIn: "sign-in-unverified" },
];

/** Every state the machines tab shows: this Mac, ready, unreachable, needing an update, not set up. */
export const DEMO_MACHINES: ReadonlyArray<DemoMachine> = [
  {
    machine: { name: "macbook", label: "MacBook Pro", thisMachine: true, form: "macbook", setUp: true, needsUpdate: false, tailnet: "online", lastCheck: { checkedAgoMs: MIN, reachable: true } },
    status: { reachable: true, build: "3f9c2a7d1e04", keychain: "available", harnesses, missingSecrets: [] },
    logs: [
      demoLog(30, "info", "link", "link opened", { canvas: "demo" }),
      demoLog(12, "warn", "seat", "seat waited on the staging password", { canvas: "demo", seat: "atlas" }),
      demoLog(2, "info", "companion", "phone connected"),
    ],
  },
  {
    machine: { name: "mini", label: "Mac mini", thisMachine: false, form: "mac-mini", setUp: true, needsUpdate: false, tailnet: "online", lastCheck: { checkedAgoMs: 4 * MIN, reachable: true } },
    status: { reachable: true, keychain: "available", harnesses, missingSecrets: ["OPENAI_API_KEY"] },
    logs: [
      demoLog(40, "info", "link", "link opened"),
      demoLog(9, "error", "seat", "the seat could not start", { canvas: "demo", seat: "relay", failure: { tag: "HarnessNotSignedIn", message: "codex is not signed in on this machine" } }),
      demoLog(3, "info", "seat", "seat started", { canvas: "demo", seat: "relay" }),
    ],
  },
  {
    machine: { name: "build-box", label: "Build box", thisMachine: false, form: "linux", setUp: true, needsUpdate: false, tailnet: "offline",
      lastCheck: { checkedAgoMs: 18 * MIN, reachable: false, failure: { tag: "SshConnectTimeout", message: "build-box did not answer over SSH within 10 seconds" } } },
    status: { reachable: false, harnesses: [], missingSecrets: [], detail: "build-box did not answer over SSH within 10 seconds",
      failure: { tag: "SshConnectTimeout", message: "build-box did not answer over SSH within 10 seconds" } },
    logs: "This machine could not be reached, so its log could not be read.",
  },
  {
    machine: { name: "studio", label: "Mac Studio", thisMachine: false, form: "mac-studio", setUp: true, needsUpdate: true, tailnet: "online" },
    status: { reachable: true, harnesses: [], missingSecrets: [], detail: "Update Junto on this machine" },
    logs: "This machine's log could not be read.",
  },
  {
    machine: { name: "spare", label: "Spare laptop", thisMachine: false, setUp: false, needsUpdate: false, tailnet: "unknown" },
    status: { reachable: false, harnesses: [], missingSecrets: [], detail: "Set up this machine first" },
    logs: "Set up this machine to read its log.",
  },
];

/** The demo tailnet: three machines already, and devices that are not. */
export const DEMO_TAILNET: ReadonlyArray<CompanionTailnetPeer> = [
  { name: "mini", dnsName: "mini.tail1234.ts.net", os: "macOS", online: true, machine: "mini" },
  { name: "build-box", dnsName: "build-box.tail1234.ts.net", os: "linux", online: false, machine: "build-box" },
  { name: "studio", dnsName: "studio.tail1234.ts.net", os: "macOS", online: true, machine: "studio" },
  { name: "nas", dnsName: "nas.tail1234.ts.net", os: "linux", online: true },
  { name: "operators-iphone", dnsName: "operators-iphone.tail1234.ts.net", os: "iOS", online: true },
];

export const DEMO_SIGNALS: ReadonlyArray<AgentSignal> = [
  {
    signalId: "sig_demo_blocked",
    canvasName: DEMO_CANVAS,
    nodeId: "atlas",
    kind: "blocked",
    text: "Need the staging database password to run the migration.",
    detail: "The migration step reads `STAGING_DB_URL`. It is not set in this shell.",
    createdAt: DEMO_T0 - 12 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_escalate",
    canvasName: DEMO_CANVAS,
    nodeId: "quill",
    kind: "escalate",
    text: "Should the empty state use the illustration or plain text?",
    createdAt: DEMO_T0 - 7 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_feedback",
    canvasName: DEMO_CANVAS,
    nodeId: "prism",
    kind: "feedback",
    text: "The pricing page is ready for review.",
    detail: "- New tier table\n- Annual toggle\n- FAQ moved below the fold",
    attachments: [
      { ref: DEMO_CONTENT_NOTES.ref, caption: "What changed" },
      { kind: "compare", before: DEMO_CONTENT_BEFORE.ref, after: DEMO_CONTENT_AFTER.ref, name: "pricing.html" },
    ],
    createdAt: DEMO_T0 - 3 * MIN,
    state: "open",
  },
  {
    signalId: "sig_demo_writeup",
    canvasName: DEMO_CANVAS,
    nodeId: "sage",
    kind: "work",
    text: "Write the launch pricing rationale.",
    detail: "One page: who pays, what it replaces, the risk of a two-tier launch.",
    form: { kind: "artifact", nodeId: "art-inbox", title: "Launch pricing rationale", labels: ["launch"], minWords: 40 },
    createdAt: DEMO_T0 - 6 * MIN,
    state: "open",
  },
];

/** Mail as the demo stores it; the canvas name is added on the way out. */
export type DemoMail = Omit<CompanionMail, "canvasName">;

export const DEMO_MAIL: ReadonlyArray<DemoMail> = [
  { messageId: "01J9DEMOMAIL0000000000000A1", nodeId: "atlas", direction: "to_seat", from: { kind: "operator" }, text: "Run the schema migration against staging.", at: DEMO_T0 - 40 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A2", nodeId: "atlas", direction: "to_seat", from: { kind: "seat", nodeId: "relay", name: "Relay" }, text: "The API tests pass on my branch.", at: DEMO_T0 - 25 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000A3", nodeId: "atlas", direction: "from_seat", from: { kind: "seat", nodeId: "atlas", name: "Atlas" }, text: "Relay, hold the deploy until the migration lands.", at: DEMO_T0 - 20 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000B1", nodeId: "quill", direction: "to_seat", from: { kind: "operator" }, text: "Design the empty state for the inbox.", at: DEMO_T0 - 30 * MIN, delivery: "delivered" },
  { messageId: "01J9DEMOMAIL0000000000000C1", nodeId: "lumen", direction: "to_seat", from: { kind: "operator" }, text: "Summarize the three papers when you are back.", at: DEMO_T0 - 5 * MIN, delivery: "waiting_for_seat" },
];

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A real ULID for demo mail: its time is `at`, its tail a fixed tag and sequence. */
export const demoMailId = (at: number, tag: "D3M0" | "SENT", seq: number): string => {
  let time = "";
  let rest = Math.max(0, Math.floor(at));
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  return `${time}${tag}${String(seq).padStart(12, "0")}`;
};

/** Agent seats wired to each other on the demo canvas: who a mail may mention. */
/** The demo canvas's wires: Atlas to Relay runs past Forge, so its route bends round it. */
export type DemoWire = { readonly id: string; readonly from: string; readonly to: string; readonly verb: "messages" };
export const DEMO_WIRES: ReadonlyArray<DemoWire> = [
  { id: "w-atlas-relay", from: "atlas", to: "relay", verb: "messages" },
  { id: "w-relay-quill", from: "relay", to: "quill", verb: "messages" },
  { id: "w-quill-prism", from: "quill", to: "prism", verb: "messages" },
];

export const DEMO_CONNECTED: Readonly<Record<string, ReadonlyArray<string>>> = {
  atlas: ["relay"],
  relay: ["atlas"],
};

const OP = { kind: "operator" } as const;
const seatParty = (nodeId: string, name: string) => ({ kind: "seat", nodeId, name }) as const;
const THREAD_A = demoMailId(DEMO_T0 - 40 * MIN, "D3M0", 1);
const THREAD_B = demoMailId(DEMO_T0 - 30 * MIN, "D3M0", 4);

/** Thread mail, oldest first: operator mail, seat replies to it, and seat mail in its threads. */
export const DEMO_THREAD_MAIL: ReadonlyArray<CompanionThreadMessage> = [
  { messageId: THREAD_A, threadId: THREAD_A, from: OP, to: [seatParty("atlas", "Atlas")], mine: true, text: "Run the schema migration against staging.\nUse the rollback script if the dry run fails.", at: DEMO_T0 - 40 * MIN },
  { messageId: demoMailId(DEMO_T0 - 15 * MIN, "D3M0", 2), threadId: THREAD_A, inReplyTo: THREAD_A, from: seatParty("atlas", "Atlas"), to: [OP], mine: false, text: "Dry run passed. Waiting on the staging password before the real run.", at: DEMO_T0 - 15 * MIN },
  { messageId: demoMailId(DEMO_T0 - 12 * MIN, "D3M0", 3), threadId: THREAD_A, from: seatParty("relay", "Relay"), to: [seatParty("atlas", "Atlas")], mine: false, text: "The API tests pass on my branch. I will hold the deploy until the migration lands.", at: DEMO_T0 - 12 * MIN },
  { messageId: THREAD_B, threadId: THREAD_B, from: OP, to: [seatParty("quill", "Quill")], mine: true, text: "Design the empty state for the inbox.", at: DEMO_T0 - 30 * MIN },
  { messageId: demoMailId(DEMO_T0 - 8 * MIN, "D3M0", 5), threadId: THREAD_B, inReplyTo: THREAD_B, from: seatParty("quill", "Quill"), to: [OP], mine: false, text: "Two drafts are in the inbox folder. Warm or plain?", at: DEMO_T0 - 8 * MIN },
];

export const DEMO_QUICK_REPLIES: ReadonlyArray<string> = ["Yes, go ahead.", "No, stop here.", "Use your judgment.", "I'll look at it shortly."];
export const DEMO_QUIET_NOTES: ReadonlyArray<string> = ["Acknowledged", "Good"];

/** Region briefings, markdown, as the region's kind strip holds them. */
export const DEMO_BRIEFINGS: Readonly<Record<string, string>> = {
  "r-backend": "Ship the billing migration this week.\n\n- Staging first, then production\n- No schema change without a rollback script",
  "r-frontend": "Pricing and inbox polish for the launch.",
};

/** Live notes per seat, newest first. Every one is still live at DEMO_T0. */
export const DEMO_PREAMBLES: Readonly<Record<string, ReadonlyArray<CompanionPreamble>>> = {
  atlas: [
    { preambleId: "pre_demo_atlas_2", text: "Waiting on the staging password before the migration.", source: "agent", at: DEMO_T0 - 11 * MIN, expiresAt: DEMO_T0 + 30 * MIN },
    { preambleId: "pre_demo_atlas_1", text: "Dry run of the migration passed.", source: "junto", at: DEMO_T0 - 15 * MIN, expiresAt: DEMO_T0 + 20 * MIN },
  ],
  relay: [
    { preambleId: "pre_demo_relay_1", text: "Running the API test suite.", source: "agent", at: DEMO_T0 - 2 * MIN, expiresAt: DEMO_T0 + 10 * MIN },
  ],
  sage: [
    { preambleId: "pre_demo_sage_1", text: "Retrying the same search with small changes.", source: "ai", at: DEMO_T0 - MIN, expiresAt: DEMO_T0 + 5 * MIN },
  ],
};

/** The seat sidebar's Activity, per seat, newest first. */
export const DEMO_ACTIVITY: Readonly<Record<string, ReadonlyArray<CompanionActivity>>> = {
  atlas: [
    { at: DEMO_T0 - 12 * MIN, label: "raised blocked", kind: "signal" },
    { at: DEMO_T0 - 20 * MIN, label: "sent mail", kind: "mail", targetName: "Relay" },
    { at: DEMO_T0 - 25 * MIN, label: "got mail", kind: "mail", targetName: "Relay" },
    { at: DEMO_T0 - 40 * MIN, label: "started working", kind: "state" },
  ],
  forge: [{ at: DEMO_T0 - 2 * MIN, label: "asked for permission", kind: "state" }],
  relay: [
    { at: DEMO_T0 - 2 * MIN, label: "started working", kind: "state" },
    { at: DEMO_T0 - 25 * MIN, label: "sent mail", kind: "mail", targetName: "Atlas" },
  ],
  quill: [{ at: DEMO_T0 - 7 * MIN, label: "raised escalate", kind: "signal" }],
  prism: [
    { at: DEMO_T0 - 3 * MIN, label: "raised feedback", kind: "signal" },
    { at: DEMO_T0 - 4 * MIN, label: "finished", kind: "state" },
  ],
  lumen: [{ at: DEMO_T0 - 30 * MIN, label: "stopped", kind: "state" }],
};
