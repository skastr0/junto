/**
 * Per-session instruction injection for managed terminals (Phase 6).
 *
 * Single source of truth for the doctrine text that used to live in the
 * vellum-plugin global rule. Spawn (Tier A flags) and first typed message
 * (Tier B) both consume this builder.
 *
 * Unconnected agent → null body → nothing injected, nothing typed.
 * Never writes ~/.claude, ~/.codex, ~/.grok, ~/.hermes.
 */

import {
  type HarnessId,
  type InjectionTier,
  templateFor,
} from "./managed-terminal-templates";

// ── Seat context (filled at spawn) ─────────────────────────────────────────

export type InjectionConnectedTarget = {
  readonly id: string;
  readonly kind?: string;
  readonly summary?: string;
};

/**
 * Context slots for the injection payload.
 * `connected` is the hard gate: false → no injection of any kind.
 */
export type InjectionContext = {
  /** False for unconnected / standalone agents (loop step 2). */
  readonly connected: boolean;
  /** Canvas seat / node ref (context only — identity is process-bind). */
  readonly seatRef?: string;
  /** Edge-connected work surfaces the seat may act on. */
  readonly connectedTargets?: readonly InjectionConnectedTarget[];
};

// ── Doctrine body (static) ─────────────────────────────────────────────────

/** Worker doctrine — factory seat, pull queue, claim law, blocking, identity. */
export const WORKER_DOCTRINE = `## Worker doctrine

You are a **factory worker** on a Vellum canvas seat. The human authors the board; you pull work through connected edges and report state via the station CLI. Never invent canvas structure or freeform authoring.

### Worker loop

1. **onboard** — at session start and after compaction. Read seat, role, connected targets, grants.
2. **list / claim tasks** — work only what the factory assigns; do not invent backlog.
3. **work** — implement the claimed task.
4. **update** — mark \`working\` while active, then \`completed\` / \`failed\` / \`canceled\` as appropriate.
5. **request when blocked** — if you need human input or approval, open a request (or set the task to \`input-required\`). Stop inventing work around the block.

Repeat. When idle with no open claimable tasks, wait — do not invent new tasks.

### Claim-is-factory

Tasks are a **pull queue**. The factory (edges + live state) decides what is available. Do not:

- invent work the board never listed
- claim targets you are not connected to (ScopeError is correct — fix edges, not the code)
- treat an open queue as stoppage — \`submitted\`/\`working\` means the factory is humming

### Requests block

\`input-required\` and open **requests** generate stoppage on the **connected actor seat**. When blocked:

- open a request with a clear brief, or set the task to \`input-required\`
- stop thrashing alternatives
- wait for the human / approval path

\`auth-required\` is also attention-grade stoppage.

### Artifacts never block

Publishing artifacts is non-blocking product delivery. Ship intermediate and final outputs freely; they do not stop other seats.

### Identity and reach

- **Identity** is process-bind (your process tree under Vellum), not env vars you invent.
- **Reach** is edges + ports. You only act on connected nodes. ScopeError means you are not authorized for that target.
- Env like seat/task hints is **context only**, never authority.`;

/**
 * CLI contract — station binary, op table, errors as ground truth.
 * Tool surface is the station CLI (not MCP, not the pruned global plugin).
 */
export const CLI_CONTRACT = `## CLI contract

Call **\`vellum onboard\`** at session start and after every compaction (or when tool/CLI results say the map changed).

| intent | command |
|---|---|
| orient | \`vellum onboard\` |
| live contract | \`vellum capabilities\` |
| list queue | \`vellum tasks list --target <id>\` |
| claim | \`vellum tasks claim --target <id> --task <id>\` |
| progress / settle / block task | \`vellum tasks update --target <id> --task <id> --state <state>\` |
| read / write thread | \`vellum msg list\` · \`vellum msg send\` |
| escalate to human | \`vellum request create\` · \`vellum escalate\` |
| ship output | \`vellum artifact publish\` |
| list granted pages | \`vellum browser pages --json\` |
| open a granted page | \`vellum browser open <vellum-ref> --json\` |
| navigate / inspect / capture | \`vellum browser goto\` · \`vellum browser eval\` · \`vellum browser shot\` |
| schemas / examples | \`vellum schema\` · \`vellum examples\` |

\`browser.automate\` is a live edge grant realized by \`vellum browser\` from
the managed agent's existing shell. Existing sessions may use it immediately
after an edge appears — re-run \`vellum capabilities\` for the current command.

JSON-in/JSON-out. Errors are **ground truth** — do not invent around them:

- \`ScopeError\` — not connected / not authorized for that target
- \`ClaimConflict\` — task already claimed or state race
- \`RuntimeDown\` — work socket/token unavailable (is Vellum running?)
- \`Blocked\` — this seat is blocked; stop and wait

Never leak board tokens, node refs, or seat ids into public copy.`;

// ── Builders ───────────────────────────────────────────────────────────────

const formatConnectedTargets = (
  targets: readonly InjectionConnectedTarget[] | undefined,
): string => {
  if (!targets || targets.length === 0) {
    return "(none listed at spawn — call `vellum onboard` for the live map)";
  }
  return targets
    .map((t) => {
      const kind = t.kind?.trim() ? ` · ${t.kind.trim()}` : "";
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
      : "(unknown at spawn — call `vellum onboard`)";
  return `## Seat context

- **Seat ref:** \`${seat}\` (context only; identity is process-bind)
- **Connected targets (at spawn):**
${formatConnectedTargets(ctx.connectedTargets)}

Re-run \`vellum onboard\` for the live map after compaction or edge changes.`;
};

/**
 * Full injection body, or `null` when the seat is unconnected.
 * Unconnected agents get silence — no doctrine, no first typed message.
 */
export const buildInjectionText = (ctx: InjectionContext): string | null => {
  if (!ctx.connected) return null;
  return [
    "# Vellum — factory work plane",
    "",
    "You are running as a **managed factory worker** inside Vellum. Use the station CLI (`vellum`) for all work-plane ops.",
    "",
    WORKER_DOCTRINE,
    "",
    CLI_CONTRACT,
    "",
    buildSeatContextSection(ctx),
  ].join("\n");
};

// ── Plan (tier + body for spawn / drive) ───────────────────────────────────

export type ManagedInjectionPlan = {
  /** False when unconnected — nothing to inject or type. */
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
 * Unconnected → inject: false, no body.
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
