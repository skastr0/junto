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

## 4. Canvas structure (canvas-lead, draft for remote-lead)

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
