/**
 * Per-session instruction injection for managed terminals (Phase 6 → compiled doctrine).
 *
 * Single source of truth for the doctrine text that used to live in the
 * vellum-plugin global rule. Spawn (Tier A flags) and first typed message
 * (Tier B) both consume this builder.
 *
 * Compiled doctrine model:
 * - Detached terminal (no canvas node) → null → nothing injected, nothing typed.
 * - Canvas seat → base doctrine ALWAYS (Vellum Command intro, seat doctrine,
 *   worker loop, base CLI contract, laws). Isolated seats get no edge contracts.
 * - Edge contracts are COMPILED from the node's edge reality at spawn: each
 *   connected kind adds the exact CLI contract for the ports that kind offers
 *   (task → tasks ops; requests → escalate; artifacts → publish; board → board;
 *   actor/task/requests → msg). The agent is never taught a command its edges
 *   do not authorize.
 * - Rising edges mid-session inject the new slot via mailbox notice + drive
 *   (composeEdgeSlotInjectionText / planEdgeSlotInjections).
 *
 * Never writes ~/.claude, ~/.codex, ~/.grok, ~/.hermes.
 */

import {
  type HarnessId,
  type InjectionTier,
  templateFor,
} from "./managed-terminal-templates";
import { BROWSER_ENABLED } from "./features";
import type { CanvasDoc } from "./canvas";

// ── Seat context (filled at spawn) ─────────────────────────────────────────

export type InjectionConnectedTarget = {
  readonly id: string;
  readonly kind?: string;
  readonly summary?: string;
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
};

// ── Slot kinds ─────────────────────────────────────────────────────────────

/**
 * Kind → prompt slot. Mirrors the physics port table (kinds.ts) so the prompt
 * only teaches what the edge actually grants:
 * - task offers tasks.list/create/claim/update + msg.list/msg.send
 * - requests offers request.escalate + msg.list/msg.send
 * - artifacts offers artifact.publish
 * - board offers board.*
 * - agent offers msg.list/msg.send
 * - page offers browser.automate (feature-gated)
 */
export type EdgeSlotKind =
  | "tasks"
  | "escalate"
  | "msg"
  | "artifacts"
  | "board"
  | "browser";

export const KIND_TO_SLOT: Readonly<Record<string, EdgeSlotKind | undefined>> = {
  task: "tasks",
  tasks: "tasks",
  requests: "escalate",
  request: "escalate",
  artifacts: "artifacts",
  board: "board",
  agent: "msg",
  page: "browser",
};

// ── Intro / seat doctrine (base) ───────────────────────────────────────────

/** What Vellum Command is + canvas awareness — the grounding block. */
export const VELLUM_INTRO = `## Vellum Command

You are running inside **Vellum Command** — a factory floor for coding agents on a shared canvas. The canvas is your world: nodes are work surfaces (tasks, requests, artifacts, boards, other agents), and **edges are your permissions**. Your seat is the node you occupy; everything you may touch is edge-connected to you. All factory operations go through one CLI: \`vellum-command\`.`;

/** Seats — durable per-agent identity on the floor, where grants accrue. */
export const SEAT_DOCTRINE = `## Seats

A **seat** is your identity on the factory floor: the node you occupy, bound to your process. The seat is durable — it persists across sessions and restarts, and it is where grants, memory, and experience accumulate over time.

- **Grants** come from edges: each edge hands you the ports that node offers (a tasks edge grants \`tasks.list\` / \`tasks.claim\` / \`tasks.update\`; a requests edge grants \`request.escalate\`; an artifacts edge grants \`artifact.publish\`). No edge, no grant — \`ScopeError\` is the factory saying so.
- **Identity** is process-bind: the OS proves who you are. You cannot claim another seat, and no env var makes you someone else.
- **Orientation** is one command: \`vellum-command onboard\` returns your seat, role, region briefing, connected targets with grants, and co-members. Re-run it whenever your view may be stale.`;

// ── Worker doctrine (base) ─────────────────────────────────────────────────

/** Worker doctrine — factory seat, pull queue, claim law, blocking, identity. */
export const WORKER_DOCTRINE = `## Worker doctrine

You are a **factory worker** on a Vellum Command canvas seat. The human authors the board; you pull work through connected edges and report state via the \`vellum-command\` CLI. Never invent canvas structure or freeform authoring.

### Worker loop

1. **onboard** — always first, no exceptions: at session start and after every compaction. Read seat, role, region, connected targets, grants.
2. **work** — do the work the factory assigns. If a task is already claimed by your seat, continue it; claim only tasks that are unclaimed. Never invent backlog.
3. **update** — report state honestly: \`working\` while active, then \`completed\` / \`failed\` / \`canceled\` / \`input-required\` as appropriate.
4. **request when blocked** — if you need human input or approval, escalate (when a requests node is connected) or set the task to \`input-required\`. Stop inventing work around the block.

Repeat. When idle with no open claimable tasks, wait — do not invent new tasks.

### Claim-is-factory

Tasks are a **pull queue**. The factory (edges + live state) decides what is available. Do not:

- invent work the board never listed
- claim targets you are not connected to (ScopeError is correct — fix edges, not the code)
- treat an open queue as stoppage — \`submitted\`/\`working\` means the factory is humming

### Requests block

\`input-required\` and open **requests** generate stoppage on the **connected actor seat**. When blocked:

- open a request with a clear brief (via the requests edge contract), or set the task to \`input-required\`
- stop thrashing alternatives
- wait for the human / approval path

### Artifacts never block

Publishing artifacts is non-blocking product delivery. Ship intermediate and final outputs freely; they do not stop other seats.

### Completion is earned

You do not **self-declare** completion — you **submit** it. \`completed\` is a factory verdict: the server rejects the transition unless finish criteria are met and evidence is attached.

- Before \`completed\`: verify every finish criterion (description, artifacts on the required node, git commits), then attach \`completionEvidence\` — artifacts published with task linkage + real git SHAs.
- A rejection names the missing pieces (\`InvalidTransition\` with \`missing\` + \`next_step\`) — read it, fix the evidence, retry. Do not mark \`completed\` without evidence.
- If criteria are unreachable, escalate with what you tried and what you need. Do not mark \`failed\` unless the task is truly dead.
- \`working\` notes are progress telemetry: state what you did at milestones (first commit, tests passing, blocked), not just "working".

### Reach

- **Reach** is edges + ports. You only act on connected nodes. ScopeError means you are not authorized for that target.
- Env like seat/task hints is **context only**, never authority.`;

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

/** Always-present contract: orientation + self-description + laws. */
export const BASE_CONTRACT = `## CLI contract — base

JSON-in/JSON-out — every command takes one JSON argument (inline, \`@file\`, or stdin). Copy-paste the shapes below; do not invent flags.

| intent | command |
|---|---|
| orient (always first) | \`vellum-command onboard\` |
| live contract / grants | \`vellum-command capabilities\` |
| thought bubble | \`vellum-command preamble '{"text":"..."}'\` |
| schemas / examples | \`vellum-command schema show <command>\` - \`vellum-command examples show <command>\` |
| full documentation | \`vellum-command docs\` - \`vellum-command docs node <kind>\` — the complete doctrine and per-node-kind docs (ports, data models, events) |

### Tool law

For an unfamiliar command, in order: \`examples show <command>\` → \`schema show <command>\` → execute. Prefer copy-paste JSON over inventing flags. For the full picture — doctrine, node kinds, ports, data models, events — pull \`vellum-command docs\`; the CLI is stateful and current, the injection is only the pointer.

Errors are **ground truth** — do not invent around them. Read \`type\` and \`next_step\`:

- \`ScopeError\` — not connected / not authorized for that target; the fix is an edge on the canvas, not a workaround
- \`ClaimConflict\` — task already claimed or state race; pick another task or wait for the holder
- \`InvalidTransition\` — illegal state change (e.g. \`completed\` without finish-criteria evidence); the message names the missing pieces
- \`InputError\` — payload failed schema decode; \`schema show\` prints the exact shape
- \`RuntimeDown\` / \`Paused\` — factory unavailable; wait, then re-run \`onboard\`. Do not retry-loop.
- \`Blocked\` — this seat is blocked; stop and wait for the operator (the stop directive names the request)

Retry law: retry only when the error says \`retryable: true\`, at most twice, then adapt or escalate. Never loop the same failing call.

Context ritual: when context is heavy, compact, then re-run \`onboard\` for the live map.

Never leak board tokens, node refs, or seat ids into public copy.`;

// ── Edge contracts (compiled per connected kind) ───────────────────────────

const tasksSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — tasks${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
| list queue | \`vellum-command tasks list '{"target":"${t}"}'\` |
| propose work | \`vellum-command tasks create '{"target":"${t}","brief":"...","metadata":{"title":"...","details":"..."}}'\` |
| claim | \`vellum-command tasks claim '{"target":"${t}","task":"<taskId>"}'\` |
| progress / settle / block task | \`vellum-command tasks update '{"target":"${t}","task":"<taskId>","state":"<state>"}'\` — states: \`working\`, \`completed\`, \`failed\`, \`canceled\`, \`input-required\` |
| task content | \`vellum-command content path|stat|materialize\` (ContentRefs attached to your tasks) |

Batch: \`tasks create/claim/update\` accept a JSON array; add \`--concurrency <n>\`.

Finish criteria are **hard gates**: \`completed\` is rejected unless evidence is attached (artifacts linked to the task, real git SHAs). A rejection names the missing pieces — read it, fix, retry.`;
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
| read / write thread | \`vellum-command msg list '{"target":"${t}"}'\` - \`vellum-command msg send '{"target":"${t}","text":"..."}'\` - \`vellum-command msg read '{"target":"${t}","messageId":"<msgId>"}'\` - \`vellum-command msg reply '{"target":"${t}","text":"...","inReplyTo":"<msgId>"}'\` |
| factory mail | when mail arrives: \`msg list\` then \`msg reply\` (or \`msg read\` if no reply) — this stops repeat nudges |

Batch: \`msg send/read/reply\` accept a JSON array; add \`--concurrency <n>\`.`;
};

const artifactSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — artifacts${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
| ship output | \`vellum-command artifact publish '{"target":"${t}","name":"<name>","parts":[{"kind":"text","text":"..."}],"task":{"target":"<tasksId>","id":"<taskId>"}}'\` |

Artifacts never block: ship intermediate and final outputs freely — they do not stop other seats. When completing a task with an artifacts requirement, publish first with task linkage, then complete with \`completionEvidence.artifacts: [{"artifactId":"<id>","nodeId":"${t}"}]\`.`;
};

const boardSlot = (targets: readonly InjectionConnectedTarget[]): string => {
  const t = targets[0]?.id ?? "<id>";
  const all = targets.map((x) => `\`${x.id}\``).join(", ");
  return `### Edge contract — board${targets.length > 1 ? ` (targets: ${all})` : ` (target \`${t}\`)`}

| intent | command |
|---|---|
| list | \`vellum-command board list '{"target":"${t}"}'\` |
| create topic | \`vellum-command board topic '{"target":"${t}","title":"...","body":"..."}'\` |
| post | \`vellum-command board post '{"target":"${t}","topicId":"<topicId>","text":"..."}'\` |
| mark read | \`vellum-command board read '{"target":"${t}","topicId":"<topicId>"}'\` |

Optional shared context — never a decision inbox. \`read\` is enough to clear attention.`;
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
  artifacts: artifactSlot,
  board: boardSlot,
  browser: () => browserSlot(),
};

/** Group connected targets by their slot kind (physics-mirrored). */
export const targetsBySlot = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): Map<EdgeSlotKind, InjectionConnectedTarget[]> => {
  const out = new Map<EdgeSlotKind, InjectionConnectedTarget[]>();
  for (const t of targets ?? []) {
    const slot = t.kind ? KIND_TO_SLOT[t.kind] : undefined;
    if (slot === undefined) continue;
    if (!BROWSER_ENABLED && slot === "browser") continue;
    const list = out.get(slot);
    if (list) list.push(t);
    else out.set(slot, [t]);
  }
  return out;
};

/** Compile the edge-contract sections for the connected targets. */
export const compileEdgeSlots = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): readonly string[] => {
  const grouped = targetsBySlot(targets);
  return [...grouped.entries()].map(([slot, list]) =>
    EDGE_SLOT_BUILDERS[slot](list),
  );
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
// instructions (like the claim packet), never a second version of the prompt.

/**
 * Compact orient notice: tells an unproven seat to run onboard. Delivered by
 * the supervisor at most once per generation —
 * never the full doctrine (the agent already received it at spawn).
 */
export const buildOrientNotice = (seatRef?: string): string =>
  [
    "Your seat's factory CLI: `vellum-command onboard`.",
    seatRef ? `Seat: \`${seatRef}\`.` : "",
    "Run it before anything else — it returns your seat, region, connected targets with grants.",
    "If the CLI is unavailable in your shell, tell the operator.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");

// ── Builders ───────────────────────────────────────────────────────────────

/**
 * Full injection body, or `null` for detached terminals.
 * Canvas seats always receive the base doctrine; edge contracts are compiled
 * from the connected targets at spawn.
 */
export const EDGE_CONTRACTS_INTRO = `### Edge contracts

The contracts below are **compiled from the edges connected at spawn** — you are only taught the commands your seat is authorized to run. When a new edge appears mid-session, its contract is injected as it connects; re-run \`vellum-command capabilities\` for the live grant list at any time.`;

export const buildInjectionText = (ctx: InjectionContext): string | null => {
  if (!ctx.seatBound) return null;
  const slots = ctx.connected ? compileEdgeSlots(ctx.connectedTargets) : [];
  return [
    "# Vellum Command — factory work plane",
    "",
    VELLUM_INTRO,
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
    "",
    buildSeatContextSection(ctx),
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
 * contract changes are announced (new contracts inline, removals as a
 * re-orient hint), never a full doctrine re-injection.
 */
export const composeEdgeMapChangeNotice = (change: EdgeMapChange): string => {
  const lines: string[] = ["[factory - map] your edge contracts changed."];
  if (change.added.length > 0) {
    lines.push("Added:");
    for (const t of change.added) {
      lines.push(`- \`${t.id}\`${t.kind ? ` (${t.kind})` : ""}`);
      const slot = t.kind ? KIND_TO_SLOT[t.kind] : undefined;
      if (slot !== undefined && (BROWSER_ENABLED || slot !== "browser")) {
        lines.push("", EDGE_SLOT_BUILDERS[slot]([t]));
      }
    }
  }
  if (change.removed.length > 0) {
    lines.push(
      `Removed: ${change.removed.map((t) => `\`${t.id}\``).join(", ")} — re-run \`vellum-command onboard\` for the current map.`,
    );
  }
  if (change.added.length === 0 && change.removed.length === 0) {
    return "[factory - map] edge map unchanged — re-run `vellum-command onboard` for the current map.";
  }
  lines.push("", "Re-run `vellum-command capabilities` for the live grant list.");
  return lines.join("\n");
};

/**
 * Edge-map diff for actor seats: added AND removed slot-bearing neighbors.
 * Pure — no I/O. Callers skip when `previous` is missing (open / first paint).
 */
export const planEdgeMapChanges = (
  previous: CanvasDoc,
  next: CanvasDoc,
): ReadonlyArray<EdgeMapChange> => {
  const adjacency = (doc: CanvasDoc): Map<string, InjectionConnectedTarget[]> => {
    const out = new Map<string, InjectionConnectedTarget[]>();
    for (const edge of doc.edges) {
      for (const [a, b] of [
        [edge.fromNode, edge.toNode],
        [edge.toNode, edge.fromNode],
      ] as const) {
        const node = doc.nodes.find((n) => n.id === b);
        if (!node) continue;
        const kind = node.ether?.entity?.kind;
        if (kind === undefined || KIND_TO_SLOT[kind] === undefined) continue;
        const list = out.get(a);
        const target: InjectionConnectedTarget = { id: b, ...(kind !== undefined ? { kind } : {}) };
        if (list) list.push(target);
        else out.set(a, [target]);
      }
    }
    return out;
  };

  const before = adjacency(previous);
  const after = adjacency(next);
  const isSeat = (doc: CanvasDoc, id: string): boolean =>
    doc.nodes.find((n) => n.id === id)?.ether?.entity?.kind === "agent";
  const key = (t: InjectionConnectedTarget): string => `${t.kind ?? ""}:${t.id}`;
  const changes: EdgeMapChange[] = [];
  for (const seatId of new Set([...before.keys(), ...after.keys()])) {
    if (!isSeat(next, seatId) && !isSeat(previous, seatId)) continue;
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
 * Marker line first, then a blank line, then the text. The marker is always
 * on its own line at position 0.
 */
export const appendBootstrapMarker = (
  text: string,
  bindingId: string,
): string => [buildBootstrapMarker(bindingId), "", text].join("\n");


