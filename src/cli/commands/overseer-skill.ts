/** Product-embedded overseer skill text. Not a global Amp skill install. */
import { BOARD_ENABLED, PAD_ENABLED } from "@shared/features";
import { SEAT_FIELDS_MAIN_WORKS_OUT } from "@shared/model/drafts";
import { OVERSEER_CATALOG } from "@shared/overseer-control";

export const OVERSEER_SKILL_NAME = "overseer";

// The skill is a product surface: families a feature gate turned off leave
// the list and their verb notes with them.
const ENABLED_FAMILIES: ReadonlyArray<string> = [
  "status",
  ...new Set(
    OVERSEER_CATALOG
      .map((entry) => entry.family)
      .filter((family) => family !== "overseer"),
  ),
];

const FAMILY_VERB_NOTES = [
  BOARD_ENABLED ? "Board uses `create-topic` and `mark-read`;" : "",
  PAD_ENABLED ? "pad uses `look-here`." : "",
].filter((note) => note.length > 0).join(" ");

export const OVERSEER_SKILL_MARKDOWN = `---
name: overseer
description: "Runs Junto overseer operations from a process-bound granted seat. Use for canvas, node, wire, and work-plane command as an overseer agent; also for offline schema, examples, and authority boundaries."
---

# Junto overseer

JSON-only CLI for a managed agent seat whose operator turned on overseer with the human-only toggle. Ordinary agents stay edge-scoped. Overseers do not need edges.

Identity is process-bind (Unix peer PID). Never send a nodeRef, actor claim, or operator seat id.

## Offline vs live

These work with no daemon, socket, or grant:

- \`junto overseer skill\`
- \`junto overseer schema list|show\`
- \`junto overseer examples list|show\`
- \`junto overseer capabilities\`
- \`junto schema\` / \`examples\` (includes overseer contracts)
- \`junto docs overseer\`
- \`junto overseer --help\`

Everything else talks to the existing work socket as outer op \`overseer\`.

## Invocation

\`\`\`
junto overseer <family> <verb> [json | @file | -]
junto overseer status
\`\`\`

Input is a JSON object: inline, \`@path\`, or \`-\` / \`@-\` for stdin. Omit input for empty-arg operations (\`{}\`). Canvas may be omitted when the caller's canvas is unambiguous; main fills it.

## Nodes and wires

The canvas speaks the model's own types. Nothing is a document node, and nothing is named \`ether\`.

- A **node** is told by its \`kind\`: \`agent\` (a seat), \`terminal\`, \`page\`, \`task\`, \`requests\`, \`artifacts\`, \`board\`, \`pad\`, \`sheet\`, \`cron\`, \`relay\`, \`watcher\`, \`note\`, \`label\`, \`file\`, \`link\`, \`git\`, \`region\`. Each kind has its own flat fields beside \`id\`, \`x\`, \`y\`, \`width\`, \`height\`, \`z\` and an optional \`color\`. A seat has \`agentKey\`, \`label\`, \`host\`, \`overseer\`, \`bindingId\`, \`harness\`, \`launch\`, \`onRemove\`; a cron has \`expression\`; a region has \`label\`, \`hold\`, \`instruction\`, \`defaults\`, \`contract\`, \`environment\`. \`junto overseer schema show node.create\` prints every kind.
- A **wire** is \`{id, from, to, verb, mask?, fromSide?, toSide?}\`. \`from\` is the end that acts.

Reads: \`canvas read\` answers \`{name, seq, nodes, wires}\`, nodes in paint order. \`node list\` answers \`{nodes}\`, \`node get\` \`{node}\`, \`wire list\` \`{wires}\`, \`wire get\` \`{wire}\`, \`canvas list\` one \`{name}\` per canvas. \`seq\` is a number that counts committed changes to that canvas.

Reads answer structure, not work. No tasks, requests, artifacts, mail or board topics ride on a node. Read work with its own command: \`tasks list\`, \`request list\`, \`artifact list\` and \`artifact get\`, \`msg list\`, \`board list\`, \`sheet read\` (each where this build has that family). \`canvas digest\` is the digest text main also writes for the window and the CLI, with the work on each node and without live adapter snapshot data.

Writes:

- \`node create {canvas?, node}\`: the node with its kind's fields. Leave \`id\` out for main to mint it and do not send \`z\`: a new node goes on top. The answer is the node with its id.
- **A seat is created by naming what it runs, never by a command line**: \`{kind: "agent", harness, x, y, width, height}\` plus any of \`profile\`, \`model\`, \`effort\`, \`mode\`, \`permissionMode\`, \`cwd\`, \`host\`, \`label\`, \`onRemove\`, \`color\`, \`id\`. \`harness\` is the only required choice; \`host\` defaults to this machine, \`label\` to the harness and its choices, \`onRemove\` to \`detach\`. Main builds the launch, the agent key and the session. A seat draft that carries any of ${SEAT_FIELDS_MAIN_WORKS_OUT.map((field) => `\`${field}\``).join(", ")} is refused, never ignored. A plain \`terminal\` is the kind that takes a \`launch\` with a command.
- \`node configure {canvas?, nodeId, change}\`: \`change\` is the edit for the node's kind, \`{kind, field: value}\`. Name a field to set it; give \`null\` to clear one that may be absent. A \`kind\` that is not the node's kind is refused with the node's actual kind. It cannot carry which agent a seat runs (\`agentKey\`, \`bindingId\`: use \`agent reseat\`) or \`overseer\` (only the operator grants it).
- \`node move {nodeId, x, y}\`, \`node resize {nodeId, width, height}\`.
- \`node recolor {nodeIds, color}\`: one color for many nodes, \`null\` clears it. Color is not part of \`change\`.
- \`node delete {nodeIds}\`: one or many. Wires at either end go with them.
- \`wire connect {canvas?, wire: {id?, from, to, verb?, mask?, fromSide?, toSide?}}\`: leave \`verb\` out for the default the two kinds allow. The answer is the wire with the id main minted. \`wire verbs {from, to}\` lists what a pair allows.
- \`wire configure {canvas?, wireId, change: {verb?, mask?, fromSide?, toSide?}}\`, \`null\` clearing \`mask\` or a side. \`wire disconnect {wireId}\`.
- \`scheduler configure {nodeId, change}\` with the cron or watcher edit. \`agent reseat {nodeId, harness, host?, profile?, model?, effort?, mode?, permissionMode?}\` puts another agent on the same seat by naming what it runs, the same choices as creating one: no command line, no \`agentKey\`. The seat keeps its wires, its mailbox and the directory it starts in.

\`canvas batch {canvas?, expectedSeq?, steps}\` takes 1–100 \`steps\` on one canvas, for mixed edits: \`node.create\`, \`node.configure\`, \`node.move\`, \`node.resize\`, \`node.recolor\`, \`wire.connect\`, \`wire.configure\` and \`wire.disconnect\`. Each step is \`{operation, ...}\` with the fields of the write of that name, without a nested args object or canvas. Give a new node an \`id\` when a later step names it. The whole batch is validated and committed once: it all lands or none of it does. Pass \`expectedSeq\`, the \`seq\` that \`canvas read\` answered, to refuse a stale edit: a canvas that has moved since answers \`Conflict\`. Deleting nodes, reseating, grants, credentials, nested batches and worker execution are not batch steps.

The family once called \`edge\` is \`wire\`. No old shape is accepted: a document node (\`type\`, \`text\`, \`ether\`), \`fromNode\` / \`toNode\`, \`edgeId\`, \`changes\`, \`operations\` or \`expectedRevision\` is \`InvalidArguments\`. When an argument is refused, read its shape: \`junto overseer schema show <operation>\`.

Success (stdout): \`{ok:true, command, data}\` — \`data\` is the inner operation payload.
Failure (stderr, exit 1): \`{ok:false, command, error:{type,message,details?}}\`.

Wire: \`{op:"overseer", args:{operation, args}}\`. Outer work errors are auth, process-bind, and transport. Executed dispatcher outcomes arrive as inner \`OverseerResult\`; an inner \`ok:false\` is a command failure, never a CLI success.

## Families

${ENABLED_FAMILIES.join(", ")}

Verbs match \`OVERSEER_OPERATION_NAMES\` (dots become family + verb). ${FAMILY_VERB_NOTES} \`overseer status\` is live grant/surface, not git.

Remote seats are supported on the same CLI. Station transport is not this command.

## Offboarding seats

A seat is permanent and its session grows. A harness keeps a session cheap to continue only while its cache is warm; a seat that sat still past that window pays for its whole history again on its next turn. Two actions cut a session, each over one or many seats:

- \`agent offboard {nodeIds, action?, mode?}\` with \`action: "ask"\` (the default) asks each seat's agent to offboard. It finishes its step, writes its own notes, and offboards. \`mode: "continue"\` (the default) starts a fresh session right away from its continuation note; \`mode: "rest"\` lets the seat rest until mail wakes it. The moment the agent's offboard command returns, the seat has moved on: the old session may finish what it is saying, but it receives nothing more and its junto commands are refused. It costs the seat one turn: right while the cache is warm.
- \`action: "now"\` has Junto end the session itself: no turn, no notes. It works only on a seat that is idle, offline or resting. Any other seat is refused with the reason, never queued. \`mode\` is not allowed with \`now\`. Right once the cache window has passed.

The answer is one row per seat, in the order asked: \`{seatId, title?, ok: true, action, outcome, pastWindow}\` with outcome \`asked\` or \`closed\`, or \`{seatId, title?, ok: false, code, reason, pastWindow?}\`, plus the counts \`closed\`, \`asked\` and \`refused\`. \`seatId\` is the canvas node id. Codes: \`working\`, \`attention\`, \`closing\`, \`not-a-seat\`, \`not-local\`, \`undelivered\`, \`failed\`; \`reason\` is the sentence to show. A refused seat does not fail the command: the result prints whole on stdout and the exit code is non-zero when \`refused\` is above zero.

\`agent offboard-status {nodeIds}\` answers before you act: whether \`now\` is allowed for each seat, how many minutes it has sat still, whether it is past its cache window, and the \`preferred\` action (\`now\` once past the window, else \`ask\`). Read it, then offboard the seats by their preferred action. Each row also carries \`workMinutes\` (time worked in this session), \`sessionTokens\` (the transcript as a token estimate, absent when it cannot be located) and \`worthCutting\` (what the automatic rules would say). \`agent offboard\` itself is not held to \`worthCutting\`.

Four settings per installation do the same without anyone asking, each optionally overridden per harness:

- \`cacheWindowMinutes\`: how long a still seat stays cheap to give a turn.
- \`nudge {enabled, minutes}\`: ask a motionless seat's agent to offboard. Must come before the cache window.
- \`auto {enabled, minutes}\`: end a session that has sat still this long, at the moment its resting seat is about to be woken, so the seat wakes into a fresh one. Never on a timer and never in a batch. Must come at or after the cache window.
- \`worth {workMinutes, tokens}\`: the automatic rules act only on a session that worked at all and either worked this long or has a transcript of about this many tokens.

\`agent offboard-rules\` reads \`{rules, effective}\`: the installation's rules with any \`harness\` overrides, and what they come to for each harness. \`agent offboard-configure\` takes a partial of the rules, changes only the fields given, and answers in the same form. \`harness: {<id>: {...}}\` sets an override for one harness; \`harness: {<id>: null}\` removes it. Minutes and tokens are whole numbers. A combination the rules forbid is refused with the reason and nothing is saved.

## Region environment and secrets

A region (group node) may carry an \`environment\`: ordered sources that name where a variable comes from on the machine, extra folders, and a sealed switch. A seat is launched with what every region containing it provides, outermost first; an inner region overrides an outer one by variable name, and within a region a later source overrides an earlier one. A change applies when the seat restarts.

The canvas holds names and references only. The one value it ever stores is a \`kind: "value"\` source, which is not secret.

- \`env show {nodeId}\` reads the environment as stored.
- \`env source-add {nodeId, source, index?}\` appends a source, or inserts it at \`index\`. Omit \`source.id\` and one is generated; the result names it. Kinds: \`value\`, \`secret\`, \`keychain\`, \`keyring\`, \`onepassword\`, \`envFile\`, \`secretsDir\`, \`command\`. \`junto overseer schema show env.source-add\` has every field.
- \`env source-edit {nodeId, sourceId, source}\` replaces that source whole and keeps its id.
- \`env source-remove {nodeId, sourceId}\`, \`env source-reorder {nodeId, sourceIds}\` (the complete new order).
- \`env seal {nodeId, sealed}\`: seats inside a sealed region inherit nothing from regions outside it.
- \`env folders {nodeId, folders}\` sets the whole list, absolute or \`~/\` paths.
- \`env doctor {nodeId?}\` prints what seats would launch with: names, kinds, origins and status, never a value. Whole canvas, or one region or seat. It exits non-zero when a source marked \`required\` is \`missing\` or in \`error\`, and still prints the full report.

Prefer what the operator already has: an existing Keychain item (\`keychain\`), an existing 1Password reference (\`onepassword\`), an env file they keep (\`envFile\`). Reach for Junto's own store only for a value that lives nowhere else.

\`secret\` is Junto's own secret store on the machine that runs the command; it is never forwarded to another installation.

- \`secret put [{secretId}]\` saves a value and returns \`{secretId, stored, backend}\`. **The value is read from stdin only**: \`printf %s "$VALUE" | junto overseer secret put\`. A \`value\` key in the argument, a terminal on stdin, or an empty value is refused. Exactly one trailing newline is stripped. Without \`secretId\` a new id is minted; with one, the value behind it is replaced. Name the id in a \`{kind: "secret", name, secretId}\` source.
- \`secret delete {secretId}\`, \`secret list\` (ids only).

No operation returns a secret value. Do not put one in an argument, a \`value\` source, a message, or a note.

\`references\` and \`briefing\` are the operator's own texts, kept in Junto. The briefing is one text every seat gets at \`junto onboard\`. A reference is a named piece of prose that onboard only lists; a seat reads it with \`junto references read <name>\`. Without \`regionId\` a command acts on the app-wide references; with it, on that region's (\`canvas\` defaults to your own).

- \`references list {canvas?, regionId?}\`, \`references read {name, canvas?, regionId?}\`, \`references delete {name, canvas?, regionId?}\`.
- \`references write {name, description?, canvas?, regionId?}\` creates or replaces one. **Give the prose with \`--body <text | @file | ->\`** so it is never JSON-escaped: \`junto overseer references write '{"name":"style"}' --body @style.md\`. \`"body"\` in the argument also works; both at once is refused. A name is lower-cased, 1 to 80 characters of letters, digits, dot, underscore and dash. An empty body is refused: delete instead.
- \`briefing read\`, \`briefing write --body <text | @file | ->\`.

A seat inside a region sees that region's reference in place of an outer or app-wide one of the same name.

## Implemented here (CLI)

- Catalog encode, strict arg decode, work-socket transport for every \`OverseerOperation\`
- Offline skill, schema, examples, capabilities, help
- Inner result unwrap (nonzero on inner error)
- Useful machine errors (\`InputError\`, \`AuthError\`, \`RuntimeDown\`, \`Forbidden\`, \`Unsupported\`, …)

This CLI does **not** claim that a running daemon has a handler for every verb. Live handler availability is \`overseer status\` (or an \`Unsupported\` / \`NotFound\` error). Do not treat catalog presence as handler presence.

## Unavailable (never this CLI, never an overseer)

| Capability | Why |
|---|---|
| Grant or revoke overseer | Human-only toggle (\`canvasOverseerSet\`). Overseers cannot propagate. |
| Delete own seat | Direct, indirect, canvas delete, alias, or binding replacement that removes this seat. Ordinary self move/rename/interrupt/stop are allowed. |
| Change what an overseer seat runs, remove it, or reseat it | Operator only, for any overseer seat, your own included: its agent, session, harness, host and launch. Refused as \`Forbidden\` with "Only the operator can change what an overseer seat runs or remove it." Renaming, moving, resizing and recoloring an overseer seat are allowed. |
| Operator viewport | No pan, zoom, focus, resize, or switch. Screenshots observe only. |
| Set a seat's \`overseer\` field | No draft or change carries it: create, copy, configure, reseat, and generic writes cannot mint or restore the grant. Reseat does not inherit. |
| Pause/play as authority | Pause/play gates automated work only. It has no bearing on overseer command. |
| Direct DB / operator socket / arbitrary IPC | Closed operations over the work envelope only. |
| Caller-supplied principal | Process-bind only. |

## Workflows

1. Load this skill offline: \`junto overseer skill\`
2. Inspect args: \`junto overseer schema show canvas.create\`
3. Copy an example: \`junto overseer examples show node.create\`
4. Run under the live granted agent process (not a random shell).
5. Prefer \`overseer status\` first. If the socket is down: launch Junto, then \`junto doctor\`.
6. Mutate with expected canvas/node ids from list/read. Use \`overseer canvas batch\` for a coherent structural edit; task creation and worker actions use their own operations.
7. On \`Forbidden\` / \`Unsupported\`, stop. Do not retry as the operator.

## Authority (exact)

- Overseer is a managed agent seat flag, not a new actor kind. CC and Remote.
- Operator-equivalent canvas/node/work access without edges. Kernel auto-claim is not broadened. No manufactured edges.
- Attribution stays the overseer, never the operator.
- Ordinary agents remain edge-scoped.
- \`node.configure\` / create drafts have no overseer grant field.

## Errors

- \`InputError\` — JSON or catalog args (offline; no socket)
- \`RuntimeDown\` — no app / no socket / empty token
- \`AuthError\` — process-bind or token
- Inner \`Forbidden\` \`InvalidArguments\` \`NotFound\` \`Conflict\` \`Unsupported\` \`RuntimeDown\` \`InternalError\`
`;
