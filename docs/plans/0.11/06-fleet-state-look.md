# Fleet state: how machine states look (F5d)

Owner: remote-design. Builder: remote-window. Reviewer: product-design.
Plan: `06-fleet-state.md`, section 2. Words: `src/shared/authority.ts` owns
every sentence; this page owns only how they look. Nothing here adds a word
the contract does not already say, except the two role words below.

## The five states

One machine, as the banner chip and the Machines window both show it. The
list position comes first, because the order is what decides who rules.

| State | When (`AuthorityMachineView`) | Words | Look |
|---|---|---|---|
| Ruling | `isAuthority`, reachable | `takes changes` | ink text, chip frame `--color-stroke-hi` |
| Fallback | listed, `reachable`, not the authority | `stands by` | dim text, chip frame `--color-stroke` |
| Asleep | `asleep` | `asleep since 01:12` (or `asleep`) | dim text, chip frame `--color-stroke` |
| Unreachable | `unreachable` or `not-linked` | `unreachable`, `not linked` | `--color-amber-fg` text, chip frame amber 50% |
| Read-only | no authority reachable (`authorityReachable` false) | the banner below | banner frame amber 50%, tint amber 10% |

- In the read-only banner a reachable machine reads `reachable but not
  taking changes` (the contract's `noAuthorityLine`), in dim text, never as
  ruling.
- Amber means the operator has something to do, as it already does on the
  shelf (`data-needs-you`). Ruling is not a fault and is not green: it is the
  normal state, so it is the plainest chip, set apart only by its frame.
- `here` is this machine: its chip says its label, never "this machine",
  plus its state. The window already knows which machine it runs on.
- Time: today `01:12`; within the week `Tue 01:12`; older `Oct 27, 01:12`.
  One formatter, passed as `when` to every contract function.

## The banner over the canvas

- Placed top centre of the canvas, under the top bar, at most 680px wide, in
  the place `.error-banner` uses; when both show, the error banner sits
  above it. It is a state, not a message: no close button.
- `kind: "read-only"`: a full 1px border at `color-mix(in oklab,
  var(--color-amber) 50%, transparent)` and a tint at amber 10%, the same
  treatment as the selected machine card (09ca91509). No one-sided edge, no
  shadow stripe, no icon in red. Crimson stays for faults.
- `kind: "waiting"`: a full 1px `--color-stroke` border on `--color-raise`.
  The count line is ink; the apply and discard actions live where the
  operator reviews the kept changes, not here.
- Inside, top to bottom:
  1. The title, `--text-title`, ink, weight 600.
  2. The list as a row of chips in the operator's order, wrapping. A chip
     is a 16px `MachineFigure`, the position (`1`, `2`, `3`) in mono
     `--text-label` dim, the label in ink, then the state words in the
     state's colour from the table. Chips use `--radius-md`, 4px 8px
     padding, 6px gap. The chips replace the contract's joined machine
     sentence on screen; that sentence stays as the row's accessible name.
  3. The other contract lines (`Reads are as of`, `This window is
     read-only`, the kept-change line) in `--text-body`, dim, one per line.
- Nothing moves. The banner appears and leaves with the state, and no part
  of it pulses.
- `role="status"` with `aria-live="polite"`; the title is the label.

## The Machines window

- The same banner, the same component, at the top of the Machines window
  while the canvas has no reachable authority. The operator comes here to
  wake or fix a machine, so the reason must be in front of them.
- Shelf card: under the state line, one more line for a machine on the
  current canvas's list: position and role, `1, takes changes` or `2,
  stands by`, mono `--text-label`, dim; ink for the ruling machine. A
  machine not on the list gets no line. Asleep and unreachable are already
  the card's state line; the role line does not repeat them.
- The state line for an asleep machine reads `Asleep since 01:12` when the
  time is known, through the same formatter.
- Stage: one fact row per canvas the machine is listed for, `Changes for
  factory` with the value `1, takes changes`, `2, stands by`, or the
  machine's state when it is neither. A machine on no list shows no row.
- Everything above is behind `AUTHORITY_ENABLED`. With it off, the shelf
  and the stage are as they are today.

## Who builds what

remote-window builds the banner and its IPC read (F5d). The Machines window
lines read the same view, and remote-design adds them once the read lands,
unless remote-window would rather carry them in the same slice.
