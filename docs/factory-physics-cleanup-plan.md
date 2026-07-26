# Physics alignment — cleanup plan of record

Scope: `/Users/developer/Projects/vellum`, TypeScript/Electron, read-only scan.
Mandate: **one actor — the native terminal**; sum types instead of if-else soups;
unmistakable ACTOR / SINK / SCHEDULER / GEOGRAPHY.

Every claim below cites a file:line I opened. Three citations from the eight
upstream scans did not reproduce and are corrected in place (§0.3). One scan
finding is rejected as an overreach (§0.2). Two conflicts between this mandate
and the current plan-of-record are escalated, not designed away (§0.1).

---

## 0 · Before the plan: what does not survive contact

### 0.1 Two hard escalations — the operator must answer before commit C8 lands

**E1 — the collapse makes the browser plane unreachable.**
`src/main/vellum/browser/edge-grant.ts:505-509` refuses browser authority to
every terminal principal, verbatim: *"native terminal processes cannot wield
browser authority — use a live agent or herdr process"*. `processKeyOf` at
`edge-grant.ts:174-182` throws for a terminal principal, and the process-map
subscriber at `edge-grant.ts:217` skips terminals. Meanwhile the *document*
side already admits terminals — `browser/authz.ts:71` returns
`roleOf(spec) === "actor"`, and `terminal` has `role: "actor"` at
`physics/kinds.ts:39`. So the two halves of the browser plane already
disagree, and once `agent` and `herdr` are gone there is **no principal kind
left that can hold a browser grant**. Browser automation is not a rename
casualty; it needs the seat-keyed decision made deliberately: does a
process-bound terminal seat wield `browser.automate`, yes or no? Do not infer
it from the collapse.

**E2 — Tier-3 route tokens have no legal kind after the collapse.**
`work/live-seat.ts:27-31` and `:76-82` reject `kind === "terminal"` for
route-token mint ("route-token seats cannot be kind terminal (process-bind
only)"), and `work/route-tokens.ts:141-148` accepts all three kinds at the
store layer. Route tokens exist for *callers with no local process-bind*
(`route-tokens.ts:130-138`) — i.e. remote harnesses. After the collapse the
only kind is `terminal`, so either mint accepts terminal-with-`bindingId` or
Tier 3 dies and remote-station work-control dies with it.

### 0.2 One rejected scan finding

The `scheduler-surfaces` scan classifies `entity.kind = "watcher"` /
`"timer"` at `Canvas.tsx:572,584` and `node-factories.ts:321,342` as
**duality** (severity: high) and recommends removing scheduler kinds from
`entity.kind`. That is backwards. The doctrine is explicit at
`docs/architecture-factory-physics.md:71` — *"Roles are derived from kind —
never authorial"* — and `physics/kinds.ts:45-46` derives
`watcher|timer → role: "scheduler"` correctly. Authoring `entity.kind` is the
*supported* mechanism; the forbidden thing is authoring `ether.role`
(`architecture-factory-physics.md:81`). **Reclassified: already-correct.**
Only the UI dispatch at `InspectorFields.tsx:543-544` and
`TextNode.tsx:496-497` is a genuine kind-branch.

### 0.3 Corrected citations (upstream scans had these wrong)

| scan claim | actual |
|---|---|
| `InspectorFields.tsx:104` work-plane section | `:545` — `kind === "task" \|\| kind === "requests" \|\| kind === "artifacts"` |
| `edge-mutations.ts:5` default criteria | `:115` — `if (kind === "task" \|\| kind === "requests") return { mode: "tasks" }` |
| `factory-tick.ts:39` isTaskSink | `:24` — `const isTaskSink = (node) => node.ether?.entity?.kind === "task"` |
| `control.ts:614` msg store dispatch | `:616` — `kind === "task"` ternary |

Also: `shared/message-delivery.ts:138` reproduces, but as a **negated**
chain — `if (kind !== "agent" && kind !== "herdr" && kind !== "terminal") continue`.
Any cement regex must match the negated form too.

### 0.4 Doc conflict this plan resolves by naming, not by silence

`docs/managed-terminal-plan.md:34` (settled rulings, authored 2026-07-26)
reads: *"Actor = command template. Terminal = geography. … A raw terminal is
not an actor."* Under that framing the actor kind is `agent` and `terminal`
is furniture. Under **this** mandate the naming inverts: the actor kind *is*
`terminal`, and only an **unbound** terminal is geography. Both sentences
describe the same physics with opposite labels. The plan below adopts the
mandate's labels and rewrites that ruling row (commit C9); it does not
reinterpret the plan-of-record silently.

---

## 1 · TARGET TYPE MODEL

### 1.1 The four words become the closed role set

`src/shared/physics/schema.ts:22-29` today:

```ts
export const FactoryRole = Schema.Literal(
  "actor", "sink", "scheduler", "region", "furniture",
);
```

becomes

```ts
export const FactoryRole = Schema.Literal(
  "actor", "sink", "scheduler", "geography",
);
```

`region` and `furniture` fold into `geography`. This is **behavior-preserving
at the capability layer**, and that is grounded, not assumed: in
`physics/laws.ts:53-58` both `ActorRegion` and `ActorFurniture` are produced,
and in `laws.ts:66-77` both map to `GrantLaw.None()`. Identical law, so one
`ActorGeography` pair replaces both. Likewise `phase-membership.ts:25-33`
returns `false` for both. The renderer already agrees — `Canvas.tsx:737-742`
maps `region` and `furniture` to the single palette group `"Geography"`.

The Region-vs-Furniture *structural* distinction (group membership, pulse
briefing container) survives — it lives on the resolved tag, below, not on
the role name.

### 1.2 The kind registry: one actor kind

`physics/schema.ts:63-73` today lists nine well-known kinds including `agent`
and `herdr`. It becomes seven:

```ts
export const WellKnownKind = Schema.Literal(
  "terminal",                              // the one actor
  "task", "requests", "artifacts", "page", // sinks
  "watcher", "timer",                      // schedulers
);
```

`physics/kinds.ts:37-47` `KindSpecs` loses the `agent` row (`:38`) and the
`herdr` row (`:40`), and `terminal` (`:39`) takes the actor's port offers:

```ts
export const KindSpecs = {
  terminal:  { kind: "terminal",  role: "actor",     offers: msgOffers },
  task:      { kind: "task",      role: "sink",      offers: taskOffers },
  requests:  { kind: "requests",  role: "sink",      offers: requestsOffers },
  artifacts: { kind: "artifacts", role: "sink",      offers: artifactsOffers },
  page:      { kind: "page",      role: "sink",      offers: pageOffers },
  watcher:   { kind: "watcher",   role: "scheduler", offers: emptyOffers },
  timer:     { kind: "timer",     role: "scheduler", offers: emptyOffers },
} as const satisfies Record<WellKnownKind, KindSpec>;
```

**Ports belong to the ROLE, not to the kind — operator ruling 2026-07-26.**
For **sinks**, `offers` is legitimately kind-specific: a task takes task ops,
a page takes `browser.automate`, artifacts take publish. That is what a sink
*is* — the thing ops are invoked on. For an **actor**, `offers` is the actor's
inbox, and it is role-determined: one actor role, one inbox. `terminal:
emptyOffers` (`kinds.ts:39`) is therefore not a "narrower kind" — it is a
**wrong declaration**, and it is exactly why factory mail had to detour
through `agent` (`kinds.ts:38`). Nothing inherits, nothing widens: the actor
inbox gets declared where it always belonged. Do not describe this as a
capability change; it is a mis-declaration being corrected.

`page` **is a sink** — settled, not a question. Browser pages are *data*:
they live in the runtime and actors interact with them, so they receive ops
(`browser.automate`, `kinds.ts:41`), which is the sink definition
(`architecture-factory-physics.md:76`). Geography holds no capability and
receives nothing. Any earlier text (including this plan's own mandate sketch)
that filed browser pages under geography was wrong.

### 1.3 Role resolution happens in exactly one place, and it is a sum type

`physics/kinds.ts:58-73` `ResolvedSpec` is already a `Data.TaggedEnum`, and
`resolveSpec` at `:86-103` is already the single derivation from canvas node
shape. The change is to make the **tags be the operator's four words**, so
that "branch on role" and "branch on the tag" are the same act:

```ts
/** The only thing product code is allowed to branch on. */
export type ResolvedSpec = Data.TaggedEnum<{
  /** Occupies a seat; wields outbound edges under process-bind. */
  Actor: {
    readonly role: "actor";
    readonly kind: "terminal";        // literal — there is no other actor kind
    readonly offers: HashSet.HashSet<Port>;
  };
  /** Receives ops; target of inbound capability. */
  Sink: {
    readonly role: "sink";
    readonly kind: SinkKind;          // "task" | "requests" | "artifacts" | "page"
    readonly offers: HashSet.HashSet<Port>;
  };
  /** Fires work; holds no user-facing seat. */
  Scheduler: {
    readonly role: "scheduler";
    readonly kind: SchedulerKind;     // "watcher" | "timer"
    readonly offers: HashSet.HashSet<Port>;   // always empty
  };
  /** Placement and context, not a participant. No seat, no wield. */
  Geography: {
    readonly role: "geography";
    readonly kind: string | undefined;
    readonly isRegion: boolean;       // group + ether.region — pulse container
    readonly offers: HashSet.HashSet<Port>;   // always empty
  };
}>;
```

`SinkKind` and `SchedulerKind` are derived from `KindSpecs`, not hand-listed,
so a new sink cannot be added without a role assignment (the
`satisfies Record<WellKnownKind, KindSpec>` guard at `kinds.ts:47` already
forces this).

`roleOf` (`kinds.ts:105-112`) stays as the projection, and the four
`Match.tagsExhaustive` arms are named `Actor | Sink | Scheduler | Geography`.

### 1.4 The actor: the terminal IS the node

`src/shared/actor-surface.ts` today defines a **three-tag union** — a
literal encoding of the duality:

```ts
// actor-surface.ts:50-53
export type ActorDeliverySurface =
  | ManagedAgentSurface   // :18-27  kind agent, requires terminal.bindingId + terminal.harness
  | RawTerminalSurface    // :29-35  kind terminal, requires bindingId
  | LegacyHerdrSurface;   // :38-43  kind herdr
```

The whole file collapses to one struct — **no union, because there is one
actor**:

```ts
// src/shared/actor-seat.ts   (replaces actor-surface.ts)

/**
 * The seat. `bindingId` is the terminal's own identity — a ULID minted by the
 * node factory (node-factories.ts:271) and keyed per PTY session + epoch by
 * term/local-host.ts. A node either has a seat (it is the ACTOR) or it does
 * not (it is GEOGRAPHY). There is no third state and no repair path.
 */
export type ActorSeat = {
  readonly nodeId: string;
  readonly bindingId: string;
  readonly hostId: string;
  /** Template property. A harness is what the seat runs, never a second kind. */
  readonly harness?: HarnessId;
  /** Process-bind / corpus join label, `<host>:<harness|profile>`. */
  readonly seatKey: string;
  readonly launch: EtherTerminalLaunch | undefined;
};

/** The one decode. `undefined` ⇔ this node is geography. */
export const seatOf = (node: CanvasNode): ActorSeat | undefined => …
```

`deliveryTargetFromSurface` (`actor-surface.ts:149-163`) and
`SurfaceDeliveryTarget` (`:145-147`) both disappear: with one seat the
delivery target *is* `seat.bindingId`.

### 1.5 The principal: one struct, no optional-field OR

`src/main/vellum/process-identity.ts:19-32` today:

```ts
export type ProcessPrincipalKind = "agent" | "herdr" | "terminal";
export interface ProcessPrincipal {
  readonly kind: ProcessPrincipalKind;
  readonly agentKey?: string;   // :24  when kind is agent
  readonly paneId?: string;     // :26  when kind is herdr
  readonly bindingId?: string;  // :28  when kind is terminal
  readonly canvasName?: string;
  readonly nodeId?: string;
}
```

Three optional fields whose legality is enforced by three runtime branches at
`:118-123`. It becomes:

```ts
export interface ProcessPrincipal {
  readonly bindingId: string;   // required — the seat
  readonly canvasName: string;  // required
  readonly nodeId: string;      // required
  readonly seatKey?: string;    // display / corpus join only, never identity
}
```

`ProcessPrincipalKind` is deleted. `bind()` at `process-identity.ts:116-144`
loses its three-branch validation (`:118`, `:119`, `:120-123`) — the type
already says what the runtime was checking. `unbindAgentKey` (`:152-158`) and
`unbindHerdrPane` (`:160-166`) delete; `unbindTerminalBinding` (`:168-174`)
is the only one left and is renamed `unbindSeat`.

### 1.6 Sinks and schedulers, at role level

`work/authz.ts:122-128` `OPS_BY_KIND` mixes actors and sinks in one table.
It splits so the actor row cannot exist:

```ts
/** Ops a SINK receives, closed over SinkKind. */
const OPS_BY_SINK: Readonly<Record<SinkKind, ReadonlyArray<WorkOpName>>> = {
  task:      ["tasks.list", "tasks.claim", "tasks.update", "msg.list", "msg.send"],
  requests:  ["request.create", "request.escalate", "msg.list", "msg.send"],
  artifacts: ["artifact.publish"],
  page:      [],
};
/** Ops an ACTOR receives (its own inbox). One actor, so one list. */
const ACTOR_INBOX_OPS: ReadonlyArray<WorkOpName> = ["msg.list", "msg.send"];
```

`opsForKind` (`authz.ts:130-133`) becomes `opsForSpec(spec: ResolvedSpec)`
with a four-arm exhaustive match. `Record<SinkKind, …>` means adding a sink
is a type error here, replacing the "10-15 files / 12-20 edits" coupling the
sink scan measured.

`work.ts` `requireKind(node, [...])` at `:201`, `:233`, `:268`, `:304`,
`:378`, `:396`, `:412`, `:461`, `:503` becomes `requireSink(node, "task")`
(closed `SinkKind` argument) and `requireActor(node)`. The actor/sink
conflation at `work.ts:396` — `requireKind(node, ["agent", "herdr"])` —
becomes `requireActor(node)`.

Scheduler: `ipc.ts:292` and `kernel/cycle.ts:48,345` type the pulse as
`kind: "watcher" | "timer" | "manual"`, mixing two node kinds with one
delivery mode. `manual` is only ever produced by `kernel/service.ts:582`
(hardcoded) and only ever read at `cycle.ts:410`. It splits:

```ts
export type PulseSource =
  | { readonly _tag: "scheduler"; readonly kind: SchedulerKind; readonly nodeId: string }
  | { readonly _tag: "operator";  readonly regionId: string };   // was "manual"
```

### 1.7 What becomes unrepresentable

| today | after |
|---|---|
| `entity.kind === "agent"` — 32 src files (§3 C8) | **type error**: `"agent"` is not in `WellKnownKind` |
| an actor that is not a terminal | `ResolvedSpec.Actor.kind` is the literal `"terminal"` |
| a "half" actor — agent with no `bindingId` | `ActorSeat.bindingId` is required; no seat ⇒ `Geography` |
| the sanitizer that deletes such nodes (`canvas.ts:546-580`) | **file-level deletion**; a bindless terminal resolves to `Geography` and is left alone in the document |
| "demote" / "half-agent" (`canvas.ts:543`, `:568`) | the words have no referent left |
| `managedAgent` vs `rawTerminal` (`actor-surface.ts:19,30`) | one `ActorSeat`; harness is a field |
| a principal with `agentKey` but no `bindingId` | `bindingId` required, `agentKey` gone |
| an OR-chain meaning "is this an actor" (`edge-revocation.ts:140`) | `Match.tagsExhaustive` on 4 tags; a missing arm is a compile error |
| `OPS_BY_KIND` with an `agent` row (`work/authz.ts:124`) | `Record<SinkKind, …>` — actors are not sinks |
| a new sink kind added without a role | already caught by `kinds.ts:47`; now also by `Record<SinkKind, …>` |

The deletion of `sanitizeActorSurfacePorts` is the point of the whole
exercise: that function exists **only** because kind `agent` required kind
`terminal`'s fields. Remove the cross-kind requirement and the runtime
validator, its invented vocabulary, and its node-deleting behavior all
evaporate. Illegal-state-unrepresentable, not illegal-state-repaired.

### 1.8 The pattern to copy — cite these, not the soup

- `physics/phase-membership.ts:25-33` `roleMayBeBlocked` — exhaustive
  `Match` over `FactoryRole`, adding a role is a compile error.
- `physics/phase-membership.ts:43-44` `seatMayBeBlocked` — kind → spec →
  role → law, no per-kind list.
- `physics/kinds.ts:105-112` `roleOf` — `Match.tagsExhaustive`.
- `physics/kinds.ts:37-47` `KindSpecs` — `satisfies Record<WellKnownKind, …>`.
- `physics/laws.ts:66-77` `grantLawBetween` — exhaustive over role pairs.
- `browser/authz.ts:65-72` `isBrowserCallerNode` — `roleOf(spec) === "actor"`,
  the only capability-path call site that already asks the role.
- `renderer/components/Canvas.tsx:731-746` `PALETTE_GROUP_BY_ROLE` —
  `Record<FactoryRoleName, PaletteGroup>` keyed by role, with the comment
  *"Never a hand-maintained per-entry group list."*
- `shared/attention.ts:65-83` and `shared/digest.ts:297-316` — exhaustive
  per-sink handling; the template for the sink match.
- `physics/index.ts:52-56` exports `kindsWithRole` — the registry projection
  the cement test asserts against.

---

## 2 · WHAT IS DELETED vs HIDDEN

Guiding rule: ACP and herdr are **hidden product surfaces** today
(`shared/legacy-surfaces.ts:9,15` — `ACP_CHAT_SURFACE_HIDDEN = true`,
`HERDR_SURFACE_HIDDEN = true`). Hidden-but-compiled is not a stable resting
place: `main/vellum/ipc.ts:332` still registers the chat IPC channels and
`ipc.ts:178` still registers herdr's, so both are callable from a renderer
context regardless of the UI gate. Either they are product or they are gone.

### 2.1 DELETE — ACP / hermes-chat (commit C6)

Whole files, no replacement:

- `src/main/vellum/chat/acp-client.ts` — ACP spawn + session management
- `src/main/vellum/chat/spawn.ts` — ACP child process config
- `src/main/vellum/chat/service.ts` — `ChatService`
- `src/main/vellum/chat/ipc.ts` — `registerChatIpc` (channels `chatOpen`,
  `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`)
- `src/renderer/components/chat/` — whole directory (`ChatSurface.tsx`,
  `ChatView.tsx`, transcript/composer siblings)
- `src/renderer/lib/chat-state.ts` — ACP session state machine
- `src/renderer/components/AgentChatToolbarActions.tsx`

Partial edits:

- `src/main/vellum/ipc.ts:332` — drop the `registerChatIpc` call
- `src/shared/ipc.ts` — drop `ChatOpenResult` / `ChatTurnResult` / `ChatItem`
  and the five chat channel names
- `src/main/vellum/chat/node-delete.ts` — the delete-lease that awaits
  `chatClose` before confirming an agent-node delete. Delete the lease; node
  deletion no longer waits on a chat session that cannot exist. **Verify
  first** that terminal deletion never routed through it.
- `src/main/vellum/kernel/cycle.ts:131-140` — the three `@deprecated`
  ACP hooks (`isLive`, `openChat`, `sendPrompt`) kept "so old test stubs
  typecheck". Delete with the stubs.
- `src/shared/legacy-surfaces.ts` — drop `ACP_CHAT_SURFACE_HIDDEN`
- Renderer gate sites that read it: `TextNode.tsx:426`,
  `RtsControls.tsx:423`

### 2.2 DELETE — herdr (commit C7, operator-gated)

`docs/managed-terminal-plan.md:43` rules *"Herdr: hands-off legacy toggle.
Learn from, never fork/vendor."* A toggle is not a code path. Deleting the
node kind does **not** violate that ruling — it removes Vellum's herdr
*actor* surface while leaving the herdr project untouched.

- `src/main/vellum/herdr/` — 17 files (`plane.ts` ~1000 lines,
  `service.ts`, `service-map.ts` ~600 lines, `mirrors.ts`, `mirror.ts`,
  `mirror-transport.ts`, `observe-pool.ts`, `route.ts`, `parse.ts`,
  `ndjson.ts`, `stream.ts`, `stage-image.ts`, `hosts.ts`,
  `event-normalize.ts`, `ipc.ts`, `transport.ts`, `shutdown.ts`)
- `src/main/vellum/term/herdr-bridge/` — whole directory
- `src/renderer/components/herdr/` — `HerdrCard.tsx`, `HerdrWizard.tsx`,
  `HerdrTerminalModal.tsx`, `HerdrToast.tsx`, `HerdrToolbarActions.tsx`,
  `OpenHerdrMark.tsx`
- `src/renderer/lib/herdr-state.ts`, `src/renderer/lib/herdr-actions.ts`
- `src/shared/herdr.ts`
- `src/main/vellum/ipc.ts:178` — drop `registerHerdrIpc`
- `src/shared/canvas.ts:421-422` — drop the `ether.herdr` schema key
- `src/shared/legacy-surfaces.ts` — drop `HERDR_SURFACE_HIDDEN`

Kept: the two `ssh-architecture.test.ts` renderer allowlist entries for
`src/main/vellum/herdr/transport.ts` and `plane.ts` are removed with the
files.

**Gate**: `docs/herdr-qa-checklist.md` exists, and herdr panes that already
render are live (`HERDR_SURFACE_HIDDEN` gates *creation*, not rendering). I
cannot verify from source whether any operator canvas holds a live pane.
Operator answer required before C7.

### 2.3 DELETE — the contradiction machinery (commit C8)

- `src/shared/canvas.ts:539-580` — `sanitizeActorSurfacePorts` entire
  function plus its call site in `sanitizeWorkStores`
- `src/shared/actor-surface.ts` — whole file, replaced by `actor-seat.ts`
- `src/main/vellum/work/live-seat.ts:24-54` — `toProcessPrincipal`'s
  three-branch body
- `src/main/vellum/work/caller-resolve.ts:30-66` — `matchesPrincipal`'s
  three-branch body
- `src/main/vellum/browser/edge-grant.ts:174-182` — `processKeyOf` (keys on
  `bindingId`, or the function goes away with E1's answer)
- `src/main/vellum/browser/authz.ts:27` — `BrowserCallerKind`
- `src/main/vellum/process-identity.ts:19` — `ProcessPrincipalKind`;
  `:152-166` — `unbindAgentKey` + `unbindHerdrPane`
- `src/renderer/lib/node-factories.ts:157-175` — `makeAgentNode`
  (`@deprecated Bare agents are illegal`)

### 2.4 RENAME, not delete — "managed" vocabulary

Seven files carry `managed` in their name and 8 files reference the
`managedAgent` tag (22 occurrences). The word is not wrong in the *product*
sense ("managed terminal" is the operator-facing name at
`Canvas.tsx:772`), but it is wrong as a **type discriminant** — it names one
of two actor kinds that will no longer both exist. Type-level renames
(commit C8):

- `actor-surface.ts:18` `ManagedAgentSurface` → deleted (§1.4)
- `actor-surface.ts:61-78` `ManagedAgentNode` / `isManagedAgentNode` →
  `seatOf(node) !== undefined`
- `node-factories.ts:64` `makeManagedAgentNode` → `makeActorNode`
  (one caller: `terminal/HarnessPicker.tsx:156`)
- `node-factories.ts:256` `makeTerminalNode` → merges into `makeActorNode`
  with `harness` optional (one caller: `terminal/TerminalWizard.tsx:80`)
- `term/ensure-managed-seat.ts` → `term/ensure-seat.ts`
- `term/drive/managed-terminal-drive.ts` → `term/drive/seat-drive.ts`

File-name-only, no type impact — **leave alone**:
`shared/managed-terminal-injection.ts`, `shared/managed-terminal-launch.ts`,
`shared/managed-terminal-templates.ts`, `term/managed-pulse-bridge.ts`,
`term/managed-spawn-plan.ts`. These describe the *transport* (a Vellum-owned
PTY running a harness), which is exactly what "managed terminal" means in
the product. Renaming them is churn.

### 2.5 STAYS compiled and gated — nothing

There is no third bucket. Every file above is either deleted or renamed. The
`legacy-surfaces.ts` flag file itself is deleted once both flags are gone —
a flag whose only two values are `true` and `true` is not a switch.

### 2.6 Stale document data — dropped, never migrated

- **Stale ACP-era `kind: "agent"` nodes in old canvas files** are meaningless
  test data. After C8 they resolve through `resolveSpec`
  (`physics/kinds.ts:98-102`) to `Geography` because `"agent"` is no longer
  a well-known kind — a text node in place, no seat, no ports, no crash. That
  is the correct outcome. **Do not** write a migration, a fallback shape, or a
  compatibility decoder for them. `WELL_KNOWN_ENTITY_KINDS` at
  `shared/canvas.ts:31-45` (an open display vocabulary, distinct from
  `WellKnownKind`) also loses its `"agent"` and `"herdr"` entries.
- **Retired kind strings already handled**: `canvas.ts:537`
  `RETIRED_SOURCE_NAMES` (`tower`/`quasar`/`booth`) and `canvas.ts:400`
  `RETIRED_CRITERIA_MODES` (`glyphs`/`wip`) are the existing precedent —
  strip on sanitize, degrade, invent nothing. `agent`/`herdr` need **less**
  than that: they degrade to geography with no sanitize step at all.
- **`ether.herdr` blobs** on old nodes: the schema key goes away in C7, so
  the existing unknown-key drop path handles them. No decoder.
- **47 test fixture files** construct `kind: "agent"` and are not stale data
  — they are the regression net and must be migrated with C8 (§3 C8).

---

## 3 · COMMIT SEQUENCE

Ordered by leverage — most branches deleted for least risk first. The
type model lands first (C1–C2), the mechanical site migration next (C3–C5),
the deletions after (C6–C7), and the one dangerous rename last (C8), by which
point almost nothing branches on kind any more.

Each commit is independently green: `bun run typecheck` (or the repo's
equivalent) **and** `bunx vitest run`. No commit leaves a half-renamed kind.

---

### C1 — Close the role set to the four words · ~11 files · types only

**Changes**: `FactoryRole` at `physics/schema.ts:22-29` loses `region` +
`furniture`, gains `geography`. `RolePair` at `physics/laws.ts:16-27`
replaces `ActorRegion` + `ActorFurniture` with `ActorGeography`;
`canonicalRolePair` (`:48-59`) and `grantLawBetween` (`:66-77`) follow.
`roleMayBeBlocked` (`phase-membership.ts:25-33`) drops to four arms.
`ResolvedSpec` (`physics/kinds.ts:58-73`) retags to
`Actor | Sink | Scheduler | Geography` per §1.3; `resolveSpec` (`:86-103`)
and `roleOf` (`:105-112`) follow. Consumers of the role literals:
`Canvas.tsx:737-742`, `digest.ts`, `rts/RtsBottomBar.tsx`,
`rts/RtsControls.tsx`, `physics/placement.ts`, `physics/stamp.ts`,
`physics/admit.ts`. Tests: `tests/physics/physics.test.ts`,
`tests/connect-preview.test.ts`.

**Why safe**: `laws.ts:70-72` already returns `GrantLaw.None()` for both
collapsed pairs and `phase-membership.ts:28-32` already returns `false` for
both — the merge cannot change a grant or a blocked set.

**Acceptance**: `bunx vitest run tests/physics tests/connect-preview.test.ts`
green; `expect(FactoryRole.literals).toEqual(["actor","sink","scheduler","geography"])`
added to `tests/physics/physics.test.ts`; full suite green.

---

### C2 — `seatOf` as the single actor resolution point · ~15 files · behavior-preserving

**Changes**: add `src/shared/actor-seat.ts` with `ActorSeat` + `seatOf`
(§1.4). While `agent`/`terminal`/`herdr` all still exist, `seatOf` resolves
all three internally — one function, one place, so every call site outside it
stops caring. Then rewrite the OR-chains to call it:

| site | today |
|---|---|
| `browser/edge-revocation.ts:140` | `kind === "agent" \|\| kind === "herdr" \|\| kind === "terminal"` → `roleOf(resolveSpec(...)) === "actor"` |
| `shared/message-delivery.ts:138` | negated three-kind chain → `seatOf(node) !== undefined` |
| `main/vellum/work/message-delivery.ts` | `target.kind === "herdr"` / `"terminal"` split → one `bindingId` target |
| `kernel/cycle.ts:107` | `entity?.kind === "agent" && entity.name` → `seatOf(node)?.seatKey` |
| `kernel/cycle.ts:418,437,468` | three `entity?.kind === "agent"` node lookups → one seat lookup by `seatKey` |
| `kernel/cycle.ts:471-475` | `managedAgent` tag check → `seatOf` non-undefined |
| `shared/station.ts:230` | `other.ether?.entity?.kind !== "agent"` → `seatOf(other) === undefined` |
| `renderer/lib/occupancy-feed.ts:71,106` | `kind === "agent"` → `seatOf(node)?.seatKey` |
| `renderer/lib/alert-attention.ts:35` | `kind === "agent" && name === agentKey` → `seatOf(node)?.seatKey === key` |
| `shared/portfolio.ts:54` | `.filter(e => e.kind === "agent")` → seat-bearing nodes |
| `shared/connections.ts` | actor-kind checks → `seatOf` |
| `browser/authz.ts:104-114` | three field-extraction branches → one `seat.bindingId` |
| `shared/terminal.ts:196-197` | the "partially authored terminal" early return is already correct; rewire to `seatOf` |

Delete `actor-surface.ts:145-163` (`SurfaceDeliveryTarget`,
`deliveryTargetFromSurface`) — with one seat the target is `bindingId`.

**Acceptance**: no behavior change asserted by the existing suite —
`tests/actor-surface.test.ts`, `tests/message-delivery.test.ts`,
`tests/message-delivery-service.test.ts`, `tests/b2-kernel-delivery.test.ts`,
`tests/pulse.test.ts`, `tests/kernel.test.ts`,
`tests/browser-edge-delete-teardown.test.ts`, `tests/station.test.ts`,
`tests/connections.test.ts` must pass **unmodified**. If a test needs
editing, the commit changed behavior — stop and split.

---

### C3 — Derived + presentation surfaces branch on the tag · ~12 files · no capability path

**Changes**: purely derived/read-only code, no ocap, no phase mint.

- `shared/region-rollup.ts:88-89` `kindRank` → `Match` on the resolved tag
  (`Actor` 0, `Sink` 1, `Geography`/`Scheduler` 2); `:136` `kind === "agent"`
  → `seatOf`
- `shared/work-canvas-merge.ts:13-14` `isWorkSurfaceKind` → split the actor
  half (`seatOf`) from the sink half (`SinkKind`); the function currently
  ORs both, which is the conflation
- `shared/execution-graph.ts:385-398` → exhaustive sink match; `artifacts`
  currently falls through silently and is not summarized
- `shared/factory-tick.ts:24` `isTaskSink` → `spec._tag === "Sink" && spec.kind === "task"`
- `shared/attention.ts:65-83` and `shared/digest.ts:297-316` → keep the
  exhaustive shape, retype the discriminant to `SinkKind` so the compiler
  enforces it (these are already the good pattern; this only closes the union)
- `renderer/lib/edge-mutations.ts:115` → sink-tag check
- `renderer/components/InspectorFields.tsx:543-545,553` → four-arm tag
  dispatch replacing the mixed scheduler/sink/actor ternary tree
- `renderer/components/nodes/TextNode.tsx:337-342,422-428,477-485,496-497` →
  one tag match; delete `isAgent`/`isHerdr`/`isTerminal` and
  `managedTerminal = isTerminal || isAgent`
- `renderer/components/InspectorPanel.tsx:182-185`,
  `renderer/components/rts/RtsBottomBar.tsx:414-428` → tag match
- Leave `shared/svg.ts:40` and `renderer/lib/presentation.ts:29,53` and
  `renderer/lib/signal-mark.ts:118` alone — colour/label by kind string is
  presentation over an open vocabulary, classified **incidental**, correctly.

**Acceptance**: `tests/region-rollup-service.test.ts`,
`tests/attention-factory.test.ts`, `tests/factory-claim-nudge.test.ts`,
`tests/presentation.test.ts`, `tests/surface-dock.test.ts` unmodified and
green. Snapshot diffs in `tests/b5-races-snapshots.test.ts` reviewed line by
line — a changed snapshot here means C3 changed a derived projection.

---

### C4 — Sink ops table keyed by role · ~5 files

**Changes**: `work/authz.ts:122-133` splits into `OPS_BY_SINK`
(`Record<SinkKind, …>`) + `ACTOR_INBOX_OPS`, and `opsForKind` becomes
`opsForSpec`. `shared/work.ts` nine `requireKind` sites (`:201,233,268,304,
378,396,412,461,503`) become `requireSink(node, "task" | …)` /
`requireActor(node)`; `:396`'s `["agent","herdr"]` is the conflation that
dies. `work/control.ts:616` store dispatch → sink tag match.
`renderer/components/InspectorFields.tsx:1182` `fromIsTask` → sink tag.

**Acceptance**: `tests/work.test.ts`, `tests/work-control-transport.test.ts`,
`tests/task-schema.test.ts` green. New assertion: adding a member to
`SinkKind` without a row in `OPS_BY_SINK` is a typecheck failure (verified by
a `// @ts-expect-error` fixture in `tests/physics/physics.test.ts`).

---

### C5 — Close the scheduler / pulse vocabulary · ~6 files

**Changes**: `PulseSource` (§1.6) replaces the
`"watcher" | "timer" | "manual"` union at `shared/ipc.ts:292`,
`kernel/cycle.ts:48`, `kernel/cycle.ts:345`. `kernel/service.ts:582`
constructs `{ _tag: "operator", regionId }` instead of `kind: "manual"`;
`cycle.ts:410` matches the tag. `InspectorFields.tsx:543-544` and
`TextNode.tsx:496-497` dispatch on the `Scheduler` tag's `kind`, which is now
a closed `SchedulerKind` — a new scheduler becomes a compile error at the UI,
which the scheduler scan measured as today's only non-type-safe hole.

Node authoring (`Canvas.tsx:572,584,625,640`,
`node-factories.ts:321,342`) is **unchanged** — authoring `entity.kind` is
correct per `architecture-factory-physics.md:71` (see §0.2).

**Acceptance**: `tests/kernel.test.ts`,
`tests/kernel-runtime-reconcile.test.ts`,
`tests/offline-remote-watchers.test.ts` green.

---

### C6 — Delete ACP · ~20 files, overwhelmingly deletions

**Changes**: everything in §2.1. `ACP_CHAT_SURFACE_HIDDEN` and every gate
reading it go away with the code behind the gate.

**>20 files justification**: this is a delete-only commit. A partial ACP
deletion does not typecheck (the IPC channel type union, the renderer state
machine, and the main-process service are one dependency web), so it cannot
be split without leaving an intermediate red. Review cost is low because the
diff is ~all removed lines with no logic rewritten.

**Acceptance**: `tests/chat-service.test.ts` and
`tests/acp-lifecycle-architecture.test.ts` **deleted** with the code they
cover (that is the correct end state, not a coverage loss).
`tests/mutations.test.ts` node-delete cases pass without the chat lease.
`grep -rc "chatOpen\|chatPrompt\|acp" src/ === 0`. `bun run build` +
`bunx vitest run` green.

---

### C7 — Delete herdr · ~30 files + 3 directories · **operator-gated**

**Changes**: everything in §2.2, plus the herdr half of every site C2/C3
already touched (those became `seatOf` calls, so the herdr arm inside
`seatOf` is the only remaining reference — a one-function deletion).

**>20 files justification**: same shape as C6 — deletion of a
tightly-coupled subsystem (17 main-process files that only import each
other) plus the removal of already-migrated call sites. Cannot be split
green.

**Blocked on**: operator confirmation that no live herdr pane matters
(§2.2). Do not proceed on inference.

**Acceptance**: `tests/` herdr suites deleted with the code;
`grep -rc "herdr" src/ === 0`; `ssh-architecture.test.ts` renderer allowlist
loses its two herdr entries and still passes; `bunx vitest run` green.

---

### C8 — THE COLLAPSE: `agent` ceases to exist · ~15 src + 47 test files

**Changes**: the payload the previous seven commits de-risked.

1. `physics/schema.ts:63-73` — drop `"agent"` and `"herdr"` from
   `WellKnownKind` (herdr already gone in C7)
2. `physics/kinds.ts:37-47` — drop the `agent` row, move `msgOffers` onto
   `terminal`
3. `shared/canvas.ts:539-580` — **delete `sanitizeActorSurfacePorts`** and
   its call site; delete the "demote"/"half-agent" comments with the function
4. `shared/canvas.ts:31-45` — `WELL_KNOWN_ENTITY_KINDS` drops `agent`
5. `shared/canvas.ts:354` — the `EtherMessages` comment stops naming
   `agent | herdr`
6. `shared/canvas.ts:423-429` — the `terminal` schema comment stops
   describing a cross-kind requirement
7. `process-identity.ts` — §1.5: delete `ProcessPrincipalKind` (`:19`), make
   `bindingId`/`canvasName`/`nodeId` required (`:22-31`), delete the three
   validation branches (`:118-123`), delete `unbindAgentKey` (`:152-158`)
8. `work/live-seat.ts:24-54,76-82,117-130` — collapse per E2's answer
9. `work/caller-resolve.ts:30-66,93,136` — one match path
10. `work/route-tokens.ts:141-148` — one principal kind, per E2
11. `work/control.ts:279` — role check
12. `browser/edge-grant.ts:174-182,217,505-509` — per **E1's answer**
13. `browser/process-bind.ts:40,88` — role check
14. `browser/authz.ts:27,101-114` — delete `BrowserCallerKind`, one field read
15. `node-factories.ts:60-175,256-274` — `makeActorNode` with optional
    `harness`; delete `makeAgentNode`; `HarnessPicker.tsx:156` and
    `TerminalWizard.tsx:80` follow
16. **47 test fixture files** — `kind: "agent"` → `kind: "terminal"` +
    a seat (`terminal.bindingId`, `terminal.harness` where the test needs a
    harness). Mechanical, greppable, and every one of them is an existing
    assertion that must still pass.

**>20 files justification (unavoidable)**: removing a member from
`WellKnownKind` is atomic — the moment `"agent"` leaves the literal, every
one of the 32 src files and 47 test files that names it is a type error.
There is no green intermediate. This is precisely why C1–C7 came first: by
the time this lands, the src-side delta is ~15 files of small edits (the
OR-chains and field extractions were already replaced), and the bulk is
fixture text. **Review protocol**: read the 15 src files; skim the 47 test
files as one `sed`-shaped diff.

**Acceptance**:
- `bunx vitest run` fully green with **no test assertion weakened** — a
  fixture may change its `kind`, never its expectation
- `grep -rn 'kind === "agent"\|kind: "agent"\|"agent"' src/ === 0` except
  presentation/label paths intentionally kept
- `kindsWithRole("actor")` deep-equals `["terminal"]`
- `sanitizeActorSurfacePorts` absent repo-wide
- Load an old canvas fixture containing an ACP-era `kind: "agent"` node:
  the node renders as a text node, `roleOf` returns `"geography"`, no
  crash, **and the node is still in the document** (the old sanitizer would
  have stripped it — dropping stale *actor data* is correct, silently
  deleting the operator's node is not)

---

### C9 — The cement · ~4 files

**Changes**: `tests/factory-physics-architecture.test.ts` (§4), the typed
assertions in `tests/physics/physics.test.ts`, the AGENTS.md law, and the
`architecture-factory-physics.md` negative case + roles-table rewrite. Also
rewrites `docs/managed-terminal-plan.md:34`'s
*"Actor = command template. Terminal = geography"* row into the mandate's
labels (§0.4), and `AGENTS.md:116-122` (§4.3).

**Acceptance**: each cement test **proven to fail** by temporarily
reintroducing the pattern it forbids, then passing once reverted. A cement
test never asserted against a red baseline is not cement.

---

## 4 · THE CEMENT

Modelled on `tests/ssh-architecture.test.ts` — source-grepping invariant
tests with an explicit allowlist, `expect(violations).toEqual([])`. New file:
`tests/factory-physics-architecture.test.ts`, scanning `src/` (and `tests/`
where noted) over `.ts`/`.tsx`, reusing that file's `sourceFiles` /
`display` helpers.

### 4.1 Grep-level invariants

**T1 · one actor kind** — typed, not grep. In `tests/physics/physics.test.ts`:
```ts
expect(kindsWithRole("actor")).toEqual(["terminal"]);
expect(WELL_KNOWN_KINDS).toEqual(
  ["terminal", "task", "requests", "artifacts", "page", "watcher", "timer"],
);
expect(FactoryRole.literals).toEqual(["actor","sink","scheduler","geography"]);
```
> **There is exactly ONE actor — the native terminal node.** `kindsWithRole("actor")`
> returned more than `["terminal"]`. A harness is a template *property* on the
> terminal seat, never a second kind. See docs/architecture-factory-physics.md §2b.

**T2 · `agent` is not a node kind** — scan `src/` + `tests/` for
`/\bkind\s*[!=]==\s*["']agent["']/` and `/\bkind\s*:\s*["']agent["']/`.
Allowlist: empty.
> **`"agent"` is not a node kind.** The terminal *is* the actor node — "an agent
> that has a terminal" is an incoherent statement. Use `kind: "terminal"` and read
> the seat with `seatOf(node)`; a node with no seat is GEOGRAPHY.

**T3 · no actor-kind OR-chain** — scan `src/` for
`/kind\s*[!=]==\s*["'](terminal|agent|herdr)["'][^\n]*(\|\||&&)\s*kind\s*[!=]==/`
(catches the negated `&&` form at `shared/message-delivery.ts:138` as well as
the `||` form at `browser/edge-revocation.ts:140`). Allowlist:
`src/shared/physics/kinds.ts` (the registry itself).
> **OR-ing node kinds to mean "is this an actor" is the duality this repo deleted.**
> Ask the role once: `roleOf(resolveSpec({ kind, isGroup }))`, or resolve the seat:
> `seatOf(node)`. Pattern to copy: src/main/vellum/browser/authz.ts `isBrowserCallerNode`.

**T4 · capability and phase planes never branch on kind** — for files under
`src/main/vellum/work/`, `src/main/vellum/browser/`,
`src/main/vellum/kernel/`, and
`src/shared/{work,execution-graph,attention,digest,region-rollup,factory-tick,connections}.ts`,
forbid `/(?:entity\??\.kind|nodeKind\([^)]*\))\s*[!=]==\s*["']/`. Allowlist:
`src/main/vellum/work/authz.ts` (the `OPS_BY_SINK` table, keyed by
`SinkKind`) and `src/shared/work.ts` (`requireSink`'s single comparison).
> **Capability/phase code branched on entity kind at `<file>`.** Node rules live at
> the ROLE level — docs/architecture-factory-physics.md §2a: *"A per-kind exclusion
> table is the anti-pattern the actor/sink/scheduler split exists to kill."*
> Resolve once with `resolveSpec`, then `Match.tagsExhaustive` on
> Actor | Sink | Scheduler | Geography.

**T5 · no invented vocabulary** — scan `src/` for
`/\b(half[- ]?agent|managed[- ]?agent)\b/i`, and for `/\bdemote/i` anywhere,
and for `/\bpromote/i` **only** within `src/shared/canvas.ts`,
`src/shared/actor-seat.ts`, `src/main/vellum/{work,browser,term}/`.
Allowlist for `promote`: `src/renderer/lib/mutations.ts` (`promoteLinkToPage`
at `:846` — link→page node transformation), `src/renderer/lib/dock-state.ts`
(`:236,254` — MRU dock ordering), `src/main/vellum/projection/reconcile.ts`
(`:243` — staged→applied delivery state).
> **"demote" / "half-agent" / "managed agent" name states that no longer exist.**
> A terminal with no binding is GEOGRAPHY, resolved once by `resolveSpec` — it is
> not repaired, not demoted, and not deleted from the operator's document. Do not
> reintroduce a sanitizer to enforce a cross-kind field requirement.

**T6 · no kind requires another kind's fields** — assert the symbol
`sanitizeActorSurfacePorts` is absent from `src/`, and that
`src/shared/canvas.ts` contains no `bindingId` reference inside a block
guarded by a kind comparison (implemented as: `canvas.ts` must not contain
both `/entity\.kind\s*!==\s*["']agent["']/` and `/bindingId/` — after C8
neither appears).
> **No kind ever requires another kind's fields.** There is no
> agent-that-needs-a-terminal. If a shape needs `terminal.bindingId`, that shape
> *is* the terminal. The runtime validator that enforced the old cross-kind
> requirement was deleted on purpose — its return means the type model regressed.

**T7 · hidden surfaces have no code** — assert
`existsSync("src/main/vellum/chat")`, `.../herdr`,
`.../term/herdr-bridge`, `src/renderer/components/chat`,
`src/renderer/components/herdr`, and `src/shared/legacy-surfaces.ts` are all
`false`; and `grep -c "ACP_CHAT_SURFACE_HIDDEN\|HERDR_SURFACE_HIDDEN" src/`
is 0.
> **A hidden surface is not a resting place.** ACP and herdr were deleted, not
> flag-gated: `main/vellum/ipc.ts` registered both IPC planes regardless of the
> UI flag, so "hidden" meant "callable but unreviewed". If this path is needed
> again, restore it as product with a plan — not behind a boolean that is always
> `true`.

**T8 · the principal is one struct** — assert `ProcessPrincipalKind` is
absent from `src/`, and that `src/main/vellum/process-identity.ts` contains
no `agentKey?:` or `paneId?:` field declaration.
> **One actor means one principal shape.** Optional `agentKey`/`paneId`/`bindingId`
> on `ProcessPrincipal` encoded three actor kinds as three runtime validation
> branches (the old process-identity.ts:118-123). `bindingId` is required because
> the seat is the identity.

**T9 · role resolution has exactly one site** — scan `src/` for
`/ResolvedSpec\.(Actor|Sink|Scheduler|Geography)\(/` and assert every hit is
in `src/shared/physics/kinds.ts`.
> **`resolveSpec` is the one place a node's role is decided.** Constructing a
> `ResolvedSpec` outside physics/kinds.ts forks the resolution and the fork will
> drift.

### 4.2 The one-line law for AGENTS.md

Insert in the factory-physics contract section:

> **One actor, one seat.** The native terminal node is the only actor kind — the
> terminal *is* the node, never a property a node has; a harness is a template
> property on that seat. Every node rule lives on the physics role
> (`actor` | `sink` | `scheduler` | `geography`), resolved once by `resolveSpec`
> — never on `entity.kind`.

`AGENTS.md:116` (*"one live ACP session per agent node"*) is deleted with the
ACP code in C6. `AGENTS.md:118-122` (*"`terminal` is the default terminal
entity … Herdr is an optional legacy bridge"*) is rewritten in C9: the
terminal node is the actor seat; the herdr bridge sentence goes with C7.

### 4.3 The negative case for docs/architecture-factory-physics.md

New **§2b**, immediately after §2a (`architecture-factory-physics.md:94-109`),
and the roles table at `:73-79` rewritten so `Actor` reads `terminal`
(one kind), `Region` and `Furniture` merge into `Geography`:

> ### 2b. No kind ever requires another kind's fields
>
> There is **no agent-that-needs-a-terminal.** A node kind names one thing; it
> never carries a hidden requirement on a second kind's shape. If a shape needs
> `terminal.bindingId`, that shape **is** the terminal — the terminal is the node,
> not a property the node has. "An agent that has a terminal" is not a state; it
> is a sentence that does not parse.
>
> A terminal with no binding is **geography**: `resolveSpec` returns it as such,
> and nothing repairs it, "demotes" it, or removes it from the operator's
> document. Illegal states are made unrepresentable in the type, never validated
> at load and never silently mutated away.
>
> **Retired — do not reintroduce:** the `agent` kind; the `herdr` kind; a second
> actor kind of any name; the `managedAgent` / `rawTerminal` surface split;
> "managed agent", "half-agent", "demote"/"promote" applied to a node's role;
> `ProcessPrincipalKind`; a per-kind ops table that lists an actor next to a sink.

---

## 5 · RISKS + OUT-OF-SCOPE

### R1 · Delivery (highest blast radius)

Pulse and message delivery reach the seat through
`kernel/cycle.ts:468-480` (finds the node by `entity.kind === "agent"` +
`entity.name`, then requires `surface._tag === "managedAgent"`),
`shared/message-delivery.ts:137-146`, and
`main/vellum/work/message-delivery.ts` (separate `herdr`/`terminal` target
filters). Collapsing the surface tag changes the lookup key from
`entity.name` to `seat.seatKey`. **Regression shape**: a seat whose
`seatKey` is not minted receives nothing, silently — delivery failure is a
no-op `continue` at `cycle.ts:474`, not an error. **Guard**:
`tests/b2-kernel-delivery.test.ts`, `tests/pulse.test.ts`,
`tests/message-delivery.test.ts`, `tests/message-delivery-service.test.ts`
must pass unmodified through C2, before any kind is deleted.

### R2 · Work-control identity

`process-identity.ts:118-123` (three validation branches),
`work/caller-resolve.ts:30-66`, `work/live-seat.ts:27-82`,
`work/route-tokens.ts:141-148`, `work/control.ts:279`. **E2 (§0.1) is
unresolved**: route-token mint currently rejects `terminal`, so Tier-3
remote work-control has no legal principal after the collapse. Do not guess.
**Guard**: `tests/process-identity.test.ts`,
`tests/work-control-transport.test.ts`, `tests/hermes-host-identity.test.ts`.

### R3 · Browser edge-grant minting

**The single most likely silent regression.** `edge-grant.ts:505-509`
refuses browser authority to terminal principals; `:174-182` throws for them;
`:217` skips them in the revocation subscriber. After the collapse every
principal is a terminal, so a naive rename makes `admitPrincipal` refuse
everything — browser automation dies quietly with a `caller_wrong_kind`
denial that looks like correct fail-closed behavior. **E1 (§0.1) must be
answered before C8.** **Guard**: `tests/browser-edge-grant.test.ts`,
`tests/browser-edge-delete-teardown.test.ts`,
`tests/browser-control-transport.test.ts`,
`tests/station-browser-delegation.test.ts`,
`tests/station-browser-target-policy.test.ts`,
`docs/capability-revocation-matrix.md` re-walked by hand.

### R4 · The actor inbox is role-level (NOT a widening — closed by ruling)

Struck as a risk. `terminal: emptyOffers` (`kinds.ts:39`) was a wrong
declaration, not a narrow capability: the actor role has an inbox, and there
is one actor role. Correcting it is the alignment, not a change to weigh.
The remaining *mechanical* checks still apply and stay in C1's gate:
wielding requires process-bind (`architecture-factory-physics.md:66-69`),
actor→actor is `GrantLaw.OptIn` (`laws.ts:71`) so no default grant appears,
and `tests/physics/physics.test.ts` grant-law + `ACTOR_ACTOR_INBOX_PORTS`
assertions plus `stampActorActorMsgPorts` must stay green. Do not re-open
this as a product question.

### R5 · Occupancy / attention feeds

`renderer/lib/occupancy-feed.ts:71,106`, `renderer/lib/alert-attention.ts:35`,
`shared/region-rollup.ts:136` all key hermes activity off
`entity.kind === "agent" && entity.name`. But `entity.name` is minted only by
`makeManagedAgentNode` (`node-factories.ts:98-101`, `<host>:<profile|harness>`);
`makeTerminalNode` (`:256-274`) mints **no** `entity.name`. So after the
collapse, terminal nodes created by `TerminalWizard` have no `seatKey` and
would drop out of occupancy and attention. **Fix inside C2**: `seatOf` derives
`seatKey` from `<hostId>:<harness ?? "shell">` when `entity.name` is absent,
so the key exists for every seat. **Guard**:
`tests/alert-attention.test.ts`, `tests/region-rollup-service.test.ts`.

### R6 · Usage rail — low risk, verified

`src/main/vellum/usage/usage-source.ts` contains no `entity.kind` reference;
`UsageHud.tsx:92` keys on `quota.provider`, not node kind. The usage rail is
decoupled from the actor model and needs no change. (Grounded: grep over
`src/main/vellum/usage/` and `UsageHud.tsx` returned no kind coupling.)

### R7 · Stale-canvas load path

Deleting `sanitizeActorSurfacePorts` (`canvas.ts:546-580`) removes the code
that today *deletes* an ACP-era agent node's entity on load. After C8 such a
node survives as a text node resolving to geography. **This is the intended
behavior**, but it is a visible change: canvases that previously "cleaned
themselves" now show a stale node. That is correct — the operator's document
is not ours to mutate. **Guard**:
`tests/actor-surface-sanitize.test.ts` is rewritten (not deleted) to assert
the new outcome: node retained, `roleOf === "geography"`, no seat, no ports.

### Deliberately NOT touched

- **`page` as a sink.** Stays `role: "sink"` with `browser.automate`
  (`kinds.ts:41`). Settled by operator ruling 2026-07-26: browser pages are
  data living in the runtime that actors interact with — sinks, never
  geography. Not an open question.
- **Authoring `entity.kind`.** Node factories keep stamping
  `entity: { kind: "watcher" }` etc. (`Canvas.tsx:572,584`,
  `node-factories.ts:321,342`). Role-from-kind is the doctrine
  (`architecture-factory-physics.md:71`); §0.2.
- **Presentation-by-kind.** `shared/svg.ts:40`,
  `renderer/lib/presentation.ts:29,53`, `renderer/lib/signal-mark.ts:118`,
  `digest.ts:288` — colour, hue, label over an open kind vocabulary.
  Classified incidental by three independent scans; leave alone.
- **`promote` outside the physics domain.** `mutations.ts:846`
  (`promoteLinkToPage`), `dock-state.ts:236,254` (MRU),
  `projection/reconcile.ts:243` (staged→applied). Legitimate, unrelated.
- **The five `managed-terminal-*` / `managed-*` files** that describe the PTY
  transport rather than a type discriminant (§2.4). Renaming is churn.
- **`ether.messages` as a node store.** The mandate lists "messages" as a
  sink; in the document it is a store on the actor node
  (`canvas.ts:354-358,420`), not a node kind. Not restructured here.
- **Work role (`ether.workRole`, `canvas.ts:402-408`).** An operator-authored
  claim-routing label, explicitly distinct from the physics role
  (`architecture-factory-physics.md:85-92`). Untouched.
- **Edge criteria / phase plane.** `EdgeCriteria` (`canvas.ts:392-397`) and
  `execution-graph.ts` phase derivation are the *phase* plane; this plan
  touches the role/kind axis only.
- **Region-vs-group structure.** Only the *role name* merges into
  `geography`; group membership, `ether.region`, and pulse briefing are
  unchanged.
- **`src/main/vellum/region-rollup.ts`** (distinct from
  `src/shared/region-rollup.ts`) — service wiring, no kind branch of its own.

### Open questions for the operator

**Q1** — The mandate's role sketch puts "browser pages" under GEOGRAPHY, but
`page` offers `browser.automate` (`physics/kinds.ts:41`) and therefore
*receives an op*, which is the sink definition
(`architecture-factory-physics.md:76`). Geography holds no ocap
(`:79`). This plan keeps `page` a **sink**. Confirm, or the browser plane
loses its target.

**Q2** — E1 (§0.1): does a process-bound terminal seat wield
`browser.automate`? Yes ⇒ rewrite `edge-grant.ts:174-182,505-509` to key on
`bindingId`. No ⇒ the browser plane has no caller and
`browser/{authz,edge-grant,edge-revocation}.ts` are deleted with ACP.

**Q3** — E2 (§0.1): do Tier-3 route tokens survive with a terminal principal
(`work/live-seat.ts:27` inverts), or does Tier 3 retire with ACP and herdr?

**Q4 — CLOSED by operator ruling 2026-07-26.** Herdr is gone/hidden, and the
data currently in the system is unimportant. C7 is **ungated**: delete the
herdr web without preserving existing panes, and do not add a data-preservation
step for them.
