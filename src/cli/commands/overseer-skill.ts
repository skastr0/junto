/** Product-embedded overseer skill text. Not a global Amp skill install. */
import { BOARD_ENABLED, PAD_ENABLED } from "@shared/features";
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
description: "Runs Junto overseer operations from a process-bound granted seat. Use for canvas, node, edge, and work-plane command as an overseer agent; also for offline schema, examples, and authority boundaries."
---

# Junto overseer

JSON-only CLI for a managed agent seat whose operator set \`ether.overseer\` with the human-only toggle. Ordinary agents stay edge-scoped. Overseers do not need edges.

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

\`canvas.batch\` accepts 1–100 structural \`operations\` on one canvas: \`node.create\`, \`node.configure\`, \`node.move\`, \`edge.connect\`, \`edge.configure\`, and \`edge.disconnect\`. Each step has its operation plus the usual fields, without a nested args object or canvas. Assign IDs to new nodes when later steps reference them. The complete graph is validated and committed once. Supply \`expectedRevision\` from \`canvas.read\` to reject stale edits. Native identity/configuration changes, resource deletion, grants, credentials, nested batches, and worker execution are excluded.

Success (stdout): \`{ok:true, command, data}\` — \`data\` is the inner operation payload.
Failure (stderr, exit 1): \`{ok:false, command, error:{type,message,details?}}\`.

Wire: \`{op:"overseer", args:{operation, args}}\`. Outer work errors are auth, process-bind, and transport. Executed dispatcher outcomes arrive as inner \`OverseerResult\`; an inner \`ok:false\` is a command failure, never a CLI success.

## Families

${ENABLED_FAMILIES.join(", ")}

Verbs match \`OVERSEER_OPERATION_NAMES\` (dots become family + verb). ${FAMILY_VERB_NOTES} \`overseer status\` is live grant/surface, not git.

Remote seats are supported on the same CLI. Station transport is not this command.

## Offboarding seats

A seat's session grows long and costly. Two actions cut it, each over one or many seats:

- \`agent offboard {nodeIds, action?, mode?}\` with \`action: "ask"\` (the default) mails each seat the operator's offboard prompt. The agent finishes its step, writes its own notes, and offboards. \`mode: "continue"\` (the default) starts a fresh session right away from its continuation note; \`mode: "rest"\` lets the seat rest until mail wakes it.
- \`action: "now"\` has Junto end the session itself, with no notes from the agent. It works only on a seat that is idle, offline or resting. Any other seat is refused with the reason, never queued. \`mode\` is not allowed with \`now\`.

The answer is one row per seat, in the order asked: \`{nodeId, title?, ok: true, action, outcome}\` or \`{nodeId, ok: false, reason}\`, plus \`refused\`, the count of refused seats. A refused seat does not fail the command: the result prints whole on stdout and the exit code is non-zero when \`refused\` is above zero. An unknown node, or one that is not an agent seat, is a refused row.

Prefer \`ask\`: the notes are what the next session starts from. Use \`now\` for a seat that is already idle and has nothing to hand on. You cannot ask your own seat; run \`junto offboard\` yourself.

Two rules run per installation, without anyone asking:

- \`agent offboard-rules\` reads them: \`{auto: {enabled, minutes}, nudge: {enabled, minutes}}\`. \`auto\` offboards a seat after that long (on, 120 minutes by default); \`nudge\` nudges a seat idle that long (off, 40 minutes by default).
- \`agent offboard-configure {auto?, nudge?}\` sets only the fields given and returns the rules after the change.

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
| Delete own seat | Direct, indirect, canvas delete, alias, or binding replacement that removes this seat. Ordinary self move/rename/configure/interrupt/stop are allowed. |
| Operator viewport | No pan, zoom, focus, resize, or switch. Screenshots observe only. |
| Mint \`ether.overseer\` | Create, copy, configure, reseat, and generic writes cannot mint or restore the grant. Reseat does not inherit. |
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
