/**
 * Junto documentation catalog — the CLI as the infinite knowledge
 * base. Nothing is sent to a harness at session start: `junto onboard` loads
 * the short briefing and points here; the CLI carries the full doctrine, the complete per-node-kind documentation (role, ports,
 * data models, events), and the concepts. Generated from the physics registry
 * and the real schemas so it can never drift from the program.
 *
 * Pure module — no Node imports (renderer-safe). One theory: `junto onboard`
 * is the pointer; `junto docs` is the encyclopedia.
 */

import { Schema } from "effect";
import {
  productNodeKindEnabled,
  productPortEnabled,
  TASKS_ENABLED,
} from "./features";
import { RESOURCE_KINDS } from "./region-reach";
import {
  KindSpecs,
  ACTOR_ACTOR_INBOX_PORTS,
  type KindSpec,
} from "./physics/kinds";
import { ALL_PORTS, type Port } from "./physics/schema";
import { Seat, TaskBoard, Requests, Artifacts, Board, Page, Terminal } from "./model/kinds";
import {
  SEAT_DOCTRINE,
  buildDoctrineBody,
  buildEdgeContracts,
} from "./junto-doctrine";

// ── Port descriptions (single source) ──────────────────────────────────────

/** A resource kind admits by reach (plan 01): its kind, not a port, teaches its commands. */
const isResourceKind = (kind: string): boolean => (RESOURCE_KINDS as ReadonlyArray<string>).includes(kind);

/** The ports an edge grants. A resource in reach admits by its kind, and offers none here. */
export const PORT_DESCRIPTIONS: Readonly<Partial<Record<Port, string>>> = {
  "msg.list": "List messages on the connected node's mailbox.",
  "msg.send": "Mail the connected node: it is typed whole into its input, up to 2,500 characters, and mail sent together arrives as one turn.",
  "msg.prompt": "Mail the peer as a prompt: the full text is typed into its input at once, idle or mid-turn.",
  "seat.wait": "Wait for a connected peer state with a bounded timeout.",
  "terminal.read": "Read settled terminal output from a connected peer; no input, resize or signal authority.",
  "browser.automate": "Control a granted page session (browser CLI).",
  "board.list": "List bulletin-board topics and posts.",
  "board.create_topic": "Create a board topic (does not notify agents).",
  "board.post": "Post a note under a topic.",
  "board.mark_read": "Mark a topic read without replying.",
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
    "task.create — a task starts in backlog with a stable TaskId and its number (#42)",
    "task.assign, task.start, task.pause, task.resume — assigned, working, input-required and back",
    "task.finish — in-review while it waits on stamps, then done or sent on to the next node; refused rules-unmet while a rule in force has no claim",
    "task.stamp — approve counts at the current epoch; changes sends the task back to working on a new epoch",
    "content.* — ContentRef materialization events for task media",
  ],
  requests: [
    "request.create — a request is raised (actor) or opened (operator)",
    "request.resolve — the request is answered; the seat unblocks",
    "task.transition — requests share the Task state machine",
  ],
  artifacts: [
    "artifact.create, artifact.edit — versioned, ruled by the machine that edits the canvas",
    "artifact.comment — a thread on the artifact, whole or at an anchor",
  ],
  board: [
    "board.topic_created / board.posted / board.mark_read — attention changes",
    "board.wake — topic attention nudges seats (operator IPC only)",
  ],
  agent: [
    "msg.append — operator or peer messages land in the seat mailbox",
    "msg.list — own inbox marks listed mail read; sent shows peer readAt",
    "msg.react / msg.reply — ack without a reply, or reply",
    "seat.state — idle/working/attention/unknown/gone derived from the PTY",
  ],
  page: [
    "page.load — page session navigation state",
    "browser.session — session open/close/detach lifecycle",
  ],
  terminal: ["terminal.session — PTY attach/detach lifecycle"],
};

const SCHEMA_BY_KIND: Readonly<Record<string, Schema.Schema<unknown>>> = {
  task: TaskBoard, requests: Requests, artifacts: Artifacts, board: Board,
  agent: Seat, page: Page, terminal: Terminal,
};

const MODEL_NOTE: Readonly<Record<string, string>> = {
  task: "Task node: each task has a stable TaskId and a number (#42) and moves backlog, assigned, working, in-review, done. dependsOn holds TaskIds only, and a task cannot finish until each is done. Every rule in force needs a claim on the finish; stamps decide in-review.",
  requests: "Requests sink: separately queried items share the Task state machine; resolving a request unblocks the seat.",
  artifacts: "Artifacts node: links, documents, pads, sheets and files, each versioned; every write is ruled by the machine that edits the canvas.",
  board: "Board sink: the node holds its authored label; paged Work queries hold topics and posts.",
  agent: "Actor seat: the node holds identity, harness and launch settings. Mail is separately stored and paged per seat; terminal sessions are runtime facts. Identity is the seat credential.",
  page: "Browser surface: admitted page sessions controlled via the browser CLI.",
  terminal: "Terminal resource: PTY session surface.",
  automations: "Automations node: each automation has a schedule, poll or change trigger, conditions in `when` and actions in `then`, and is created off unless enabled. Firings are kept as history, each with its actions' rulings or why it was skipped.",
};

const KIND_NOTE: Readonly<Record<string, string>> = {
  agent: "The actor role: takes work from its reach and its mail, holds a mailbox, runs a harness.",
  task: "Tasks: assigned to a seat in the node's reach, worked and finished with junto task.",
  automations: "Automations: triggers, conditions and actions the editing machine runs, in place of the old cron, relay, watcher and timer schedulers. A seat reads the ones in its reach with `junto automation list`, `show` and `history`; only the operator and overseers write them.",
  requests: "The operator's request queue. Seats no longer file requests; they raise agent signals (junto escalate, blocked, feedback) instead.",
  artifacts: "The delivery surface: create and edit outputs with junto artifact; artifacts never block.",
  board: "The bulletin surface: optional shared context, never a decision inbox.",
  page: "The browser surface (feature-gated): page automation grants.",
  terminal: "A terminal resource sink (v1 access family only).",
};

const buildNodeDocs = (): ReadonlyArray<NodeDoc> =>
  Object.entries(KindSpecs).map(([kind, spec]) => {
    const offers = isResourceKind(kind) ? [] : [...spec.offers].sort();
    return {
      kind,
      role: spec.role,
      offers,
      model: schemaFields(SCHEMA_BY_KIND[kind]),
      modelNote: MODEL_NOTE[kind] ?? "No native node schema.",
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

/** Ports some kind this build documents offers; a removed kind's port leaves with it. */
const OFFERED_PORTS: ReadonlySet<string> = new Set(NODE_DOCS.flatMap((doc) => doc.offers));

// ── Catalog ────────────────────────────────────────────────────────────────

export const buildNodesCatalogDoc = (): string => {
  const lines = [
    "# Node kinds",
    "",
    "Every node kind on the canvas, its role, and the ports it offers.",
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
    "A seat holds every command of a resource in its reach, by its kind, and a seat's ports over an edge to it.",
    "",
    "Get one node kind in depth: `junto docs node <kind>`",
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
    "## Ports offered",
    ...(doc.offers.length > 0
      ? doc.offers.map((p) => `- \`${p}\` — ${PORT_DESCRIPTIONS[p as Port] ?? "—"}`)
      : [isResourceKind(doc.kind) ? "- (none: reach admits; a seat with this node in its reach holds every command below)" : "- (none — access family only in v1)"]),
    "",
    "## Data model",
    `_${doc.modelNote}_`,
    "",
    ...(doc.model.length > 0
      ? doc.model.map((f) => `- \`${f.name}\`: ${f.type}`)
      : ["- (no native node schema)"]),
    "",
    "## Events",
    ...(doc.events.length > 0 ? doc.events.map((e) => `- ${e}`) : ["- (none documented)"]),
    "",
    "## Contract",
    "",
    "`junto onboard` compiles the commands a seat holds on this kind. The full contract:",
    "",
  ];
  const contracts = buildEdgeContracts([{
    id: `<${kind}-node-id>`,
    kind,
    ports: ALL_PORTS.filter((port) => doc.offers.includes(port)),
  }]);
  if (contracts.length > 0) {
    lines.push(
      isResourceKind(doc.kind)
        ? "A seat with this node in its reach holds all of these."
        : "These examples cover the offered ports; your live edge may grant fewer.",
      "```", ...contracts, "```",
    );
  } else {
    lines.push("_This kind carries no edge contract in v1._");
  }
  return lines.join("\n");
};

// ── Expanded doctrine (the body + expansions) ──────────────────────────────

export const buildDoctrineDoc = (): string => {
  const body = buildDoctrineBody(
    [
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
  );
  return [
    "# Junto — full doctrine",
    "",
    "This is the complete doctrine. Nothing here is sent to a harness: a seat",
    "loads its short briefing with `junto onboard`, and every law below expands",
    "it. Read what you need; the CLI is stateful and current at all times.",
    "",
    body,
    "",
    "## Expansions",
    "",
    "### Why reach is where you sit",
    "Authorization is the drawing: a seat uses the resources its region reaches",
    "and mails the seats its edges join. Reach is read from the rectangles on",
    "every call, never stored, so there is no permission file to drift, and moving",
    "a node changes reach on the next command. `ScopeError` names what is out of",
    "reach, or which edge is missing.",
    "",
    ...(TASKS_ENABLED
      ? [
        "### Why completion is earned",
        "`done` is earned: `task finish` is refused until every rule in force",
        "has a claim, and a task that needs stamps waits in `in-review` until its",
        "reviewers approve. The seat submits; the server rules. A reviewer who",
        "stamps `changes` sends the task back to `working` with what to change.",
        "",
      ]
      : [
        "### Why reporting is the record",
        "There is no completion verdict to earn in this build. What a seat writes",
        "on its edges is the record the operator reads — say what you did,",
        "what you verified, and what you could not finish.",
        "",
      ]),
    "### Why identity is a seat credential",
    "Your seat's identity is the credential Junto mints for this session and",
    "places in `JUNTO_WORK_TOKEN` when it starts you. The CLI reads it itself.",
    "No client-supplied identity, no token file, no token on argv. If the",
    "variable is missing the call is refused; nothing else stands in for it.",
    "",
    "### Why the CLI is the tool surface",
    "One binary, JSON-in/JSON-out, self-describing (`capabilities`/`schema`/",
    "`examples`/`docs`), batch-capable. No MCP registries, no plugins, no config",
    "writes to your harness. `junto onboard` is the pointer; the CLI is the map.",
    "",
    "### What a seat launches with",
    "A region may carry an environment: sources that name where a variable",
    "comes from on this machine. A seat is launched with what every region",
    "containing it provides, outermost first; a change applies when the seat",
    "restarts. `junto env report` shows this seat's own report: variable names,",
    "the source and region of each, and whether it could be read. Never a value.",
    "It exits non-zero when a required source is missing.",
    "",
    "### The briefing and references",
    "The operator keeps house text in Junto. The briefing is one text for every",
    "seat, and `junto onboard` carries it. References are named pieces of prose,",
    "kept for the whole app or for one region. Onboard lists the ones in your",
    "scope by name and description; nothing sends them to you.",
    "`junto references list` shows them again with sizes, and",
    "`junto references read <name>` returns one. Read a reference when the work",
    "calls for it. When a region and the app both have a name, the innermost",
    "region's is the one you get.",
    "",
    "### The operational events",
    `Beyond the doctrine you receive: ${TASKS_ENABLED ? "task notices in the task's thread (assignment, stamps), " : ""}connection`,
    "messages (what you can now reach or no longer reach), an onboarding nudge",
    "(only while the seat has not onboarded), repair notes (environment fixes), and mail. All are compact; the",
    "full context is always one `onboard` away.",
    "",
  ].join("\n");
};

// ── Concepts ───────────────────────────────────────────────────────────────

/** The queue paragraph is task-shaped; without tasks it becomes seat-shaped. */
const FACTORY_CONCEPT = TASKS_ENABLED
  ? [
    "## The task queue",
    "A task is assigned to a seat in its node's reach, by the operator, a",
    "lead or the seat itself, and the notice arrives as mail in the task's",
    "thread. Idle seats wait; they do not invent backlog.",
  ]
  : [
    "## Seats and edges",
    "There is no task queue in this build. Work reaches a seat from the",
    "operator, its region briefing, and mail over its edges. The resources in its",
    "region are in its reach; edges join it to the seats it mails. Idle seats",
    "wait and do not invent backlog.",
  ];

/** Completion verdicts are task-shaped; without tasks, honest reporting. */
const COMPLETION_CONCEPT = TASKS_ENABLED
  ? [
    "## Earned completion",
    "Completion is a server ruling, not a harness assertion: `task finish` is",
    "refused while a rule in force has no claim, and the stamps a task needs",
    "decide when `in-review` becomes `done`.",
  ]
  : [
    "## Honest reporting",
    "There is no completion verdict in this build. A seat says what it did, what",
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
    `A resource in reach hands the seat every command of its kind, with no port. An edge to a seat hands the ports that seat offers:`,
    ...ALL_PORTS.filter((port) => productPortEnabled(port) && OFFERED_PORTS.has(port)).map(
      (p) => `- \`${p}\` — ${PORT_DESCRIPTIONS[p] ?? "—"}`,
    ),
    "",
    ...COMPLETION_CONCEPT,
    "",
    "## Process-bind identity",
    "Identity is the process tree under Junto, proven by the OS. Env is",
    "context only, never authority.",
    "",
    "## Errors as ground truth",
    "A closed error family with `retryable` flags and `next_step` guidance.",
    "Retry only when retryable, at most twice; then adapt or escalate. Never",
    "invent around an error.",
    "",
    "## The intervention ladder",
    "Junto may become more active with a seat's PTY only when it can",
    "prove the intervention cannot damage the experience: never near user input,",
    "never into a draft, never into a modal, one live injection at a time.",
    "Mail is not an intervention: it is typed at once, as steering. While a",
    "turn is running, the harness follow-up contract says how many Enters",
    "that takes. An idle seat gets one Enter.",
    "Escalation is a canvas event, never a PTY write.",
    "",
  ].join("\n");

// ── Topics ─────────────────────────────────────────────────────────────────

export const DOC_TOPICS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly description: string;
}> = [
  { id: "doctrine", title: "Full doctrine", description: "The complete doctrine: the laws, the CLI contract, and expansions." },
  { id: "nodes", title: "Node catalog", description: "Every node kind, its role, and the ports it offers." },
  { id: "node", title: "Node kind in depth", description: "Role, ports, data model, events, and contract for one kind." },
  { id: "concepts", title: "Concepts", description: `Seats, grants, ${TASKS_ENABLED ? "the task queue, earned completion" : "edges, honest reporting"}, identity, errors, the ladder.` },
  { id: "contract", title: "CLI contract", description: "The full command surface with schemas and examples." },
];

export const buildDocsTopicList = (): string =>
  ["# Documentation topics", ""]
    .concat(DOC_TOPICS.map((t) => `- \`${t.id}\` — ${t.title}: ${t.description}`))
    .concat(["", "Usage: `junto docs <topic>` (or `docs node <kind>`)."])
    .join("\n");
