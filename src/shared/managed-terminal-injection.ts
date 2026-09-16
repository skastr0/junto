/**
 * Per-session instruction injection for managed terminals (Phase 6 → compiled doctrine).
 *
 * Single source of truth for the doctrine text that used to live in the
 * vellum-plugin global rule. Spawn (Tier A flags) and first typed message
 * (Tier B) both consume this builder.
 *
 * Compiled doctrine model:
 * - Detached terminal (no canvas node) → null → nothing injected, nothing typed.
 * - Canvas seat → base doctrine ALWAYS (Junto intro, seat doctrine,
 *   worker loop, base CLI contract, laws). Isolated seats get no edge contracts.
 * - Edge contracts are COMPILED from the node's edge reality at spawn: each
 *   target's held ports select its CLI contracts, including operator masks
 *   (task → tasks ops; requests → escalate; artifacts → publish; board → board;
 *   messages → mail; directed reviews → verdict). The agent is never taught
 *   a target command without the corresponding held port.
 * - Mid-session map changes send a compact notice pointing at live grants
 *   (composeEdgeMapChangeNotice / planEdgeMapChanges).
 *
 * Never writes ~/.claude, ~/.codex, ~/.grok, ~/.hermes.
 */

import {
  type HarnessId,
  type InjectionTier,
  templateFor,
} from "./managed-terminal-templates";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  REQUESTS_ENABLED,
  TASKS_ENABLED,
} from "./features";
import type { CanvasDoc } from "./canvas";
import type { Port } from "./physics/schema";
import {
  FEW_SHOT_CLAIM,
  FEW_SHOT_COMPLETE_EVIDENCE,
  FEW_SHOT_ESCALATE,
  FEW_SHOT_PROGRESS,
  type DoctrineFewShotPayload,
} from "./doctrine-few-shots";

// ── Seat context (filled at spawn) ─────────────────────────────────────────

export type InjectionConnectedTarget = {
  readonly id: string;
  readonly kind?: string;
  readonly summary?: string;
  /** Canonical held grants at spawn. Missing or empty grants teach no actions. */
  readonly ports?: readonly Port[];
};

/**
 * Context slots for the injection payload.
 * `seatBound` is the hard gate: false (detached terminal) → no injection at all.
 * `connected` means the seat holds at least one actionable factory edge and
 * therefore receives the compiled edge contracts.
 */
export type InjectionContext = {
  /** Detached terminal (no canvas node) → false → silence. */
  readonly seatBound: boolean;
  /** Seat holds an actionable factory edge → edge contracts are compiled in. */
  readonly connected: boolean;
  /** Canvas seat / node ref (context only — identity is process-bind). */
  readonly seatRef?: string;
  /** Edge-connected work surfaces the seat may act on. */
  readonly connectedTargets?: readonly InjectionConnectedTarget[];
  /**
   * Operator-authored region briefing (EtherRegion.instruction). Appended as
   * a clearly-marked supplemental layer at the end of the doctrine — the
   * base body stays immutable; the region is the operator's steering surface
   * for a group of seats. Absent → no section (onboard still carries it).
   */
  readonly regionInstruction?: string;
};

// ── Slot kinds ─────────────────────────────────────────────────────────────

/** Command families; membership comes from held ports, not target kind. */
export type EdgeSlotKind =
  | "tasks"
  | "escalate"
  | "msg"
  | "reviews"
  | "artifacts"
  | "board"
  | "pad"
  | "sheet"
  | "browser";

/** Kind labels for neighbor-change notices; these are not permission grants. */
export const KIND_TO_SLOT: Readonly<Record<string, EdgeSlotKind | undefined>> = {
  task: "tasks",
  tasks: "tasks",
  requests: "escalate",
  request: "escalate",
  artifacts: "artifacts",
  board: "board",
  pad: "pad",
  sheet: "sheet",
  agent: "msg",
  page: "browser",
};

// ── Intro / seat doctrine (base) ───────────────────────────────────────────

/**
 * Work-surface words the intro names. A feature-gated surface leaves the
 * injected doctrine with its product gate; the sentence is descriptive, so a
 * disabled feature must not appear as an available work surface.
 */
const WORK_SURFACE_WORDS: ReadonlyArray<string> = [
  ...(TASKS_ENABLED ? ["tasks"] : []),
  ...(REQUESTS_ENABLED ? ["requests"] : []),
  ...(ARTIFACTS_ENABLED ? ["artifacts"] : []),
  ...(BOARD_ENABLED ? ["boards"] : []),
  "other agents",
];

/** What Junto is + canvas awareness — the grounding block. */
export const JUNTO_INTRO = `## Junto

You are running inside **Junto** — a factory floor for coding agents on a shared canvas. The canvas is your world: nodes are work surfaces (${WORK_SURFACE_WORDS.join(", ")}), and **edges are your permissions**. Your seat is the node you occupy; everything you may touch is edge-connected to you. All factory operations go through one CLI: \`vellum-command\`.`;

/** Seats — durable per-agent identity on the floor, where grants accrue. */
export const SEAT_DOCTRINE = `## Seats

A **seat** is your identity on the factory floor: the node you occupy, bound to your process. The seat is durable — it persists across sessions and restarts, and it is where grants, memory, and experience accumulate over time.

- **Grants** come from each authored edge verb and its operator mask. A mask only removes ports. A messages edge can grant mail, prompts, waits and terminal reads; a directed reviews edge grants \`verdict.post\` only from reviewer to author.${TASKS_ENABLED ? " Task verbs differ on claiming and authoring." : ""} \`capabilities\` gives the actual held ports; a neighboring kind alone proves no permission.
- **Identity** is process-bind: the OS proves who you are. You cannot claim another seat, and no env var makes you someone else.
- **Orientation** is one command: \`vellum-command onboard\` returns your seat, role, region briefing, connected targets ${TASKS_ENABLED ? "with grants and their board contracts" : "with their grants"}, and co-members. Re-run it whenever your view may be stale.
- **Rulings** are operator precedent pinned to a region. They stand over every seat inside it: \`vellum-command rulings\`.\n\n**Map-change notices are informational.** \`[factory - map]\` notices announce grant changes — they are not a command to re-run \`onboard\`/\`capabilities\` every time. Re-orient once at session start and whenever you actually need the live map to act. Idle chatter (ack-for-ack) is wasteful: acknowledge once, then stay quiet until real work or a new request arrives.`;

// ── Worker doctrine (base) ─────────────────────────────────────────────────

/** Blocking law leaves with its features: escalate, then input-required, then mail. */
const BLOCKED_SECTION = !TASKS_ENABLED
  ? `### When you are blocked

If you need a decision you cannot make, write what you need to the seat that asked, then stop. Do not thrash alternatives and do not invent work around the block.`
  : REQUESTS_ENABLED
  ? `### Requests block

\`input-required\` and open **requests** generate stoppage on the **connected actor seat**. When blocked:

- open a request with a clear brief (via the requests edge contract), or set the task to \`input-required\`
- stop thrashing alternatives
- wait for the human / approval path`
  : `### Waiting on the operator

\`input-required\` generates stoppage on the **connected actor seat**. When blocked:

- set the task to \`input-required\`
- stop thrashing alternatives
- wait for the human / approval path`;

/** Delivery law leaves with the artifacts feature. */
const ARTIFACTS_SECTION = ARTIFACTS_ENABLED
  ? `### Artifacts never block

Publishing artifacts is non-blocking product delivery. Ship intermediate and final outputs freely; they do not stop other seats.`
  : "";

/** The loop step that says where work comes from: a claim queue, or people. */
const WORK_STEP = TASKS_ENABLED
  ? `2. **work** — do the work the board makes available. If a task is already claimed by your seat, continue it; claim only tasks that are unclaimed (\`tasks claim\`). Never invent backlog.`
  : `2. **work** — do the work the operator and your region ask for. Instructions arrive in your region briefing and in mail over your edges; open the surfaces you need and work by hand. Never invent backlog.`;

const UPDATE_STEP = TASKS_ENABLED
  ? `3. **update** — report state honestly: \`working\` while active, then \`completed\` / \`failed\` / \`canceled\` / \`input-required\` as appropriate.`
  : `3. **update** — report state honestly to the seats that asked: what you finished, what failed, and what is still open.`;

const IDLE_LINE = TASKS_ENABLED
  ? `Repeat. When idle with no open tasks to pull, wait — do not invent new tasks.`
  : `Repeat. When idle with nothing addressed to you, wait — do not invent work.`;

/** Where work comes from: the task pull queue, or the people on the canvas. */
const WORK_SOURCE_SECTION = TASKS_ENABLED
  ? `### Pull from the board

Tasks are a **pull queue**. The factory (edges + live state) decides what is available. Do not:

- invent work the board never listed
- claim from targets you are not connected to (ScopeError is correct — fix edges, not the code)
- treat an open queue as stoppage — \`submitted\`/\`working\` means the factory is humming`
  : `### Work comes from people

There is no claim queue in this build. Work reaches you from the operator, your region briefing, and mail addressed to your seat. Do not:

- invent work nobody asked for
- act on nodes you are not connected to (ScopeError is correct — fix edges, not the code)
- treat a quiet canvas as stoppage — silence is the factory at rest`;

/** Completion law: a factory verdict with a queue, honest reporting without. */
const COMPLETION_SECTION = TASKS_ENABLED
  ? `### Completion is earned

You do not **self-declare** completion — you **submit** it. \`completed\` is a factory verdict: the server rejects the transition unless finish criteria are met and evidence is attached.

- Before \`completed\`: verify every finish criterion (description, git commits${ARTIFACTS_ENABLED ? ", artifacts on the required node" : ""}), then attach \`completionEvidence\` — ${ARTIFACTS_ENABLED ? "artifacts published with task linkage + " : ""}real git SHAs.
- A rejection names the missing pieces (\`InvalidTransition\` with \`missing\` + \`next_step\`) — read it, fix the evidence, retry. Do not mark \`completed\` without evidence.
- If criteria are unreachable, ${REQUESTS_ENABLED ? "escalate" : "set the task to \`input-required\`"} with what you tried and what you need. Do not mark \`failed\` unless the task is truly dead.
- \`working\` notes are progress telemetry: state what you did at milestones (first commit, tests passing, blocked), not just "working".`
  : `### Report honestly

There is no factory verdict to submit in this build. Say what you did, what you verified, and what you could not finish. Do not dress up unfinished work as done; if you cannot finish, say so and stop.`;

/** Worker doctrine — factory seat, work source, blocking, identity. */
export const WORKER_DOCTRINE = `## Worker doctrine

You are a **factory worker** on a Junto canvas seat. The human authors the canvas; you work through connected edges and report state via the \`vellum-command\` CLI. Never invent canvas structure or freeform authoring.

### Worker loop

1. **onboard** — always first, no exceptions: at session start and after every compaction. Read seat, role, region, connected targets, grants.
${WORK_STEP}
${UPDATE_STEP}
4. **request when blocked** — if you need human input or approval, ${TASKS_ENABLED ? (REQUESTS_ENABLED ? "escalate (when a requests node is connected) or set the task to \`input-required\`" : "set the task to \`input-required\`") : "say what you need to the seat that asked and stop"}. Stop inventing work around the block.

${IDLE_LINE}

${WORK_SOURCE_SECTION}

${BLOCKED_SECTION}
${ARTIFACTS_SECTION}

${COMPLETION_SECTION}

### Reach

- **Reach** is edges + ports. You only act on connected nodes. ScopeError means you are not authorized for that target.
- Env like seat hints is **context only**, never authority.`;

// ── Base CLI contract (always available to seats) ─────────────────────────

const BROWSER_SLOT_ROWS = BROWSER_ENABLED
  ? `
| list granted pages | \`vellum-command browser pages --json\` |
| open a granted page | \`vellum-command browser open <vellum-ref> --json\` |
| navigate / inspect / capture | \`vellum-command browser goto\` - \`vellum-command browser eval\` - \`vellum-command browser shot\` |`
  : "";

const BROWSER_SLOT_DOCTRINE = BROWSER_ENABLED
  ? `\`browser.automate\` is a live edge grant realized by \`vellum-command browser\` from
the managed agent's existing shell. Existing sessions may use it immediately
after an edge appears — re-run \`vellum-command capabilities\` for the current command.

`
  : "";

/** Orientation wording: a task-board world, or seats and their grants. */
const ORIENT_DETAIL = TASKS_ENABLED
  ? "connected targets with what each board is for, who may start tasks there, its Next boards, and the rulings pinned over you"
  : "connected targets with their grants and the rulings pinned over you";

/** Task-shaped error meanings leave with the tasks surface. */
const TASK_ERROR_BULLETS = TASKS_ENABLED
  ? `
- \`ClaimConflict\` — task already claimed by someone else, or a state race; pick another task or wait for the holder
- \`InvalidTransition\` — illegal state change (e.g. \`completed\` without finish-criteria evidence); the message names the missing pieces`
  : "";

/** Always-present contract: orientation + self-description + laws. */
export const BASE_CONTRACT = `## CLI contract — base

JSON-in/JSON-out — every command takes one JSON argument (inline, \`@file\`, or stdin). Copy-paste the shapes below; do not invent flags.

| intent | command |
|---|---|
| orient (always first) | \`vellum-command onboard\` — seat, region briefing, ${ORIENT_DETAIL} |
| live contract / grants | \`vellum-command capabilities\` |
| pinned rulings for your regions | \`vellum-command rulings\` — add \`'{"target":"<id>"}'\` for a connected target's stack |
| thought bubble | \`vellum-command preamble '{"text":"..."}'\` |
| schemas / examples | \`vellum-command schema show <command>\` - \`vellum-command examples show <command>\` |
| full documentation | \`vellum-command docs\` - \`vellum-command docs node <kind>\` — the complete doctrine and per-node-kind docs (ports, data models, events) |

### Tool law

For an unfamiliar command, in order: \`examples show <command>\` → \`schema show <command>\` → execute. Prefer copy-paste JSON over inventing flags. For the full picture — doctrine, node kinds, ports, data models, events — pull \`vellum-command docs\`; the CLI is stateful and current, the injection is only the pointer.

Errors are **ground truth** — do not invent around them. Read \`type\` and \`next_step\`:

- \`ScopeError\` — not connected / not authorized for that target; the fix is an edge on the canvas, not a workaround${TASK_ERROR_BULLETS}
- \`InputError\` — payload failed schema decode; \`schema show\` prints the exact shape
- \`RuntimeDown\` / \`Paused\` — factory unavailable; wait, then re-run \`onboard\`. Do not retry-loop.
${REQUESTS_ENABLED ? "- \`Blocked\` — this seat is blocked; stop and wait for the operator (the stop directive names the request)" : ""}

Retry law: retry only when the error says \`retryable: true\`, at most twice, then adapt or escalate. Never loop the same failing call.

Context ritual: when context is heavy, compact, then re-run \`onboard\` for the live map.

Never leak board tokens, node refs, or seat ids into public copy.`;

// ── Edge contracts (compiled per connected kind) ───────────────────────────

const hasPort = (targets: readonly InjectionConnectedTarget[], port: Port): boolean =>
  targets[0]?.ports?.includes(port) === true;

const rowsFor = (
  targets: readonly InjectionConnectedTarget[],
  rows: ReadonlyArray<readonly [Port, string]>,
): string => rows.filter(([port]) => hasPort(targets, port)).map(([, row]) => row).join("\n");

const tasksSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — tasks${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
${rowsFor(targets, [
  ["tasks.list", `| list queue | \`vellum-command tasks list '{"target":"${t}"}'\` |`],
  ["tasks.list", `| read task + review subject | \`vellum-command tasks show '{"target":"${t}","task":"<taskId>"}'\` |`],
  ["tasks.list", `| wait for task state | \`vellum-command tasks wait <taskId> --target ${t} --until completed --timeout 30s\` — configured Command Center only; also supports input-required or rejected |`],
  ["tasks.create", `| author a task | \`vellum-command tasks create '{"target":"${t}","brief":"...","metadata":{"title":"...","details":"..."}}'\` |`],
  ["tasks.claim", `| claim | \`vellum-command tasks claim '{"target":"${t}","task":"<taskId>"}'\` |`],
  ["tasks.list", `| rules + readiness | \`vellum-command tasks rules '{"target":"${t}","task":"<taskId>"}'\` |`],
  ["tasks.update", `| run this move's checks | \`vellum-command tasks check '{"target":"${t}","task":"<taskId>"}'\` — add \`"next":"<board>"\` when the board has more than one Next |`],
  ["tasks.update", `| progress / settle / block task | \`vellum-command tasks update '{"target":"${t}","task":"<taskId>","state":"<state>"}'\` — states: working, completed, failed, canceled, input-required |`],
  ["tasks.list", "| task content | `vellum-command content path|stat|materialize` (ContentRefs attached to your tasks) |"],
])}
${hasPort(targets, "tasks.update") ? `

Finish criteria are **hard gates**: \`completed\` is rejected unless evidence is attached (${ARTIFACTS_ENABLED ? "artifacts linked to the task, " : ""}real git SHAs). A rejection names the missing pieces — read it, fix, retry.

### Stage evidence before review

On a configured Command Center, a requires-review task stays \`working\` while you submit real refs: \`vellum-command tasks update '{"target":"${t}","task":"<taskId>","state":"working","completionEvidence":{"artifacts":[],"git":{"commits":["<real-sha>"]}}}'\`. This stages evidence without completing the task. Reviewers receive the exact subject through receipt mail. Use the current epoch and subjectHash; a changed ref or epoch invalidates prior approval. After a qualifying reviewer posts green on that exact subject, complete with the same evidence. A blocking review sends work back with a defect and a new epoch. Requires-review completion is Command Center only.

### Rules in force

A board carries **rules**: operator-authored statements the work must satisfy, inherited from the regions it sits in, from the board itself, and from rules the raiser addressed to it. They are prompts for you to check, never something the server evaluates. Rules have no severity — every rule in force must be answered.

- Read them with \`tasks rules\` — each one names where it came from.
- Answer every rule on completion: \`completionEvidence.claims: [{"ruleId":"<id>","text":"how you satisfied it","refs":["<sha>"]}]\`.
- A task rule whose board your chosen path no longer reaches takes a waiver instead: \`completionEvidence.waivers: [{"ruleId":"<id>","reason":"why it no longer applies"}]\`.
- \`completed\` is refused while a rule is unanswered; the rejection names the innermost one.

### Path — one board at a time

Where the operator drew a task path, completing does not close the task: it hands it to the next board.

- With one Next, completing sends the task on automatically; with more than one, pick one with \`"next":"<board>"\` on the update.
- **Checks** are the operator's deterministic gates for that move. Run them with \`tasks check\` — the commands execute in your own shell and the results are stamped from what they returned. Every applicable check must pass before the task is sent on.
- Write what the outgoing contract asks in the update \`"handoffNote"\`: the next board sees that and your cited refs, never your interior work.
- Sending work back is \`state: "rejected"\` with \`"defect":{"summary":"what is wrong","refs":["..."]}\` — it returns the task to the board before yours.
- \`"waitFor":"12h"\` (or \`"7d"\`, or milliseconds) delays the first claim at the next board.

A task that arrives back with an epoch bump was sent back to you: prior claims and check results are stale, so answer the rules again and re-run the checks.` : ""}`;
};

const escalateSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — requests / escalate${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

When blocked and you need human input or approval: \`vellum-command escalate '{"target":"${t}","brief":"what you need","reason":"why"}'\` — files a request, blocks the seat, returns a stop directive. Stop work until the operator answers. Do not retry work ops while blocked.`;
};

const msgSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — messages${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
${rowsFor(targets, [
  ["msg.list", `| read target thread | \`vellum-command msg list '{"target":"${t}"}'\` |`],
  ["msg.send", `| send durable mail | \`vellum-command msg send '{"target":"${t}","text":"..."}'\` |`],
  ["msg.send", `| reply | \`vellum-command msg reply '{"target":"${t}","text":"...","inReplyTo":"<msgId>"}'\` |`],
  ["msg.prompt", `| immediate turn (port msg.prompt) | \`vellum-command msg prompt '{"target":"${t}","text":"..."}'\` — requires a local idle peer with an empty composer; never interrupts |`],
  ["seat.wait", `| wait (port seat.wait) | \`vellum-command seat wait ${t} --until idle --timeout 30s\` — also supports attention, working, or gone |`],
  ["terminal.read", `| observe (port terminal.read) | \`vellum-command seat read ${t} --lines 40\` — settled grid, with state, reason, confidence and generation; output activity alone is not readiness |`],
])}

Own inbox: \`vellum-command msg list\` marks listed mail read; \`vellum-command msg react '{"messageId":"<msgId>"}'\` acknowledges without a reply. Mailbox delivery is pull-only (T3): check it at turn boundaries. Typed-notice paste is harness support, not a live-qualified delivery channel. Kinds are \`notice\`, \`prompt\`, and \`receipt\`; a typed notice says \`mail from <seat>\` (older rows may say \`[factory mail from …]\`). Avoid acknowledgement loops.

Crew prompt, sent receipts, seat wait and seat read require a configured Command Center. Prompt/wait/read require a local peer, and are unavailable for Remote seats. Ordinary durable mail remains available through its own grants.
${hasPort(targets, "msg.send") || hasPort(targets, "msg.prompt") ? "\nInspect sent delivery/read/reply facts with `vellum-command msg sent`; notification, read and reply are separate evidence. A successful enqueue is not proof of submission." : ""}
${hasPort(targets, "msg.prompt") ? `
Prompt outcomes are named: submitted, refused, or unresolved. After a pre-write refusal, wait for readiness and retry the returned messageId with \`vellum-command msg prompt '{"target":"${t}","messageId":"<messageId>"}'\`. An unresolved write is uncertain: inspect the peer and sent facts; never create a replacement prompt or repaste automatically. Notice fallback is explicit: add \`"fallback":"notice"\` only when durable mail is acceptable.` : ""}`;
};

const reviewsSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const authors = targets.map((target) => `\`${target.id}\``).join(", ");
  return `### Edge contract — reviews (authors: ${authors})

The directed \`verdict.post\` grant lets you review these authors on a configured Command Center. It grants no peer message, prompt, wait or terminal-read permission by itself. Read \`vellum-command msg list\` for review receipt mail, then inspect the cited work. Use the receipt's target board, task id, epoch and subjectHash exactly; \`tasks show\` is available only with a separate task-list grant.

\`vellum-command verdict post '{"target":"<task-board>","subject":{"kind":"task","taskId":"<taskId>","epoch":0,"subjectHash":"<subjectHash>"},"kind":"green","findings":[]}'\`

Use \`"kind":"blocking"\` with concrete nonempty findings when changes are needed. A blocking task review records the verdict and sends the task back with a defect and new epoch. Commit review uses \`"subject":{"kind":"commit","sha":"<full-sha>"}\`; it does not move a task. The server stamps your identity, refuses self-review, and rechecks the live reviews edge and exact subject. Stale-subject refusal requires a fresh receipt or authorized task read, never rebinding your old verdict to newer work.`;
};

const artifactSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — artifacts${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
| ship output | \`vellum-command artifact publish '{"target":"${t}","name":"<name>","parts":[{"kind":"text","text":"..."}]${TASKS_ENABLED ? `,"task":{"target":"<tasksId>","id":"<taskId>"}` : ""}}'\` |

Artifacts never block: ship intermediate and final outputs freely — they do not stop other seats.${TASKS_ENABLED ? ` When completing a task with an artifacts requirement, publish first with task linkage, then complete with \`completionEvidence.artifacts: [{"artifactId":"<id>","nodeId":"${t}"}]\`.` : ""}`;
};

const boardSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — board${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
${rowsFor(targets, [
  ["board.list", `| list | \`vellum-command board list '{"target":"${t}"}'\` |`],
  ["board.create_topic", `| create topic | \`vellum-command board topic '{"target":"${t}","title":"...","body":"..."}'\` |`],
  ["board.post", `| post | \`vellum-command board post '{"target":"${t}","topicId":"<topicId>","text":"..."}'\` |`],
  ["board.mark_read", `| mark read | \`vellum-command board read '{"target":"${t}","topicId":"<topicId>"}'\` |`],
])}

Optional shared context — never a decision inbox. \`read\` is enough to clear attention.`;
};

const padSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — pad${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
${rowsFor(targets, [
  ["pad.read", `| read page | \`vellum-command pad read '{"target":"${t}"}'\` |`],
  ["pad.read", `| text IR | \`vellum-command pad digest '{"target":"${t}"}'\` |`],
  ["pad.read", `| picture | \`vellum-command pad svg '{"target":"${t}"}'\` |`],
  ["pad.read", `| focused item | \`vellum-command pad get '{"target":"${t}","id":"<id>"}'\` |`],
  ["pad.read", `| look-here crop | \`vellum-command pad look-here '{"target":"${t}","pinId":"<pinId>"}'\` |`],
  ["pad.read", `| pins tagging you | \`vellum-command pad tagged '{"target":"${t}"}'\` |`],
  ["pad.patch", `| patch shapes | \`vellum-command pad patch '{"target":"${t}","patches":[{"op":"upsert","layer":"shape","shape":{"id":"box-1","type":"box","x":0,"y":0,"w":80,"h":40,"z":0}}]}'\` |`],
])}

With \`pad.patch\`, agents may upsert shapes, edges, and pin posts. Agent ink or image upserts are refused. Pin mentions must be inbound actor node ids — @ cannot name an unwired agent. Agents never write the factory canvas.`;
};

const sheetSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — sheet${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
| read the grid | \`vellum-command sheet read '{"target":"${t}"}'\` |

Grant is \`sheet.read\` via the edge. A sheet is a small operator-authored grid:
columns, rows, and plain text cells, returned as JSON plus a markdown table.
There is no write port — if a number in it is wrong, say so, do not fix it.`;
};

const browserSlot = (): string =>
  `### Edge contract — browser (page targets)

| intent | command |
|---|---|
${BROWSER_SLOT_ROWS}

${BROWSER_SLOT_DOCTRINE}`.trim();

export const EDGE_SLOT_BUILDERS: Readonly<
  Record<EdgeSlotKind, (targets: readonly InjectionConnectedTarget[]) => string>
> = {
  tasks: tasksSlot,
  escalate: escalateSlot,
  msg: msgSlot,
  reviews: reviewsSlot,
  artifacts: artifactSlot,
  board: boardSlot,
  pad: padSlot,
  sheet: sheetSlot,
  browser: () => browserSlot(),
};

const SLOT_PORTS: Readonly<Record<EdgeSlotKind, readonly Port[]>> = {
  tasks: ["tasks.list", "tasks.create", "tasks.claim", "tasks.update"],
  escalate: ["request.escalate"],
  msg: ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"],
  reviews: ["verdict.post"],
  artifacts: ["artifact.publish"],
  board: ["board.list", "board.create_topic", "board.post", "board.mark_read"],
  pad: ["pad.read", "pad.patch"],
  sheet: ["sheet.read"],
  browser: ["browser.automate"],
};

/** Group targets by the command families their canonical held ports permit. */
export const targetsBySlot = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): Map<EdgeSlotKind, InjectionConnectedTarget[]> => {
  const out = new Map<EdgeSlotKind, InjectionConnectedTarget[]>();
  for (const t of targets ?? []) {
    for (const slot of Object.keys(SLOT_PORTS) as EdgeSlotKind[]) {
      if (!BROWSER_ENABLED && slot === "browser") continue;
      // Reviews ride a task sink as their verdict target — without the tasks
      // surface the held verdict.post port has no command it can run.
      if (!TASKS_ENABLED && (slot === "tasks" || slot === "reviews")) continue;
      if (!SLOT_PORTS[slot].some((port) => t.ports?.includes(port))) continue;
      const list = out.get(slot);
      if (list) list.push(t);
      else out.set(slot, [t]);
    }
  }
  return out;
};

/** Compile the edge-contract sections for the connected targets. */
export const compileEdgeSlots = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): readonly string[] => {
  const grouped = targetsBySlot(targets);
  return [...grouped.entries()].flatMap(([slot, list]) => {
    // Only share a command example across targets that hold the same ports.
    // A wait-only peer must never become the example target for a send grant.
    const sameGrants = new Map<string, InjectionConnectedTarget[]>();
    for (const target of list) {
      const key = SLOT_PORTS[slot].filter((port) => target.ports?.includes(port)).join(",");
      const peers = sameGrants.get(key);
      if (peers) peers.push(target);
      else sameGrants.set(key, [target]);
    }
    return [...sameGrants.values()].map((peers) => EDGE_SLOT_BUILDERS[slot](peers));
  });
};

// ── Seat context block ─────────────────────────────────────────────────────

const formatConnectedTargets = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): string => {
  if (!targets || targets.length === 0) {
    return "(none at spawn — when the operator connects nodes, their contracts are injected here; re-run `vellum-command onboard` for the live map)";
  }
  return targets
    .map((t) => {
      const kind = t.kind?.trim() ? ` - ${t.kind.trim()}` : "";
      const summary = t.summary?.trim() ? ` — ${t.summary.trim()}` : "";
      return `- \`${t.id}\`${kind}${summary}`;
    })
    .join("\n");
};

/** Seat context block — slots filled at spawn. */
export const buildSeatContextSection = (
  ctx: Pick<InjectionContext, "seatRef" | "connectedTargets">,
): string => {
  const seat =
    typeof ctx.seatRef === "string" && ctx.seatRef.trim().length > 0
      ? ctx.seatRef.trim()
      : "(unknown at spawn — call `vellum-command onboard`)";
  return `## Seat context

- **Seat ref:** \`${seat}\` (context only; identity is process-bind)
- **Connected targets (at spawn):**
${formatConnectedTargets(ctx.connectedTargets)}

Re-run \`vellum-command onboard\` for the live map after compaction or edge changes.`;
};

// ── Operational notices (NOT doctrine variants) ────────────────────────────
//
// The doctrine has exactly ONE body: buildInjectionText, dynamic only by
// edges. Operational notices below are transport events — compact, targeted
// instructions (like the claim notice), never a second version of the prompt.

/**
 * Compact orient notice: tells an unproven seat to run onboard. Delivered by
 * the supervisor at most once per generation —
 * never the full doctrine (the agent already received it at spawn).
 */
/**
 * Worked examples for the doctrine — rendered from the canonical few-shot
 * payloads (shared/doctrine-few-shots.ts) that also feed the CLI examples
 * catalog, so the doctrine can never teach a JSON shape the catalog does not
 * print. Only compiled in for the slots the seat actually holds.
 */
const fewShotsForTargets = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): readonly DoctrineFewShotPayload[] => {
  if (!targets) return [];
  const out: DoctrineFewShotPayload[] = [];
  if (TASKS_ENABLED && targets.some((target) => target.ports?.includes("tasks.claim"))) out.push(FEW_SHOT_CLAIM);
  if (TASKS_ENABLED && targets.some((target) => target.ports?.includes("tasks.update"))) {
    out.push(FEW_SHOT_PROGRESS, FEW_SHOT_COMPLETE_EVIDENCE);
  }
  if (REQUESTS_ENABLED && targets.some((target) => target.ports?.includes("request.escalate"))) out.push(FEW_SHOT_ESCALATE);
  return out;
};

export const buildFewShotsSection = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): string => {
  const shots = fewShotsForTargets(targets);
  if (shots.length === 0) return "";
  const lines = ["## Worked examples", ""];
  for (const shot of shots) {
    // args are the full argv (["tasks", "claim", "{...}"]); render the whole
    // command so the copy-paste line is complete.
    lines.push(`\`vellum-command ${shot.args.join(" ")}\``);
    lines.push(`- ${shot.lesson}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n\n$/, "");
};

/**
 * Region briefing — operator-authored steering for a group of seats.
 * Deliberately a supplemental layer: marked, optional, and only present when
 * the seat's region actually carries an instruction at spawn.
 */
export const buildRegionBriefingSection = (
  instruction: string,
): string =>
  [
    "## Region briefing (operator-authored)",
    "",
    instruction.trim(),
  ].join("\n");

export const buildOrientNotice = (seatRef?: string): string =>
  [
    "Your seat's factory CLI: `vellum-command onboard`.",
    seatRef ? `Seat: \`${seatRef}\`.` : "",
    "Run it before anything else — it returns your seat, region, and grants.",
  ]
    .filter((l) => l.length > 0)
    .join(" ");

// ── Builders ───────────────────────────────────────────────────────────────

/**
 * Full injection body, or `null` for detached terminals.
 * Canvas seats always receive the base doctrine; edge contracts are compiled
 * from the connected targets at spawn.
 */
export const EDGE_CONTRACTS_INTRO = `### Edge contracts

The contracts below are **compiled from the edges connected at spawn** — you are only taught the commands your seat is authorized to run. When edges change mid-session, a compact map-change notice names the added/removed targets; the live command set is always \`vellum-command onboard\` / \`vellum-command capabilities\`.`;

export const buildInjectionText = (ctx: InjectionContext): string | null => {
  if (!ctx.seatBound) return null;
  const slots = ctx.connected ? compileEdgeSlots(ctx.connectedTargets) : [];
  return [
    "# Junto — factory work plane",
    "",
    JUNTO_INTRO,
    "",
    WORKER_DOCTRINE,
    "",
    SEAT_DOCTRINE,
    "",
    BASE_CONTRACT,
    "",
    // The edge-contracts intro only appears when contracts actually follow —
    // isolated seats are never promised commands that are not compiled in.
    ...(slots.length > 0 ? [EDGE_CONTRACTS_INTRO, ...slots] : []),
    // Worked examples (only for the slots compiled above — same source as the
    // CLI examples catalog, so they cannot drift).
    ...(ctx.connected ? [buildFewShotsSection(ctx.connectedTargets)] : []),
    "",
    buildSeatContextSection(ctx),
    // Operator-authored region briefing — supplemental layer, last on purpose
    // (the base doctrine stays immutable; this is per-region operator intent).
    ...(ctx.regionInstruction?.trim()
      ? ["", buildRegionBriefingSection(ctx.regionInstruction)]
      : []),
  ].join("\n");
};

// ── Rising-edge slot injection (mid-session edge connect) ──────────────────

export type EdgeMapChange = {
  readonly seatId: string;
  readonly added: readonly InjectionConnectedTarget[];
  readonly removed: readonly InjectionConnectedTarget[];
};

/**
 * Compact map-change notice — the operational event the agent asked for:
 * a one-line orient with ids only (Added/Removed). Command recipes and
 * contract tables are NOT in the notice — they live in `vellum-command
 * onboard` / `vellum-command capabilities`, which the notice points at.
 * Never a full doctrine re-injection, never a second doctrine variant.
 */
export const composeEdgeMapChangeNotice = (change: EdgeMapChange): string => {
  const fmt = (targets: readonly InjectionConnectedTarget[]): string =>
    targets.map((t) => `\`${t.id}\``).join(", ");
  const parts: string[] = [];
  if (change.added.length > 0) {
    parts.push(`Added: ${fmt(change.added)}`);
  }
  if (change.removed.length > 0) {
    parts.push(`Removed: ${fmt(change.removed)}`);
  }
  if (parts.length === 0) {
    return "[factory - map] edge map unchanged — re-run `vellum-command capabilities` for the live grant list.";
  }
  return `[factory - map] edge contracts changed — ${parts.join(". ")}. Re-run \`vellum-command capabilities\` for the live grant list.`;
};

/**
 * The complete input this diff reads out of a document: every node's kind by
 * id, first-occurrence-wins exactly as `Array.prototype.find` resolved it.
 *
 * Built once per document instead of re-walked per edge endpoint. The old
 * shape put `doc.nodes.find` inside the per-edge loop and then again inside
 * `isSeat`, so one commit cost O(edges x nodes) — on a 96-node board that is
 * tens of thousands of id comparisons for a diff that is almost always empty.
 */
const kindsById = (doc: CanvasDoc): ReadonlyMap<string, string | undefined> => {
  const out = new Map<string, string | undefined>();
  for (const node of doc.nodes) {
    // First occurrence wins: `find` returned the first match, and a document
    // with a duplicated id must keep resolving to the same node it did.
    if (out.has(node.id)) continue;
    out.set(node.id, node.ether?.entity?.kind);
  }
  return out;
};

/**
 * True when the two documents carry the same adjacency input.
 *
 * `planEdgeMapChanges` reads exactly three things: the ordered edge endpoints,
 * and each node's id and entity kind in order. When all three match position
 * for position the diff is provably empty, which is why this can short-circuit
 * rather than merely hint. Positional (not set) comparison keeps it sound in
 * the other direction too: a reordered document simply falls through to the
 * full computation and gets the same answer it always did.
 *
 * This is the gate the recompute never had. A canvas commit fires the listener
 * for ANY authorial change, and the overwhelming majority of them are geometry
 * — a dragged node, a resized region — which cannot move a single edge grant.
 */
const sameEdgeMapInput = (a: CanvasDoc, b: CanvasDoc): boolean => {
  if (a === b) return true;
  if (a.edges.length !== b.edges.length) return false;
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.edges.length; i += 1) {
    const x = a.edges[i];
    const y = b.edges[i];
    if (x.fromNode !== y.fromNode || x.toNode !== y.toNode) return false;
    // A verb swap moves the compiled grant without moving any endpoint, so
    // the seat's edge map must be revised for it like any rewiring.
    if (x.ether?.verb !== y.ether?.verb) return false;
  }
  for (let i = 0; i < a.nodes.length; i += 1) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (x.id !== y.id) return false;
    if (x.ether?.entity?.kind !== y.ether?.entity?.kind) return false;
  }
  return true;
};

/**
 * Edge-map diff for actor seats: added AND removed slot-bearing neighbors.
 * Pure — no I/O. Callers skip when `previous` is missing (open / first paint).
 */
export const planEdgeMapChanges = (
  previous: CanvasDoc,
  next: CanvasDoc,
): ReadonlyArray<EdgeMapChange> => {
  if (sameEdgeMapInput(previous, next)) return [];

  const previousKinds = kindsById(previous);
  const nextKinds = kindsById(next);
  const adjacency = (
    doc: CanvasDoc,
    kinds: ReadonlyMap<string, string | undefined>,
  ): Map<string, InjectionConnectedTarget[]> => {
    const out = new Map<string, InjectionConnectedTarget[]>();
    for (const edge of doc.edges) {
      for (const [a, b] of [
        [edge.fromNode, edge.toNode],
        [edge.toNode, edge.fromNode],
      ] as const) {
        // Absent node and node-without-kind were both `continue` before and
        // stay both `continue` now: `get` returns undefined for either.
        const kind = kinds.get(b);
        if (kind === undefined || KIND_TO_SLOT[kind] === undefined) continue;
        const list = out.get(a);
        const target: InjectionConnectedTarget = { id: b, ...(kind !== undefined ? { kind } : {}) };
        if (list) list.push(target);
        else out.set(a, [target]);
      }
    }
    return out;
  };

  const before = adjacency(previous, previousKinds);
  const after = adjacency(next, nextKinds);
  const isSeat = (
    kinds: ReadonlyMap<string, string | undefined>,
    id: string,
  ): boolean => kinds.get(id) === "agent";
  const key = (t: InjectionConnectedTarget): string => `${t.kind ?? ""}:${t.id}`;
  const changes: EdgeMapChange[] = [];
  for (const seatId of new Set([...before.keys(), ...after.keys()])) {
    if (!isSeat(nextKinds, seatId) && !isSeat(previousKinds, seatId)) continue;
    const prev = new Set((before.get(seatId) ?? []).map(key));
    const nextSet = new Set((after.get(seatId) ?? []).map(key));
    const added = (after.get(seatId) ?? []).filter((t) => !prev.has(key(t)));
    const removed = (before.get(seatId) ?? []).filter((t) => !nextSet.has(key(t)));
    if (added.length === 0 && removed.length === 0) continue;
    changes.push({
      seatId,
      added: [...added].sort((a, b) => a.id.localeCompare(b.id)),
      removed: [...removed].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  return changes.sort((a, b) => a.seatId.localeCompare(b.seatId));
};

// ── Plan (tier + body for spawn / drive) ───────────────────────────────────

export type ManagedInjectionPlan = {
  /** False for detached terminals — nothing to inject or type. */
  readonly inject: boolean;
  readonly tier: InjectionTier;
  /**
   * Tier A body for spawn flags (`--append-system-prompt` / `--rules`).
   * Undefined when not injecting or when tier B.
   */
  readonly systemPrompt?: string;
  /**
   * Tier B first typed message (same text body as Tier A system prompt).
   * Undefined when not injecting or when tier A.
   */
  readonly firstTypedMessage?: string;
};

/**
 * Resolve what to inject for a harness + seat context.
 * Tier A → systemPrompt for resolve-launch flags.
 * Tier B → firstTypedMessage for ManagedTerminalDrive after idle.
 * Detached terminal → inject: false, no body. Canvas seat → base (+ slots).
 */
export const planManagedInjection = (
  harness: HarnessId,
  ctx: InjectionContext,
): ManagedInjectionPlan => {
  const tier = templateFor(harness).injectionSpec.tier;
  const text = buildInjectionText(ctx);
  if (text === null) {
    return { inject: false, tier };
  }
  if (tier === "A") {
    return { inject: true, tier, systemPrompt: text };
  }
  return { inject: true, tier, firstTypedMessage: text };
};

// ── Bootstrap marker ────────────────────────────────────────────────────
// Marker: transport tag for echo-tracking typed payloads — NOT doctrine
// content. The doctrine has exactly ONE body: buildInjectionText, dynamic
// only by edges (InjectionContext).

/**
 * Marker prefix for bootstrap charters. Each binding gets a deterministic
 * 8-hex digest suffix, so a seat can recognize its own charter across
 * re-injections without the marker exposing the binding itself.
 */
export const BOOTSTRAP_MARKER_PREFIX = "[vc-";

/**
 * Deterministic per-binding marker: `[vc-<fnv1a64(bindingId)[0..8]>]`.
 * Pure JS (BigInt FNV-1a 64) — no node:crypto, so this module stays
 * importable from the renderer bundle (node:crypto is externalized by Vite).
 * The marker is a transport tag for echo-tracking typed payloads, not
 * doctrine content; collisions only mean two seats share an echo token.
 */
const fnv1a64Hex = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 8);
};

export const buildBootstrapMarker = (bindingId: string): string =>
  `${BOOTSTRAP_MARKER_PREFIX}${fnv1a64Hex(bindingId)}]`;

/**
 * Prefix the payload with the seat marker. A one-line body stays one line
 * (`[vc-…] body`) so ink TUIs do not collapse the notice into a
 * `[Pasted text #N]` chip. Multiline bodies keep the marker on the first
 * line — never a blank separator that forces an extra chip line.
 */
export const appendBootstrapMarker = (
  text: string,
  bindingId: string,
): string => {
  const marker = buildBootstrapMarker(bindingId);
  const body = text.trim();
  if (!body.includes("\n")) return `${marker} ${body}`;
  return `${marker}\n${body}`;
};
