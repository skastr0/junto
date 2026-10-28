# Fleet state: every machine changes state on its own

Owner: product-lead. Decided by the operator 2026-10-28. Design: remote-lead
with tech-lead and canvas-lead.

## Target

A machine with seats, automations, task boards and Artifacts nodes does a
full night's work while every other machine, the operator's MacBook
included, is off. Each machine makes every state change it needs on its
own; when machines meet again their changes reconcile, and every machine
ends with the same state. Seamless, fleet-wide operation.

## Decisions (operator, 2026-10-28)

- **No state change waits for another machine.** Task state, assignment,
  artifacts and their labels, automations and their firings, mail: a seat
  or automation on any machine changes them while the editing machine
  sleeps.
- **Changes reconcile later, deterministically.** Event sourcing or CRDTs,
  whichever fits: the operator does not mind which. The result is the same
  on every machine regardless of the order changes arrive, and no change is
  silently lost.
- **This replaces "one canvas, one editing machine" as the authority for
  state** (`docs/machines.md` Rule 2 and Rule 4, `0.10/07` Runner) and
  supersedes S6 in `05-automations.md` (a board ruled by one named
  machine).

## What the design must answer

1. **The model.** Facts with a deterministic merge per kind of state, CRDTs,
   or a mix; how a fact is identified, ordered (clocks) and replayed; what
   the existing `work_facts` journal and rulings become.
2. **Authority without a single ruler.** Reach and overseer checks today are
   ruled by the editor against its copy (`src/shared/region-reach.ts`). Who
   checks a write when its machine is alone, and what happens to a change
   that another machine, once it hears it, would have refused.
3. **Each kind's conflicts.** Two machines move one task to different
   states; one assigns while another finishes; two edit one artifact body
   (versioned today by `baseVersion`); labels and colours (sets); an
   automation edited on two machines; deletes against edits.
4. **Canvas structure.** Nodes, wires, regions, placements: in or out of the
   first version, and why.
5. **What the operator sees** when a reconcile changed something they saw
   before: never a silent rewrite.
6. **Migration and slices.** How today's single-editor data becomes the new
   model, the order of slices, size and risk, and which of S1 to S5 stand,
   change or stop.
7. **The doctrine edits** in `machines.md`, `state-architecture.md`,
   `security-doctrine.md` and `0.10/07`.

The design comes to product-lead and the operator before any slice lands.
