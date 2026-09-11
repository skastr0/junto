/** Product-embedded overseer skill text. Not a global Amp skill install. */

export const OVERSEER_SKILL_NAME = "overseer";

export const OVERSEER_SKILL_MARKDOWN = `---
name: overseer
description: "Runs Vellum Command overseer operations from a process-bound granted seat. Use for canvas, node, edge, and work-plane command as an overseer agent; also for offline schema, examples, and authority boundaries."
---

# Vellum Command overseer

JSON-only CLI for a managed agent seat whose operator set \`ether.overseer\` with the human-only toggle. Ordinary agents stay edge-scoped. Overseers do not need edges.

Identity is process-bind (Unix peer PID). Never send a nodeRef, actor claim, or operator seat id.

## Offline vs live

These work with no daemon, socket, or grant:

- \`vellum-command overseer skill\`
- \`vellum-command overseer schema list|show\`
- \`vellum-command overseer examples list|show\`
- \`vellum-command overseer capabilities\`
- \`vellum-command schema\` / \`examples\` (includes overseer contracts)
- \`vellum-command docs overseer\`
- \`vellum-command overseer --help\`

Everything else talks to the existing work socket as outer op \`overseer\`.

## Invocation

\`\`\`
vellum-command overseer <family> <verb> [json | @file | -]
vellum-command overseer status
\`\`\`

Input is a JSON object: inline, \`@path\`, or \`-\` / \`@-\` for stdin. Omit input for empty-arg operations (\`{}\`). Canvas may be omitted when the caller's canvas is unambiguous; main fills it. Do not batch unless a future catalog says so.

Success (stdout): \`{ok:true, command, data}\` — \`data\` is the inner operation payload.
Failure (stderr, exit 1): \`{ok:false, command, error:{type,message,details?}}\`.

Wire: \`{op:"overseer", args:{operation, args}}\`. Outer work errors are auth, process-bind, and transport. Executed dispatcher outcomes arrive as inner \`OverseerResult\`; an inner \`ok:false\` is a command failure, never a CLI success.

## Families

status, canvas, node, edge, tasks, request, artifact, msg, board, pad, sheet, content, agent, terminal, page, scheduler, git

Verbs match \`OVERSEER_OPERATION_NAMES\` (dots become family + verb). Board uses \`create-topic\` and \`mark-read\`; pad uses \`look-here\`. \`overseer status\` is live grant/surface, not git.

Remote seats are supported on the same CLI. Station transport is not this command.

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

1. Load this skill offline: \`vellum-command overseer skill\`
2. Inspect args: \`vellum-command overseer schema show canvas.create\`
3. Copy an example: \`vellum-command overseer examples show node.create\`
4. Run under the live granted agent process (not a random shell).
5. Prefer \`overseer status\` first. If the socket is down: launch Vellum Command, then \`vellum-command doctor\`.
6. Mutate with expected canvas/node ids from list/read. Structural batches are a main concern; this CLI sends one operation per invocation.
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
