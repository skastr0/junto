/**
 * Vellum Command documentation catalog — the CLI as the infinite knowledge
 * base. The injected doctrine stays compact and points here; the CLI carries
 * the full doctrine, the complete per-node-kind documentation (role, ports,
 * data models, events), and the concepts. Generated from the physics registry
 * and the real schemas so it can never drift from the program.
 *
 * Pure module — no Node imports (renderer-safe). One theory: the injected
 * doctrine is the pointer; `vellum-command docs` is the encyclopedia.
 */

import { Schema } from "effect";
import {
  productNodeKindEnabled,
  productPortEnabled,
  TASKS_ENABLED,
} from "./features";
import {
  KindSpecs,
  ACTOR_ACTOR_INBOX_PORTS,
  type KindSpec,
} from "./physics/kinds";
import { ALL_PORTS, type Port } from "./physics/schema";
import {
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherPad,
  EtherRequests,
  EtherTasks,
} from "./work-model";
import { EtherBrowser, EtherRegion, EtherTerminal, EtherTimer, EtherWatch } from "./canvas";
import { EtherSheet } from "./sheet";
import {
  VELLUM_INTRO,
  SEAT_DOCTRINE,
  WORKER_DOCTRINE,
  BASE_CONTRACT,
  compileEdgeSlots,
  buildInjectionText,
} from "./managed-terminal-injection";

// ── Port descriptions (single source) ──────────────────────────────────────

export const PORT_DESCRIPTIONS: Readonly<Record<Port, string>> = {
  "tasks.list": "List tasks on the connected tasks node.",
  "tasks.create": "Author a new task on the connected Tasks board.",
  "tasks.claim": "Claim a submitted task (submitted → working).",
  "tasks.update": "Transition a task state (working/completed/failed/canceled/input-required).",
  "msg.list": "List messages on the connected node's mailbox.",
  "msg.send": "Append a message to the connected node.",
  "msg.prompt": "Persist mail and attempt a short immediate turn on an idle peer; retry by the same message id.",
  "seat.wait": "Wait for a connected peer state with a bounded timeout.",
  "terminal.read": "Read settled terminal output from a connected peer; no input, resize or signal authority.",
  "verdict.post": "Post an epoch-bound verdict on the work of this edge's author, from a distinct reviewer seat.",
  "request.escalate": "File a request, block the seat, and wait for the operator.",
  "artifact.publish": "Publish an artifact (text/data/ContentRef parts).",
  "browser.automate": "Control a granted page session (browser CLI).",
  "board.list": "List bulletin-board topics and posts.",
  "board.create_topic": "Create a board topic (does not notify agents).",
  "board.post": "Post a note under a topic.",
  "board.mark_read": "Mark a topic read without replying.",
  "pad.read": "Read the connected pad (grant pad.read): revision, IR, digest, SVG; optional pinId adds look-here. Agents never write the factory canvas.",
  "pad.patch": "Apply PadPatch (grant pad.patch). Agents may upsert shapes, edges, and pin posts. Agent ink or image upserts are refused. Mentions must be inbound actor node ids.",
  "sheet.read": "Read the connected sheet (grant sheet.read): columns, rows, and a markdown table. Sheets are operator-authored — agents never write one.",
  "relay.trigger": "Fire a connected scheduler pipeline now.",
};

// ── Per-kind data models (generated from the real schemas) ─────────────────

const schemaFields = (
  schema: Schema.Schema<unknown> | undefined,
): ReadonlyArray<{ name: string; type: string }> => {
  if (schema === undefined) return [];
  try {
    const doc = Schema.toJsonSchemaDocument(schema).schema;
    const props = (doc as { properties?: Record<string, unknown> }).properties;
    if (!props) return [];
    return Object.entries(props).map(([name, value]) => ({
      name,
      type: String((value as { type?: unknown }).type ?? "any"),
    }));
  } catch {
    return [];
  }
};

type NodeDoc = {
  readonly kind: string;
  readonly role: KindSpec["role"];
  readonly offers: readonly string[];
  readonly model: ReadonlyArray<{ name: string; type: string }>;
  readonly modelNote: string;
  readonly events: readonly string[];
  readonly note: string;
};

const NODE_EVENTS: Readonly<Record<string, readonly string[]>> = {
  task: [
    "task.create — one submitted Task is persisted immediately with a stable TaskId; omitted admission is approval",
    "task.claim — submitted → working only after admission and every dependsOn TaskId is completed",
    "task.transition — completed sends the task on (sent-on) or closes it (completed); a defect sends it back (sent-back); state changes may carry completionEvidence",
    "content.* — ContentRef materialization events for task media",
  ],
  requests: [
    "request.create — a request is raised (actor) or opened (operator)",
    "request.resolve — the request is answered; the seat unblocks",
    "task.transition — requests share the Task state machine",
  ],
  artifacts: [
    "artifact.publish — admitted, process-bound publish with proof stamp",
    "artifact.link — artifact linked to a task via Artifact.task",
  ],
  board: [
    "board.topic_created / board.posted / board.mark_read — attention changes",
    "board.wake — topic attention nudges seats (operator IPC only)",
  ],
  pad: [
    "pad.read — revision + IR + digest + SVG for a wired seat; optional pinId adds look-here",
    "pad.patch — applyPatch on the work-plane pad (agents cannot upsert ink or images; mentions must be inbound actors)",
    "pad.digest / pad.svg / pad.get / pad.look-here / pad.tagged — CLI projections of pad.read",
  ],
  agent: [
    "msg.append — factory mail or peer messages land in the seat mailbox",
    "msg.list — own inbox marks listed mail read; sent shows peer readAt",
    "msg.react / msg.reply — ack without a reply, or reply",
    "seat.state — idle/working/attention/unknown/gone derived from the PTY",
  ],
  page: [
    "page.load — page session navigation state",
    "browser.session — session open/close/detach lifecycle",
  ],
  terminal: ["terminal.session — PTY attach/detach lifecycle"],
  cron: ["cron.fire — durable timer due", "cron.next_fire — schedule projection"],
  relay: ["relay.trigger — agent-fired pipeline run"],
  watcher: ["watcher.satisfied — stat threshold crossed"],
  timer: ["timer.fire — durable timer due"],
};

const ETHER_BY_KIND: Readonly<Record<string, Schema.Schema<unknown>>> = {
  task: EtherTasks,
  requests: EtherRequests,
  artifacts: EtherArtifacts,
  board: EtherBoard,
  pad: EtherPad,
  sheet: EtherSheet,
  agent: EtherMessages,
  page: EtherBrowser,
  terminal: EtherTerminal,
  cron: EtherTimer,
  timer: EtherTimer,
  watcher: EtherWatch,
};

const MODEL_NOTE: Readonly<Record<string, string>> = {
  task: "Tasks board: one stable TaskId is persisted immediately. Omitted admission is approval — the operator's approval lets a seat claim; admission never loosens the board floor (Immediate / Approval / Me). dependsOn contains TaskIds only and gates claim until every prerequisite completes. Finish criteria + completionEvidence gate the completed transition; every rule in force needs a claim (or a waiver when the chosen path no longer reaches its board); checks gate sending on.",
  requests: "Requests sink: items share the Task state machine; resolving a request unblocks the seat.",
  artifacts: "Artifacts sink: items (Artifact[]) published through the admitted, process-bound path.",
  board: "Board sink: topics with posts; glance strip in ether, full posts on list/detail.",
  sheet: "Sheet sink: an operator-authored grid (columns + rows of plain text). The canvas document owns it — there is no work-plane row, no revision counter, and no agent write path.",
  pad: "Pad sink: work-plane IR. Empty pad is legal. Glance is title + shape count + unread pin count. Working copy is pad.read, not the factory digest.",
  agent: "Actor seat: mailbox items (Message[]) + terminal session; identity is process-bind.",
  page: "Browser surface: admitted page sessions controlled via the browser CLI.",
  terminal: "Terminal resource: PTY session surface.",
  cron: "Time scheduler: durable due times projected as nextFire.",
  relay: "Canvas-node scheduler: fires when an agent triggers the relay.trigger port.",
  watcher: "Stat watcher: threshold crossing projection (product-dormant in v1).",
  timer: "Timer scheduler: durable interval scheduling.",
};

const KIND_NOTE: Readonly<Record<string, string>> = {
  agent: "The actor role: pulls work through edges, holds a mailbox, runs a harness.",
  task: "The pull queue: submitted tasks are claimed by connected actor seats.",
  requests: "The escalation surface: file a request to block your seat and wait for the operator.",
  artifacts: "The delivery surface: publish outputs; artifacts never block.",
  board: "The bulletin surface: optional shared context, never a decision inbox.",
  sheet: "A small grid to jot numbers and names beside the work. Read-only to agents; the operator types it.",
  pad: "The shared page: wired agents read a picture + IR and patch named boxes and pins. They never write the factory canvas. Agent ink or image upserts are refused. Mentions must be inbound actor node ids.",
  page: "The browser surface (feature-gated): page automation grants.",
  terminal: "A terminal resource sink (v1 access family only).",
  cron: "Time scheduler (feature-gated).",
  relay: "Relay scheduler (feature-gated): agent-fired automation.",
  watcher: "Stat watcher (product-dormant).",
  timer: "Timer scheduler (feature-gated).",
};

const buildNodeDocs = (): ReadonlyArray<NodeDoc> =>
  Object.entries(KindSpecs).map(([kind, spec]) => {
    const offers = [...spec.offers].sort();
    return {
      kind,
      role: spec.role,
      offers,
      model: schemaFields(ETHER_BY_KIND[kind]),
      modelNote: MODEL_NOTE[kind] ?? "No canonical ether data model.",
      events: NODE_EVENTS[kind] ?? [],
      note: KIND_NOTE[kind] ?? "",
    };
  });

/**
 * Node docs are a product surface: a kind a feature gate turned off leaves
 * the catalog, the per-kind page, and the doctrine's worked examples.
 */
export const NODE_DOCS: ReadonlyArray<NodeDoc> = buildNodeDocs().filter((doc) =>
  productNodeKindEnabled(doc.kind),
);

// ── Catalog ────────────────────────────────────────────────────────────────

export const buildNodesCatalogDoc = (): string => {
  const lines = [
    "# Node kinds",
    "",
    "Every node kind on the canvas, its factory role, and the ports it offers on an edge.",
    "",
    "| kind | role | offers |",
    "|---|---|---|",
  ];
  for (const doc of NODE_DOCS) {
    lines.push(
      `| ${doc.kind} | ${doc.role} | ${doc.offers.length > 0 ? doc.offers.join(", ") : "(none)"} |`,
    );
  }
  lines.push(
    "",
    "Ports on an edge are the seat's capability set — no edge, no grant.",
    "",
    "Get one node kind in depth: `vellum-command docs node <kind>`",
  );
  return lines.join("\n");
};

export const buildNodeKindDoc = (kind: string): string | undefined => {
  const doc = NODE_DOCS.find((d) => d.kind === kind);
  if (doc === undefined) return undefined;
  const lines = [
    `# Node kind: ${doc.kind}`,
    "",
    `**Role:** ${doc.role}`,
    doc.note ? `\n${doc.note}` : "",
    "",
    "## Ports offered on an edge",
    ...(doc.offers.length > 0
      ? doc.offers.map((p) => `- \`${p}\` — ${PORT_DESCRIPTIONS[p as Port] ?? "—"}`)
      : ["- (none — access family only in v1)"]),
    "",
    "## Data model (ether)",
    `_${doc.modelNote}_`,
    "",
    ...(doc.model.length > 0
      ? doc.model.map((f) => `- \`${f.name}\`: ${f.type}`)
      : ["- (no canonical ether data model)"]),
    "",
    "## Events",
    ...(doc.events.length > 0 ? doc.events.map((e) => `- ${e}`) : ["- (none documented)"]),
    "",
    "## Contract",
    "",
    "The seat's CLI contract for this kind is injected when the seat holds an edge to it:",
    "",
  ];
  const contracts = compileEdgeSlots([{
    id: `<${kind}-node-id>`,
    kind,
    ports: ALL_PORTS.filter((port) => doc.offers.includes(port)),
  }]);
  if (contracts.length > 0) {
    lines.push("These examples cover the offered ports; your live edge may grant fewer.", "```", ...contracts, "```");
  } else {
    lines.push("_No edge contract is injected for this kind in v1._");
  }
  return lines.join("\n");
};

// ── Expanded doctrine (the injected body + expansions) ─────────────────────

export const buildDoctrineDoc = (): string => {
  const injected = buildInjectionText({
    seatBound: true,
    connected: true,
    seatRef: "<seat-ref>",
    connectedTargets: [
      { id: "<task-node>", kind: "task" },
      { id: "<requests-node>", kind: "requests" },
      { id: "<artifacts-node>", kind: "artifacts" },
      { id: "<board-node>", kind: "board" },
      { id: "<peer-agent>", kind: "agent" },
    ].filter((target) => productNodeKindEnabled(target.kind)).map((target) => ({
      ...target,
      ports: ALL_PORTS.filter((port) =>
        NODE_DOCS.find((doc) => doc.kind === target.kind)?.offers.includes(port),
      ),
    })),
  });
  return [
    "# Vellum Command — full doctrine",
    "",
    "This is the complete doctrine. The injected system prompt is a compact",
    "edge-compiled subset of it; every law below expands what the injection",
    "states. Read what you need; the CLI is stateful and current at all times.",
    "",
    injected ?? "",
    "",
    "## Expansions",
    "",
    "### Why edges are permissions",
    "Authorization is topology: a seat acts only on edge-connected nodes, holding",
    "exactly the ports that node offers. There is no permission file to drift; the",
    "canvas drawing is the ACL. `ScopeError` names the missing edge and the fix.",
    "",
    "### Why completion is earned",
    "`completed` is a factory verdict: the server rejects the transition unless",
    "finish criteria are met and evidence is attached (artifacts exist, linked,",
    "named exactly; git SHAs well-formed and counted). The agent submits; the",
    "factory ratifies. Operators can QA-reject back to Queue with a comment.",
    "",
    "### Why identity is process-bind",
    "Your seat's identity is its process tree under Vellum Command, proven by the",
    "OS (peer PID). No API key, no client-supplied identity, no env-var authority.",
    "The token is file-backed (0600) and never travels in env or argv.",
    "",
    "### Why the CLI is the tool surface",
    "One binary, JSON-in/JSON-out, self-describing (`capabilities`/`schema`/",
    "`examples`/`docs`), batch-capable. No MCP registries, no plugins, no config",
    "writes to your harness. The doctrine is the pointer; the CLI is the map.",
    "",
    "### The operational events",
    "Beyond the doctrine you receive: claim notices (task data at claim), edge",
    "map-change notices (contracts added/removed), orient notices (re-grounding),",
    "repair notes (environment fixes), and factory mail. All are compact; the",
    "full context is always one `onboard` away.",
    "",
  ].join("\n");
};

// ── Concepts ───────────────────────────────────────────────────────────────

/** The factory paragraph is task-shaped; without tasks it becomes seat-shaped. */
const FACTORY_CONCEPT = TASKS_ENABLED
  ? [
    "## The factory",
    "Tasks are a pull queue. The factory (edges + live state) decides what is",
    "available; seats claim and work. Claims are atomic and delivered as a",
    "complete CLI task briefing. Idle seats wait — they do not invent backlog.",
  ]
  : [
    "## Seats and edges",
    "There is no claim queue in this build. Work reaches a seat from the",
    "operator, its region briefing, and mail over its edges. Edges remain the",
    "permission surface; idle seats wait and do not invent backlog.",
  ];

/** Completion verdicts are task-shaped; without tasks, honest reporting. */
const COMPLETION_CONCEPT = TASKS_ENABLED
  ? [
    "## Earned completion",
    "Completion is a factory verdict, not a harness assertion: finish criteria",
    "are hard gates enforced on the `completed` transition, with evidence",
    "(artifacts + git SHAs) verified by the task home.",
  ]
  : [
    "## Honest reporting",
    "There is no factory verdict in this build. A seat says what it did, what",
    "it verified, and what it could not finish.",
  ];

export const buildConceptsDoc = (): string =>
  [
    "# Concepts",
    "",
    "## Seats",
    SEAT_DOCTRINE,
    "",
    ...FACTORY_CONCEPT,
    "",
    "## Grants and ports",
    `Every edge hands the seat the ports the node offers. The port set:`,
    ...ALL_PORTS.filter((port) => productPortEnabled(port)).map(
      (p) => `- \`${p}\` — ${PORT_DESCRIPTIONS[p]}`,
    ),
    "",
    ...COMPLETION_CONCEPT,
    "",
    "## Process-bind identity",
    "Identity is the process tree under Vellum Command, proven by the OS. Env is",
    "context only, never authority.",
    "",
    "## Errors as ground truth",
    "A closed error family with `retryable` flags and `next_step` guidance.",
    "Retry only when retryable, at most twice; then adapt or escalate. Never",
    "invent around an error.",
    "",
    "## The intervention ladder",
    "Vellum Command may become more active with a seat's PTY only when it can",
    "prove the intervention cannot damage the experience: never near user input,",
    "never into a draft, never into a modal, one live injection at a time.",
    "Escalation is a canvas event, never a PTY write.",
    "",
  ].join("\n");

// ── Topics ─────────────────────────────────────────────────────────────────

export const DOC_TOPICS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly description: string;
}> = [
  { id: "doctrine", title: "Full doctrine", description: "The complete doctrine: injected body + expansions." },
  { id: "nodes", title: "Node catalog", description: "Every node kind, its role, and the ports it offers." },
  { id: "node", title: "Node kind in depth", description: "Role, ports, data model, events, and contract for one kind." },
  { id: "concepts", title: "Concepts", description: "Seats, grants, the factory, earned completion, identity, errors, the ladder." },
  { id: "contract", title: "CLI contract", description: "The full command surface with schemas and examples." },
];

export const buildDocsTopicList = (): string =>
  ["# Documentation topics", ""]
    .concat(DOC_TOPICS.map((t) => `- \`${t.id}\` — ${t.title}: ${t.description}`))
    .concat(["", "Usage: `vellum-command docs <topic>` (or `docs node <kind>`)."])
    .join("\n");
