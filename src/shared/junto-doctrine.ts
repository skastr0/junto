/**
 * The Junto doctrine: the reference a seat reads on demand.
 *
 * Nothing here is sent to a harness. `junto onboard` loads the short version
 * (shared/seat-onboarding.ts); this module is the long one, served by
 * `junto docs doctrine`, `junto docs concepts` and `junto docs node <kind>`.
 * The per-kind contract tables render the same command rows onboard compiles,
 * so the reference cannot teach a command onboard would not.
 *
 * Pure module, no Node imports (renderer-safe).
 */

import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  REQUESTS_ENABLED,
  REVIEWS_ENABLED,
  TASKS_ENABLED,
} from "./features";
import { PAST_SESSIONS_FRAMING } from "./seat-sessions";
import {
  FEW_SHOT_CLAIM,
  FEW_SHOT_COMPLETE_EVIDENCE,
  FEW_SHOT_BLOCKED,
  FEW_SHOT_PROGRESS,
  type DoctrineFewShotPayload,
} from "./doctrine-few-shots";
import {
  COMMAND_FAMILIES,
  commandGroupsFor,
  type CommandFamily,
  type CommandGroup,
  type ConnectedTarget,
} from "./seat-onboarding";

// ── Intro / seat doctrine (base) ───────────────────────────────────────────

/**
 * Work-surface words the intro names. A feature-gated surface leaves the
 * doctrine with its product gate; the sentence is descriptive, so a
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

You are running inside **Junto** — a collaborative workspace where coding agents work as peers on a shared canvas. The canvas is your operational environment: nodes are work surfaces (${WORK_SURFACE_WORDS.join(", ")}), and **edges are your permissions**. Your seat is the node you occupy; everything you may inspect or touch is edge-connected to you. All collaboration and work operations go through one CLI: \`junto\`.`;


/** Seats — durable per-agent identity on the canvas, where grants accrue. */
export const SEAT_DOCTRINE = `## Seats

A **seat** is your identity on the canvas: the node you occupy, bound to your process. The seat is durable — it persists across sessions and restarts, and it is where grants, memory, and experience accumulate over time.

- **Grants** come from each authored edge verb and its operator mask. A mask only removes ports. A messages edge can grant mail, prompts, waits and terminal reads${REVIEWS_ENABLED ? "; a directed reviews edge grants \`verdict.post\` only from reviewer to author" : ""}.${TASKS_ENABLED ? " Task verbs differ on claiming and authoring." : ""} \`capabilities\` gives the actual held ports; a neighboring kind alone proves no permission.
- **Identity** is process-bind: the OS proves who you are. You cannot claim another seat, and no env var makes you someone else.
- **Orientation** is one command: \`junto onboard\` returns your seat, role, region briefing, connected targets ${TASKS_ENABLED ? "with grants and their board contracts" : "with their grants"}, and co-members. Re-run it whenever your view may be stale.
${TASKS_ENABLED ? "- **Rulings** are operator precedent pinned to a region. They stand over every seat inside it: `junto rulings`.\n" : ""}\n**Connection messages are informational.** When the operator changes your edges, Junto sends a short message naming what you can now reach or no longer reach. It is not a command to re-run \`onboard\`/\`capabilities\` every time. Onboard once per session, and again only when you actually need the live map to act. Idle chatter (ack-for-ack) is wasteful: acknowledge once, then stay quiet until real work or a new request arrives.`;

// ── Worker doctrine (base) ─────────────────────────────────────────────────

/** Blocking law: declare it with a signal; the task state follows when there is one. */
const BLOCKED_SECTION = `### When you are blocked

Say so with \`junto blocked "<what you need>"\`${TASKS_ENABLED ? ", and set the task to \`input-required\`" : ""}. Then stop: do not thrash alternatives or invent work around the block. The operator's answer arrives in this seat as operator mail.`;

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

Tasks are a **pull queue**. The canvas (edges + live state) decides what is available. Do not:

- invent work the board never listed
- claim from targets you are not connected to (ScopeError is correct — fix edges, not the code)
- treat an open queue as stoppage — \`submitted\`/\`working\` means work is in progress`
  : `### Work comes from people

There is no claim queue in this build. Work reaches you from the operator, your region briefing, and mail addressed to your seat. Do not:

- invent work nobody asked for
- act on nodes you are not connected to (ScopeError is correct — fix edges, not the code)
- treat a quiet canvas as stoppage — silence is the canvas at rest`;

/** Completion law: a verified verdict with a queue, honest reporting without. */
const COMPLETION_SECTION = TASKS_ENABLED
  ? `### Completion is earned

You do not **self-declare** completion — you **submit** it. \`completed\` is a verified review verdict: the server rejects the transition unless finish criteria are met and evidence is attached.

- Before \`completed\`: verify every finish criterion (description, git commits${ARTIFACTS_ENABLED ? ", artifacts on the required node" : ""}), then attach \`completionEvidence\` — ${ARTIFACTS_ENABLED ? "artifacts published with task linkage + " : ""}real git SHAs.
- A rejection names the missing pieces (\`InvalidTransition\` with \`missing\` + \`next_step\`) — read it, fix the evidence, retry. Do not mark \`completed\` without evidence.
- If criteria are unreachable, say so with \`junto blocked\` and set the task to \`input-required\`, with what you tried and what you need. Do not mark \`failed\` unless the task is truly dead.
- \`working\` notes are progress telemetry: state what you did at milestones (first commit, tests passing, blocked), not just "working".`
  : `### Report honestly

There is no review verdict to submit in this build. Say what you did, what you verified, and what you could not finish. Do not dress up unfinished work as done; if you cannot finish, say so and stop.`;

/** Peer doctrine — canvas seat, work source, blocking, identity. */
export const PEER_DOCTRINE = `## Peer doctrine

You occupy a **peer seat** on a Junto canvas. The human operator authors the canvas; you pull available work through connected edges, coordinate with peers, and report verified progress through the \`junto\` CLI. Never invent canvas structure or freeform authoring. Completion is not self-declared: closing a task requires inspectable completion evidence and a qualifying peer review verdict (laudo) on your exact commit references.

### Peer loop

1. **onboard** — first. \`junto onboard\` loads your seat, role, region briefing, connected targets and the commands each allows. Nothing else tells you where you are.
${WORK_STEP}
${UPDATE_STEP}
4. **raise your hand when blocked** — if you need human input or approval, \`junto blocked\`${TASKS_ENABLED ? " and set the task to `input-required`" : ""}. Stop inventing work around the block.

${IDLE_LINE}

${WORK_SOURCE_SECTION}

${BLOCKED_SECTION}
${ARTIFACTS_SECTION}

${COMPLETION_SECTION}

### Reach

- **Reach** is edges + ports. You only act on connected nodes. ScopeError means you are not authorized for that target.
- Env like seat hints is **context only**, never authority.`;

// ── Base CLI contract (always available to seats) ─────────────────────────

/** Orientation wording: a task-board world, or seats and their grants. */
const ORIENT_DETAIL = TASKS_ENABLED
  ? "connected targets with what each board is for, who may start tasks there, its Next boards, and the rulings pinned over you"
  : "connected targets with their grants";

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
| orient (always first) | \`junto onboard\` — seat, region briefing, ${ORIENT_DETAIL} |
| live contract / grants | \`junto capabilities\` |
${TASKS_ENABLED ? `| pinned rulings for your regions | \`junto rulings\` — add \`'{"target":"<id>"}'\` for a connected target's stack |
` : ""}| thought bubble | \`junto preamble '{"text":"..."}'\` |
| raise your hand to the operator | \`junto escalate "..."\` - \`junto blocked "..."\` - \`junto feedback "..."\` (see below) |
| end this session | \`junto offboard "<notes>"\` at a stopping point, add \`--continue "<note>"\` mid-work (see Sessions below) |
| schemas / examples | \`junto schema show <command>\` - \`junto examples show <command>\` |
| full documentation | \`junto docs\` - \`junto docs node <kind>\` — the complete doctrine and per-node-kind docs (ports, data models, events) |

### Tool law

For an unfamiliar command, in order: \`examples show <command>\` → \`schema show <command>\` → execute. Prefer copy-paste JSON over inventing flags. For the full picture — doctrine, node kinds, ports, data models, events — pull \`junto docs\`; the CLI is stateful and current, and \`junto onboard\` is the short way in.

Errors are **ground truth** — do not invent around them. Read \`type\` and \`next_step\`:

- \`ScopeError\` — not connected / not authorized for that target; the fix is an edge on the canvas, not a workaround${TASK_ERROR_BULLETS}
- \`InputError\` — payload failed schema decode; \`schema show\` prints the exact shape
- \`RuntimeDown\` / \`Paused\` — Junto is down or the canvas is paused; wait, then re-run \`onboard\`. Do not retry-loop.

Retry law: retry only when the error says \`retryable: true\`, at most twice, then adapt or escalate. Never loop the same failing call.

### Raising your hand

Every seat can signal the operator; no edge is needed. One sentence says what you need; add \`--detail "<markdown>"\` (or \`--detail -\` from stdin) for the why. The operator sees it on your node.

- \`junto escalate "..."\` — you need the operator's attention but can keep working. Use it any time.
- \`junto blocked "..."\` — you cannot continue without the operator. Stop and wait.
- \`junto feedback "..."\` — you are not blocked; the work is ready for the operator to review.

The answer arrives in this seat as operator mail; \`junto signal list\` shows your signals and their answers. When one no longer applies, withdraw it: \`junto signal clear <id>\` (no id clears all yours). Do not use these for progress chatter; \`preamble\` is for that.

### Sessions

\`junto onboard\` lists this seat's past sessions: the latest notes inline, and paths to older notes and transcripts. ${PAST_SESSIONS_FRAMING} To look further back, open a listed path yourself.

\`junto offboard\` ends this session with notes for the next one: what happened, what is relevant, and why it matters. The first line sums the session up; \`@file\` or \`-\` for stdin also work. You choose the stopping point, and the mode:

- At a stopping point: \`junto offboard "<notes>"\`. When you go idle, Junto closes this session and the seat rests. Its next wake starts a fresh session that reads your notes.
- Mid-work: \`junto offboard "<notes>" --continue "<what to pick up next and why>"\`. When you go idle, Junto starts a fresh session right away. It reads your continuation first and carries on.

Offboarding is yours to decide: Junto never measures your context or asks you to. Offboard on your own:

- at a natural stopping point: a task done, a question answered, work handed on;
- before a long context grows stale: many turns in, early detail fading, re-reading what you already knew;
- when switching topics: new work that does not need this session's history starts cleaner fresh.

Use \`--continue\` when the work is unfinished and should go on now: the fresh session starts right away from your note. Use plain offboard when the stretch is done and the seat can rest until mail wakes it. The operator may also ask you to offboard. After offboarding, finish your turn and stop. Running it again before you go idle replaces the notes, and the latest mode wins.

When \`junto onboard\` shows a \`handoff\`, your previous session left it for you: it is the one exception to past sessions being context only. Pick it up unless your current instructions or mail say otherwise.

Never leak board tokens, node refs, or seat ids into public copy.`;

// ── Edge contracts (reference tables per command family) ───────────────────

const TASKS_REFERENCE = `Finish criteria are **hard gates**: \`completed\` is rejected unless evidence is attached (${ARTIFACTS_ENABLED ? "artifacts linked to the task, " : ""}real git SHAs). A rejection names the missing pieces — read it, fix, retry.

### Stage evidence before review

On a configured Command Center, a requires-review task stays \`working\` while you submit real refs: \`junto tasks update '{"target":"<target>","task":"<taskId>","state":"working","completionEvidence":{"artifacts":[],"git":{"commits":["<real-sha>"]}}}'\`. This stages evidence without completing the task. Reviewers receive the exact subject through receipt mail. Use the current epoch and subjectHash; a changed ref or epoch invalidates prior approval. After a qualifying reviewer posts green on that exact subject, complete with the same evidence. A blocking review sends work back with a defect and a new epoch. Requires-review completion is Command Center only.

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

A task that arrives back with an epoch bump was sent back to you: prior claims and check results are stale, so answer the rules again and re-run the checks.`;

const MSG_REFERENCE = `Own inbox: \`junto msg list\` marks listed mail read; \`junto msg react '{"messageId":"<msgId>"}'\` acknowledges without a reply. Mail is never refused and never needs a retry: it is typed into the recipient's input at once, whatever the recipient is doing, and a recipient whose seat is not up gets it when the seat starts. The one wait is the input box: mail is never typed over a message the operator is composing in that seat, into a dialog, or onto a screen Junto cannot read, and goes in once the box is free. Kinds are \`notice\`, \`prompt\`, and \`receipt\`; a typed notice says \`mail from <seat>\`, and adds a pointer to \`junto onboard\` when the recipient has not onboarded yet. Avoid acknowledgement loops.

Seat wait and seat read require a local peer, and are unavailable for Remote seats.`;

const MSG_SEND_REFERENCE =
  "A send answers `delivered` (typed into their input) or `waiting` (their seat is not up yet, or its input box is not free: the operator is composing, or a dialog is up). Inspect delivered, read and reply facts with `junto msg sent`; each is separate evidence.";

const REVIEWS_REFERENCE = `The directed \`verdict.post\` grant lets you review these authors on a configured Command Center. It grants no peer message, prompt, wait or terminal-read permission by itself. Read \`junto msg list\` for review receipt mail, then inspect the cited work. Use the receipt's target board, task id, epoch and subjectHash exactly; \`tasks show\` is available only with a separate task-list grant.

Use \`"kind":"blocking"\` with concrete nonempty findings when changes are needed. A blocking task review records the verdict and sends the task back with a defect and new epoch. Commit review uses \`"subject":{"kind":"commit","sha":"<full-sha>"}\`; it does not move a task. The server stamps your identity, refuses self-review, and rechecks the live reviews edge and exact subject. Stale-subject refusal requires a fresh receipt or authorized task read, never rebinding your old verdict to newer work.`;

const ARTIFACTS_REFERENCE = `Artifacts never block: ship intermediate and final outputs freely — they do not stop other seats.${TASKS_ENABLED ? ` When completing a task with an artifacts requirement, publish first with task linkage, then complete with \`completionEvidence.artifacts: [{"artifactId":"<id>","nodeId":"<target>"}]\`.` : ""}`;

const PAD_REFERENCE =
  "With `pad.patch`, agents may upsert shapes, edges, and pin posts. Agent ink or image upserts are refused. Pin mentions must be inbound actor node ids — @ cannot name an unwired agent. Agents never write the canvas.";

const SHEET_REFERENCE = `Grant is \`sheet.read\` via the edge. A sheet is a small operator-authored grid:
columns, rows, and plain text cells, returned as JSON plus a markdown table.
There is no write port — if a number in it is wrong, say so, do not fix it.`;

const BROWSER_REFERENCE = `\`browser.automate\` is a live edge grant realized by \`junto browser\` from
the managed agent's existing shell. Existing sessions may use it immediately
after an edge appears — re-run \`junto capabilities\` for the current command.`;

/** The reference prose under a family's table, for the ports the group holds. */
const referenceFor = (group: CommandGroup): string => {
  const holds = (port: string): boolean => group.rows.some((row) => row.port === port);
  switch (group.family) {
    case "tasks":
      return holds("tasks.update") ? TASKS_REFERENCE : "";
    case "msg":
      return holds("msg.send") || holds("msg.prompt")
        ? `${MSG_REFERENCE}\n\n${MSG_SEND_REFERENCE}`
        : MSG_REFERENCE;
    case "reviews":
      return REVIEWS_REFERENCE;
    case "artifacts":
      return ARTIFACTS_REFERENCE;
    case "board":
      return COMMAND_FAMILIES.board.note;
    case "pad":
      return PAD_REFERENCE;
    case "sheet":
      return SHEET_REFERENCE;
    case "browser":
      return BROWSER_REFERENCE;
  }
};

const edgeContractSection = (group: CommandGroup): string => {
  const spec = COMMAND_FAMILIES[group.family];
  const first = group.targets[0]?.id ?? "<id>";
  const all = group.targets.map((target) => `\`${target.id}\``).join(", ");
  const heading = `### Edge contract — ${spec.label}${group.targets.length > 1 ? ` (targets: ${all})` : ` (target \`${first}\`)`}`;
  const table = group.rows
    .map((row) => `| ${row.intent} | \`${row.command(first)}\`${row.detail ? ` — ${row.detail}` : ""} |`)
    .join("\n");
  const reference = referenceFor(group);
  return `${heading}

| intent | command |
|---|---|
${table}${reference ? `\n\n${reference}` : ""}`;
};

/** The edge-contract reference sections for a set of connected targets. */
export const buildEdgeContracts = (
  targets: readonly ConnectedTarget[] | undefined,
): readonly string[] => commandGroupsFor(targets).map(edgeContractSection);

/** One family's reference section, whatever ports the targets hold in others. */
export const buildEdgeContract = (
  family: CommandFamily,
  targets: readonly ConnectedTarget[],
): string =>
  commandGroupsFor(targets)
    .filter((group) => group.family === family)
    .map(edgeContractSection)
    .join("\n\n");

export const EDGE_CONTRACTS_INTRO = `### Edge contracts

A seat is only taught the commands its edges authorize. \`junto onboard\` compiles them from the ports the seat holds on each connection and returns them under \`instructions\`; the tables below are the same commands with their reference notes. When edges change mid-session, a compact map-change notice names the added and removed targets; the live command set is always \`junto onboard\` / \`junto capabilities\`.`;

// ── Worked examples ────────────────────────────────────────────────────────

/**
 * Worked examples: rendered from the canonical few-shot payloads
 * (shared/doctrine-few-shots.ts) that also feed the CLI examples catalog, so
 * the doctrine can never teach a JSON shape the catalog does not print.
 */
const fewShotsForTargets = (
  targets: readonly ConnectedTarget[] | undefined,
): readonly DoctrineFewShotPayload[] => {
  const out: DoctrineFewShotPayload[] = [];
  if (TASKS_ENABLED && targets?.some((target) => target.ports?.includes("tasks.claim"))) out.push(FEW_SHOT_CLAIM);
  if (TASKS_ENABLED && targets?.some((target) => target.ports?.includes("tasks.update"))) {
    out.push(FEW_SHOT_PROGRESS, FEW_SHOT_COMPLETE_EVIDENCE);
  }
  // Raising a hand is universal, so every seat gets its worked example.
  out.push(FEW_SHOT_BLOCKED);
  return out;
};

/** Quote an argv word so the rendered line pastes into a shell unchanged. */
const shellArg = (arg: string): string =>
  /^[A-Za-z0-9_./:@=-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

export const buildFewShotsSection = (
  targets: readonly ConnectedTarget[] | undefined,
): string => {
  const lines = ["## Worked examples", ""];
  for (const shot of fewShotsForTargets(targets)) {
    // args are the full argv (["tasks", "claim", "{...}"]); render the whole
    // command so the copy-paste line is complete.
    lines.push(`\`junto ${shot.args.map(shellArg).join(" ")}\``);
    lines.push(`- ${shot.lesson}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n\n$/, "");
};

// ── The body ───────────────────────────────────────────────────────────────

/**
 * The doctrine body for a set of connected targets: the laws, the base CLI
 * contract, the edge contracts those targets permit, and worked examples.
 */
export const buildDoctrineBody = (
  targets: readonly ConnectedTarget[] | undefined,
): string => {
  const contracts = buildEdgeContracts(targets);
  return [
    "# Junto — collaborative work plane",
    "",
    JUNTO_INTRO,
    "",
    PEER_DOCTRINE,
    "",
    SEAT_DOCTRINE,
    "",
    BASE_CONTRACT,
    "",
    ...(contracts.length > 0 ? [EDGE_CONTRACTS_INTRO, ...contracts] : []),
    buildFewShotsSection(targets),
  ].join("\n");
};
