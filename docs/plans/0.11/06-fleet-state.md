# Fleet state: one authority, with fallbacks

Owner: product-lead. Approved by the operator 2026-10-28, end to end.
Design: remote-lead with tech-lead and canvas-lead.

## Target

A machine with seats, automations, task boards and Artifacts nodes does a
full night's work while the operator's MacBook is off. There is always one
authority for a canvas, and when the preferred one is away another machine
takes its place, so work never waits on a closed lid.

## Decisions (operator, 2026-10-28)

These replace the first direction of this plan (every machine changes state
on its own and reconciles later), which the operator withdrew.

- **One authority at a time.** Exactly one machine rules a canvas: two seats
  on two machines working one task always see one answer.
- **An ordered list of authorities.** The operator names them per canvas,
  for example MacBook, then Mac mini, then a VPS. The first one that can be
  reached is the authority. Junto never adds a machine to the list.
- **Fallbacks keep the canvas whole.** Every machine on the list holds the
  full canvas and stays current over its links (the tailnet), so any of them
  can take over at once.
- **Never two authorities.** If no machine on the list can be reached, work
  that needs ruling stops and says why. It does not split and reconcile
  later: stopping is preferred to divergence, simpler and less bug prone.
- **Machines only where there is a runtime.** A machine is chosen for
  seats, automations, terminals, Files and other things that run somewhere.
  A task board or an Artifacts node is data and is never bound to a machine.
  S6 in `05-automations.md` (a board ruled by its own machine) is dropped.

## How it behaves

1. **The authority leaves cleanly** (lid closed, quit, update): it hands
   authority to the next machine on the list before it goes, its queue
   drained, and the new authority rules what was queued for it
   (`ruler.sweep`).
2. **It comes back**: it catches up on what was ruled while it was away,
   then takes authority back. One ruler at a time, so nothing reconciles.
3. **It disappears without a word** (crash, battery, network): the next
   machine takes over only when it can show the old one is not still
   ruling. If it cannot, work waits rather than risk two authorities.

## What the design must answer

1. How authority is held and passed (terms or leases), and how a machine
   shows the one before it is not ruling, with two machines and with three
   or more, when one only goes quiet.
2. What a machine that reaches no authority does: which writes wait, which
   are refused, what seats and the operator see.
3. What a fallback must hold to rule (the whole canvas, the journal, reach,
   automation definitions; secrets stay per machine), and how it stays
   current.
4. Canvas structure: whether it moves with authority or waits for the
   preferred machine. canvas-lead's section below was written for the
   withdrawn direction; its journal and stated-count ideas are input, the
   design reconciles it with one authority at a time.
5. The operator's window on a machine that is not the authority: edits go
   to the authority over the link, synchronously, and the window is
   read-only when none can be reached.
6. How this fits S1 to S5 in `05-automations.md`: automations still run on
   their own machine; their writes go to whichever machine is the authority.
7. Slices, size and risk, and the doctrine edits in `machines.md` (Rules 2,
   4, 5, 7), `state-architecture.md`, `security-doctrine.md` and `0.10/07`.

The design comes to product-lead before slices land; the direction is
already approved.

## Design (remote-lead)

**Headline.** One authority at a time is enforced by commit, not by clocks.
A ruling counts only once the canvas's standbys hold it. A machine that
lost authority but is still running can therefore rule nothing that anyone
sees: it cannot commit. Showing that the previous authority is not ruling
needs no lease and no clock. It follows from who must agree to a commit.

### 1. Terms, commit and takeover

- **The ruling log.** Everything the authority rules for a canvas goes into
  one log, in order: every `ruling.applied` and `ruling.refused`, and every
  `structure.changed` (section 4). Each entry carries `(term, index)`. The
  canvas `seq` keeps counting across terms. Today's ruling transaction
  writes the entry; the projection into resource and canvas tables happens
  only at commit.
- **Terms.** The authority list (Decisions) is canvas structure that only
  the operator edits. A term is a number with one authority and the list as
  it stood when the term began. A machine that hears a higher term stops
  ruling at once, and from then on only follows.
- **Commit quorum.** The listed machines vote. An entry commits when a
  quorum of the term's list holds it durably.
  - With three or more machines, the quorum is a majority of the list. For
    MacBook, mini and VPS, any two rule and commit.
  - With two machines, the fallback holds the casting vote. The preferred
    machine commits only with the fallback's acknowledgement; the fallback
    commits alone once it is the authority. This is the one asymmetry, and
    it is what lets the mini rule all night. A quorum for a pair has to
    include one fixed side, and the operator's order says which.
  - With one machine, it commits alone, which is today's behaviour.
- **Nothing is shown before commit.** The writer gets `applied` or `refused`
  only at commit. Until then it reads as `queued`, a success (02, 'Editing
  machine away'). Panes, automations, notices and the exchange read
  committed entries only. The one exception is the window echoing the
  operator's own gesture, which it predicts and then delivers (section 4).
  An authority that steps down discards its uncommitted tail. That tail was
  never shown. A seat's or an automation's command is still an unruled row
  in its writer's queue, which drains to the new authority (02, 'Moving the
  editing machine'). An operator edit is never queued: one in flight is
  refused, retryable, because authority moved, and the window sends it
  once, built afresh, to the new authority (section 4). So the tail
  canvas-lead names in section 4 cannot exist. A committed entry is on a
  quorum, and a new authority is always elected from among the machines
  that hold the committed log.
- **Changing the list changes the quorum.** Adding or removing a machine
  changes who must agree. In a pair, reordering does too, because the order
  picks the casting vote. Raft's one-machine-at-a-time change is not safe
  here (tech-lead): from [MacBook, mini] to [MacBook, mini, VPS], the old
  quorum {mini} (its casting vote) and the new majority {MacBook, VPS} do
  not meet, so two authorities could commit at once. So a list edit is a
  joint entry: it carries the old list and the new one, commits only on a
  quorum of each, and the new list alone follows once it has committed.
  The joint state lives only in `canvas_log`. `canvas_authorities` is
  written when the final list commits. The simulation covers list edits
  made during partitions.
- **Election.** A standby that hears nothing from the authority for the
  timeout (10 s, tunable) asks for votes for term + 1. A voter grants one
  vote per term, and only to a candidate whose log is at least as complete
  as its own. Among candidates that are caught up, the one higher on the
  list wins: a lower machine waits one timeout before it stands, to give a
  higher one the first chance. The timeout affects only how fast a
  takeover happens. Safety comes from the quorum, never from a clock, so a
  MacBook that wakes from sleep thinking it still rules simply fails to
  commit. It then hears the higher term and steps down.
- **Two machines, worked.** The MacBook rules term 7 and every commit waits
  for the mini's acknowledgement (one tailnet round trip: p50 35 ms, p90
  about 130 ms, as measured for 02). The lid closes without a word. After
  10 s the mini starts term 8 and commits alone with its casting vote. The
  MacBook, asleep or partitioned, cannot commit term 7 without the mini, so
  it rules nothing. On return it hears term 8, steps down, catches up from
  the mini's log, and asks for authority back. The mini hands it over
  cleanly in term 9. If the mini dies while the MacBook rules, the MacBook
  cannot commit, its seats' writes read `queued`, and the window says the
  mini is unreachable. The operator can bring the mini back, or run
  `junto authority alone` on the MacBook (section 2).
- **Three or more, worked.** MacBook, mini, VPS. The MacBook sleeps; the
  mini and the VPS form a majority, and the mini wins because it is higher
  on the list. If the mini also dies, the VPS alone is a third, not a
  majority, so it waits. No pair of machines that cannot see each other can
  both commit, because any two majorities share a machine.
- **Clean leave.** On quit, update or sleep notice, the authority hands
  authority to the next caught-up machine on the list in one round trip. No
  queue needs draining, because every committed entry is already on the
  quorum. Queued command rows from other machines move with their writers'
  catch-up.
- **No library decision yet.** The core is a small pure state machine (term,
  vote, log match, commit index), driven by a deterministic simulation that
  injects partitions, crashes, lost and reordered messages, and sleep. That
  simulation is the release gate for this slice. tech-lead decides whether
  an existing TypeScript Raft core fits our SQLite transactions (unverified)
  or we write the hundred or so lines ourselves.

### 2. A machine that reaches no authority

- **Writes:** a seat's or an automation's write becomes a durable
  `command.queued` row and returns `queued` with a reason ("no authority:
  MacBook asleep since 01:12, mini unreachable"). Nothing is refused except
  `queue_full` (02). Mail is not ruled, so it crosses or is held as today
  (Rule 6).
- **Reads:** local and committed, marked stale since the last commit heard.
- **Automations:** schedules, polls, code steps, own-seat and signal
  triggers fire as usual, and their writes queue. Task-change triggers wait
  for commits.
- **Window:** read-only for structure and operator commands. The banner
  names the list and what each machine is doing.
- **Breaking a pair:** `junto authority alone <canvas>`, an owner command
  run on a listed machine, is the operator's statement that the other
  machine is dead. It starts a term in which this machine commits alone. If
  the other machine was in fact ruling, both committed. The later term wins
  on contact; the losing term's entries after the fork are queued again as
  commands and shown as 'ruled while another machine held authority'.
  Nothing is dropped. This is the only path to divergence, and only the
  operator takes it.

### 3. What a fallback holds, and how it stays current

A listed machine keeps the whole canvas (Rule 5's 'machine that keeps the
whole canvas'): the committed log, every resource table, the structure
journal with its private fields (briefings, notes, region folders and
environment as data), automation definitions (S1), placement history, every
mail and signal row (so it can relay), and every artifact body pulled
eagerly, because ruling an edit needs its base. Secret values never travel;
each machine shows which secrets it lacks (Rule 9). Standbys are current by
construction for the log, which is synchronous to a quorum; mail, signals
and session facts stay asynchronous rows. A page or a Files node names its
host machine, because it has a runtime (Decisions); it does not move with
authority.

### 4. Structure

Structure moves with authority, as canvas-lead's section has it, and its
`structure.changed` entries are entries in the one log, so they commit by
quorum like rulings. That removes the tail rule. A crashed authority holds
no committed entry its successor lacks, and an uncommitted one was never
shown. Stated-count re-judgment stays dropped.

### 5. The operator's window off the authority

The window sends each operator and structure command to the authority over
the link, synchronously, and shows it once committed. With no authority it
is read-only and says why. An operator command is admitted only from a
listed machine, over a link authenticated by S5's per-opener key, and from
the trusted window or an owner command there, never from a seat
environment.

### 6. S1 to S5

All stand. S1: automations run on their own machine, unchanged. S2: their
command rows go to whichever machine is the authority; admission ('valid
only from the automation's machine') is unchanged. S3: firing rows go to
the listed machines, not 'the editor'. S4: `seat.control` and its settled
row are entitled to the seat's or automation's machine and the listed
machines. S5: required. Listed machines link to each other over the
tailnet, and the per-opener key proves which machine is calling. S6:
dropped. K5: code steps have no per-machine allowance (operator,
5020cea97). A code step is trusted when its definition came from an applied
ruling of the term's authority, so whichever listed machine rules can set
the code that runs.

### 7. Slices, size, risk, doctrine

| Slice | What | Size | Risk |
|---|---|---|---|
| F0 | S5 links from any end, with per-opener keys | M | medium |
| F1 | Authority list (each edit a joint entry, committed on a quorum of the old list and of the new), terms, votes, transfer, `junto authority status`; the deterministic simulation, list edits included | L | high |
| F2 | The log with quorum commit: rulings carry `(term, index)`, projection at commit, step-down discards the uncommitted tail; every ruler (task, artifact, artifact node, automation) moves to it | L | high |
| F3 | Keepers: listed machines get the uncut canvas, eager bodies, relay rights | M | medium |
| F4 | Structure in the log; window commands forwarded to the authority; read-only with none | L | medium |
| F5 | No authority: queued reasons, banner, `junto authority alone` | M | low |
| F6 | Migration: each canvas's editor becomes the list `[editor]` at term 1, so nothing changes until the operator adds fallbacks; expand only | S | low |

Order: F0, F6, F1, F2, F3, F5, F4. Altogether XL. The risk sits in F1 and
F2, and the simulation is what keeps it there. remote-verify proves each
slice on the mini and a Linux machine: tailnet cut, `kill -9`, lid sleep,
clock jumped both ways.

Doctrine, in the commits that land each slice:
- `machines.md`: Rule 2 (one authority at a time from the operator's list;
  listed machines keep the whole canvas; structure moves with authority;
  pages and Files name a host); Rule 4 (rulings and structure come from the
  authority of the term they state; operator commands from a listed
  machine's window); Rule 5 (listed machines keep and relay;
  `command.queued` goes to the current authority); Rule 7 (S5); a new rule
  for terms and quorum commit; drop the 'moving the editing machine' and
  'editing from another window' items from Later.
- `state-architecture.md`: Canvases (canvas commands are log entries);
  Independent ticks (automations run on their own machine); a new section
  for the log, terms and commit.
- `security-doctrine.md`: Authority (listing a machine grants it the
  canvas's authority, and a compromised listed machine can win a term; in a
  pair, the fallback's casting vote means a compromised fallback can take
  authority at will); Immutable work (rulings from the authority of the
  stated term); Links (S5's keys); and `junto authority alone` as an
  operator-only fork.
- `0.10/07`: Runner, one per machine (S1).

## F1 and F2 (tech-lead's answer)

**F1: write the core ourselves.** No TypeScript Raft library is both
maintained and used (searched 2026-10-28: `@maboke123/raft-core` 0.2.1 is
young and little used; `@coaty/consensus.raft` is an etcd port whose own
README says the JavaScript Raft libraries are unmaintained). More to the
point, ours is not textbook Raft. The pair's casting vote, list-order
priority at election, `junto authority alone`, and a log that has to live in
our STRICT tables inside StateEngine transactions all sit outside a
library's model. So copy etcd/raft's shape, not its code. The core is one
pure function, `step(state, message | tick) → {persist, send, apply}`, with
no I/O, no clock and no Effect runtime inside. Effect drives it: persist in
one transaction, then send, then apply. The simulation runs the same pure
core under a seeded scheduler and a virtual clock. It checks Raft's four
safety properties on every step (election safety, log matching, leader
completeness, state-machine safety), plus ours: no two machines apply
different entries at one index, a pair commits only through the fallback,
and a list edit changes one machine per committed entry. Its size is the
simulation, not the core.

The pair is safe as designed. Every pair quorum contains the fallback ({P, F}
when P rules, {F} when F rules), so any two quorums intersect. One group per
canvas, with heartbeats batched per machine pair over the one link, so a
hundred canvases do not mean a hundred timers per peer.

**F2: SQLite holds it cleanly, if the authority judges ahead and applies at
commit through the one fold.** Today a ruler writes the projection and its
`ruling.applied` in one transaction, and every other machine reaches the same
tables by `foldRuling` (`src/main/junto/work/ruling-projection.ts`). F2 makes
the fold the only apply path, on the authority too.

1. **Judge.** The authority takes a canvas's pending commands as one batch.
   In one `BEGIN IMMEDIATE`, inside a savepoint, it runs today's rulers
   unchanged and keeps the rulings they record. Then it rolls the savepoint
   back. Savepoint rollback already discards `afterSqlCommit` callbacks.
   Content puts are content-addressed, so a rolled-back body is garbage,
   never wrong.
2. **Append.** In the same transaction it writes the rulings as log entries
   `(term, index)` and its own durable acknowledgement. Then it sends them.
   No transaction is ever open across the network.
3. **Apply at commit.** When a quorum holds them, one transaction folds the
   entries through `foldRuling`, advances `commit_index` and `applied_index`,
   and only then publishes notices and answers `applied` or `refused`.
4. **One batch in flight per canvas.** The next batch is judged after the
   previous one is applied, so every judgment sees committed state plus the
   earlier commands of its own batch (the savepoint). That needs no
   speculative overlay and no undo. Step-down deletes log rows above
   `commit_index`, and the projection was never touched. Throughput is one
   batch per round trip (p50 35 ms), and bursts are absorbed into the batch.

What F2 has to prove first: **the fold equals the ruler.** For each of the
four rulers (task, artifact, artifact node, automation), a property test
runs a command sequence through the ruler's direct write and through judge,
rollback and fold, and compares every table both reach. Any difference is a
bug today as well, because replicas already depend on it.

Storage, STRICT, with no JSON: `canvas_log (canvas_name, log_index, term,
kind, ...)` holding a ruling's id or a `structure.changed` seq, with the
bodies staying in the rows that already hold them, and
`canvas_consensus (canvas_name PK, current_term, voted_for, commit_index,
applied_index)`.

Two settings change:
- **Durability.** WAL with `synchronous=NORMAL` can lose the last commits on
  power loss. That is acceptable today, but not for a vote or an
  acknowledgement, which Raft requires to be durable before the reply.
  Consensus transactions run with `synchronous=FULL` (it is per connection,
  set around the transaction) and are measured. The remainder stay NORMAL.
- **Stale reads.** Safety needs no clock, but freshness does. An authority
  that has not heard a quorum within the election timeout marks its reads
  stale, the way Raft's CheckQuorum does. That is the one place a timer
  touches state, and it only labels reads.

Compaction: entries at or below `applied_index` that every listed machine
holds are dropped. A machine further behind catches up by a canvas copy, as
a new machine does today. Migration (F6) is the log empty at term 1,
`commit_index` = `applied_index` = 0, with today's tables as the snapshot.

## 4. Canvas structure under one authority (canvas-lead's answer)

**Structure moves with authority.** Whichever machine rules a canvas also
changes its nodes, wires, regions and placements. A fallback that rules
lets the operator and overseer seats edit the canvas exactly as the
preferred machine would.

- **Why it moves.** The first answer (below) kept structure on one machine
  because merging structure can grant reach nobody drew. One authority at a
  time never merges, so that reason is gone. Splitting the two roles would
  create a second authority. The ruler checks reach against structure
  (`src/shared/region-reach.ts`), so it would be judging against a copy that
  lags another machine, and that brings back the stated-count machinery. The
  fallback already holds the whole canvas (Decisions), so it has everything a
  structure edit touches. Waiting for the preferred machine would stall every
  overseer seat and the operator's window all night, for no safety gained.
- **One count across handovers.** The canvas `seq` (`canvases.seq`,
  `src/main/junto/model/records.ts`) belongs to the canvas, not to a
  machine. The new authority continues from the head it was handed, so
  "a copy replaces an older one" (Rule 2) still works by `seq` alone, and a
  returning machine catches up by applying `structure.changed` in `seq`
  order. Each entry records the authority's term beside its `seq`.
- **No tail.** An earlier draft of this section had a tail rule. Quorum
  commit (section 1 of the design) makes it unnecessary: a committed entry is
  always on the successor, and an uncommitted one was never shown.
- **The window predicts a drop and settles it at commit.** The window already
  shows a command first and sends it afterwards (`store.show`, then
  `store.deliver`, in `src/renderer/lib/model-authoring.ts`). That stays.
  "Nothing is shown before commit" applies to every other reader: panes,
  seats, automations, the exchange. It does not apply to the window's own
  echo of the operator's own gesture. Without the prediction, a dropped card
  would jump back for one round trip and then forward again. That is the
  double move `Canvas.tsx`'s `finishDrag` was fixed to stop. A drag commits
  once, at the drop, so 35 to 130 ms on the tailnet never shows. Until the
  commit arrives, the save state reads `saving`.
- **An operator's edit in flight when authority moves.** Commands from
  seats wait in their writers' queues. The operator's edits do not: they are
  synchronous and are never queued. If the authority steps down before such
  an edit commits, the window gets a retryable refusal ("authority moved to
  <machine>"). The prediction rolls back through the re-read the window
  already does on a refusal (`readAgain` in `src/renderer/lib/mutations.ts`),
  and nothing goes into undo. The window then sends the edit once to the new
  authority, built afresh against the canvas as that authority holds it.
- **The authority list is a quorum change, not an ordinary edit.**
  Adding or removing a machine changes who must agree. In a pair, reordering
  does too, because the order decides which machine holds the casting vote.
  Each such edit is a joint entry, committed on a quorum of the old list and
  of the new (section 2). Reordering three or more machines changes only the
  tie-break and is an ordinary edit.
- **Unchanged:** a seat's `host` still has one writer, the authority, and a
  machine acts on a move once it holds that count (Rule 3). Secret values
  never travel. Region folders and environment are data the fallback holds,
  but a seat starts only on its own machine, from that machine's folder.
- **What becomes of the first answer:** the structure journal stays, now as
  entries in the one log. Stated counts with re-judgment on arrival are
  dropped: the one authority rules each queued command against its current
  canvas, as the ruler does today.

### First answer, for the withdrawn direction (input only)

**Recommendation: in the first version, canvas structure still has one
writer. Every fact states which version of the structure it was checked
against, so state reconciles without that writer being online.** Structure
here means nodes, wires, regions and placements.

### Why structure stays single-writer

- **The night's work changes no structure.** Task state, assignment,
  artifacts and labels, automations and their firings, mail: all of it
  changes inside nodes and wires that already exist. None of it is a canvas
  command (`src/shared/model/commands.ts`: Add, Remove, Move, Restack,
  Recolor, Edit, Rewire, Reseat, Batch, GrantOverseer). Structure is drawn by
  the operator and by overseer seats.
- **Structure is authority.** Reach is worked out from the rectangles on
  every read (`src/shared/region-reach.ts`, header), and wires grant verbs.
  Suppose one machine grows region A while another moves a seat to A's edge.
  The merge puts the seat inside A, and neither author drew that. Containment
  belongs to two rows at once, so a per-row merge can converge on the same
  result everywhere and still grant reach nobody intended. That is a silent
  change of authority, the worst place to have one.

### What changes in the first version

1. **The editing machine becomes the canvas's structure author.** It is the
   one machine that changes nodes, wires, regions and placements. It no
   longer rules resource state (question 2). The copy every other machine
   holds stays read-only for structure, as Rule 2 has it now.
2. **Every resource fact states the count it was judged at.** A seat's write
   on any machine is checked against the copy that machine holds, and the
   fact carries that copy's `seq`. There is a precedent: a refusal notice is
   already judged "at the canvas count the row states" (Rule 4). The stated
   count may be no older than the newest copy that machine confirmed it
   installed. `canvas_copies_sent` already records each count sent to each
   machine (`src/main/junto/work/repository.ts`, `recordCanvasCopySent`);
   this adds an install acknowledgement.
3. **Structure becomes an ordered journal with one writer.** Each committed
   canvas command already moves `seq` up by one and names the rows it changed
   (`state-architecture.md`, Canvases). Each one is kept as a
   `structure.changed` fact in `seq` order, so any machine can rebuild the
   **reach frame** at any count. The reach frame is the part of the structure
   that reach and admission read: node ids, kinds and rectangles, plus each
   wire's ends and verb. Every copy carries all of that today. Private fields
   (seat guidance, the briefing, region folders and environment, notes) are
   still cut per destination. Every machine then judges a fact against reach
   at the fact's stated count and gets the same verdict. A structure change
   applies from its count onward, which is how wires already behave ("mail
   written before then still arrives", Rule 2). This journals commands, not
   whole canvases, so "no history of whole canvases is kept" still holds.
4. **A fact that fails the check again on arrival is kept and shown as
   refused, never dropped** (question 5).
5. **A seat's machine (its `host`) always has one writer** (Rule 3). If two
   machines each believe a seat is theirs, both start it. Moving a seat stays
   a structure change by the author, and a machine acts on it once it
   installs the copy.

**What the operator gives up:** while a canvas's author is off, nobody
changes that canvas's structure. Seats keep working inside the structure they
have. Handing authorship to another machine (Rule 2 reserves that for remote)
gets simpler once no machine rules resource state: it is one field plus the
journal head. It needs both machines online, so it is left out of the first
version unless the operator asks for it.

**Size and risk:** medium. The work is one journal table written in the
command's own transaction, one new exchange row kind (`structure.changed`),
and reach at a count as a pure function that replays the journal, cached by
count. Migration writes one snapshot fact per existing canvas at its current
`seq`. Facts already ruled are not judged again. Journal entries older than
the oldest count any unreconciled fact states can be folded into a snapshot.

### If structure gets more than one writer later

These merge rules are designed now so that the first version rules nothing
out:

- Ids are global and minted by the sender (`commands.ts`, Add), so adds
  commute.
- Remove leaves a tombstone. A concurrent edit to a removed node stays in the
  journal and is shown, never applied. Wires go with either end, as they do
  today.
- Position and size, z order, colour, each Edit field and each Rewire field:
  each is a last-writer-wins value per node and field, ordered by a hybrid
  logical clock, with the installation id breaking ties.
- Reseat is one value covering agent key, binding, harness and host together.
  GrantOverseer comes only from the operator. A seat's host never has two
  writers (point 5 above).
- A Batch stays atomic for its own writer, never across writers.
- A merge whose result changes any seat's reach, compared with what each side
  had, raises a reconcile notice naming the seat and the region before and
  after.

### Doctrine edits for structure (question 7)

- `machines.md` Rule 2: "one canvas, one editing machine" becomes "one
  structure author per canvas". The line "no merging of concurrent edits"
  stays, scoped to structure.
- `state-architecture.md`, Canvases: canvas commands are kept as an ordered
  journal of `structure.changed` facts. A whole canvas is still never kept.
