# Machines need you: the badge, the popover and the recovery card

Owner: remote-design. Builder: remote-window. Plan: Slice 1, "You can tell,
and one click fixes it" (approved by remote-lead). Reviewer: product-design.

Three surfaces, one set of severities. Nothing here moves: every dot is
static, and no surface adds a transition the parts it reuses do not already
have. Copy has no middle dots, no mechanics words, and a remote machine is
always called by its label, never "this machine" or "this Mac".

## Severities

| Severity | Which machines | Mark |
|---|---|---|
| Broken | unreachable with seats placed on it, an update that failed or stopped, Boat failed or gone | `--color-crimson-fg` |
| Needs you | needs an update, not set up, installed but not connected, a harness missing for a placed seat, keychain sign-in blocked for a placed seat | `--color-amber-fg` |
| Working | a send, update or wake running, and nothing above | `--color-cyan-fg` |
| Quiet | everything else, sleeping Boat machines included | none |

Broken outranks needs you, which outranks working. The marks use the `-fg`
tokens, not the bare hues, because bright fails on the bare hues (below).

## 1. The badge on the Machines button

The Radar button at `src/window/components/TopBar.tsx:315` keeps its box
(`.station-icon-button`, 34px, `--radius-lg`) and takes its marks the way
`NeedsYouButton` does, so the two read as a pair.

| State | Icon colour | Mark at top right | `aria-label` | `title` |
|---|---|---|---|---|
| Quiet | `--color-steel` | none | `Machines` | `Machines` |
| Working | `--color-steel` | 7px dot, `--color-cyan-fg`, static | `Machines, Junto is being sent` (or `updated`, `woken`; `2 machines are busy` for more) | same |
| Needs you | `--color-amber-fg` | count pill, fill `--color-amber-fg` | `Machines, 2 need you` | same |
| Broken | `--color-crimson-fg` | count pill, fill `--color-crimson-fg` | `Machines, 1 cannot work, 2 need you` | same |

- The count pill is `.operator-feed-trigger__count` as it is: top -5px,
  right -6px, 15px tall, min-width 15px, 0 4px padding, `--radius-pill`,
  mono `--text-label` 600, text `--color-ground`, `99+` past 99. Only the
  fill changes. Share the class rather than copying it.
- The count is every machine that is broken or needs you; the fill is the
  worst of them. Working machines are not counted.
- The working dot sits where the pill's centre would be (top -1px, right
  -1px), 7px, `--radius-pill`, with a 2px ring in `--color-ground` so it
  stays round over the button's border. It is `StatusDot` with `pulse` off;
  a moving dot needs the operator's word.
- `aria-haspopup="dialog"` and `aria-expanded` when the popover can open;
  quiet has neither, since it opens the window.

## 2. The popover

Opens under the button through `Popover`, as the help popover does, when
the badge is not quiet. Quiet opens the Machines window directly.

- `width={360}`. `role="dialog"`, label `Machines`.
- Header: `Eyebrow` `Machines`, 10px 12px padding. No summary line; the
  badge already counts.
- Rows, in order broken, needs you, working, then by label. Sleeping Boat
  machines are never listed. At most six rows show; past six the list
  scrolls inside the popover (max-height 6 rows), header and footer fixed.
- A row is a grid, `7px 1fr auto`, gap 10px, padding 8px 12px, min-height
  48px, items centred, separated by a 1px `--color-overlay-3` line:
  1. The severity dot, `StatusDot`, static, in the row's mark.
  2. Two lines: the label, a link button in `--text-body-lg` 600
     `--color-ink`, one line with an ellipsis, that opens the Machines
     window on that machine; under it the status sentence in `--text-body`
     `--color-dim`, at most two lines, then an ellipsis, with the whole
     sentence in `title`.
  3. One action, `Button size="sm"`:
     - `variant="chrome"` for a fix (`Send Junto`, `Reconnect`, `Update
       Junto`, `Update now`, `Check for updates`, `Try update again`,
       `Reinstall Junto`, `Check again`, `Add machine`).
     - `variant="danger"` for `Delete on Boat` and `Remove`.
     - A working row has no button: its sentence says what runs (`Sending
       Junto, step 2 of 5`).
     Rows use chrome, not primary, so a list of five is not five amber
     buttons; the one primary is `Update all`.
- While a row's action runs, its button shows the pending label (`Updating…`)
  disabled, and the row moves to working when the badge does.
- When the last row leaves, the list is replaced by one line, `Every
  machine is ready.`, `--text-body` dim, 12px padding, and the popover
  stays open until dismissed.
- Footer: 1px `--color-stroke` top line, 8px 12px padding, flex, space
  between. Left: `Open Machines`, `Button variant="subtle" size="sm"`.
  Right: `Update all`, `Button variant="primary" size="sm"`, only when two
  or more idle machines need an update.

## 3. The recovery card in a terminal

Replaces the card at `TerminalSurface.tsx:2638` when a remote seat ended
because of its machine. A seat that ended for any other reason keeps
today's card. Same overlay, same place, same `role="status"`.

- Frame: `.native-terminal-surface__dead-card` with `width: min(100%,
  400px)` (the longest detail is about 140 characters, four lines at 400),
  padding 14px 16px, gap 8px, `--radius-lg`, its raise background and
  shadow. Border by severity: broken keeps today's crimson mix (35%);
  needs you is `--color-amber` 35% with `--color-stroke`; asleep, which is
  not a fault, is `--color-stroke`.
- Parts, top to bottom:
  1. Eyebrow: the machine's label, `Eyebrow` tone `amber` for broken and
     needs you, `steel` for asleep. `Eyebrow` has no crimson tone, and the
     frame already says broken, so none is added.
  2. Headline: `.native-terminal-surface__dead-title` as it is
     (`--text-title`, display, 600, ink). `Mac mini needs an update`.
  3. Detail: one sentence, `.native-terminal-surface__dead-detail` as it is
     (`--text-body`, `--leading-body`, dim). No line from the harness; the
     machine's reason replaces it.
  4. Steps, only while the fix runs in place: `MachineSteps` with a
     compact modifier, `.machine-steps--inline`: no bottom line, padding 0,
     gap 6px, `--text-body`. Its phase marks stay as they are, static.
  5. Actions, flex wrap, gap 8px, margin-top 4px: the fix, `Button
     variant="primary" size="sm"` (`Wake` for asleep); `Open Machines`,
     `variant="chrome" size="sm"`, which opens the window on that machine;
     `Close view`, `variant="chrome" size="sm"`, outside the grid only, as
     today.
- While the fix runs: the headline says what runs (`Updating Junto on Mac
  mini`), the detail stays, the steps show, and the fix button is disabled
  with its pending label. When it is done the seat reopens and the card
  leaves.

Sample at the longest:

    MAC MINI
    Sign-in blocked on Mac mini
    Claude Code uses Mac mini's Mac keychain, which is locked without a
    desktop login. Sign in on Mac mini's screen, then restart Junto there.
    [Check again] [Open Machines] [Close view]

## Contrast

`themeRuntime` and `contrastRatio` from `src/shared/theme`, against 4.5 for
text and 3 for a mark.

| Pair | Dark | Bright |
|---|---|---|
| ground on amber (today's pill) | 9.12 | 3.05, fails |
| ground on crimson (today's pill) | 5.02 | 4.35, fails |
| ground on `amber-fg` | 9.12 | 5.75 |
| ground on `crimson-fg` | 8.03 | 6.05 |
| `cyan-fg` dot on ground | 9.57 | 5.69 |
| `amber-hi` on primary (amber 18% over raise) | 9.62 | 5.85 |
| dim detail on raise | 6.91 | 6.61 |

In dark, `amber-fg` is the same colour as amber, so nothing changes there.
In bright, the bare-hue pill fails, so the badge uses the `-fg` fills.
`NeedsYouButton`'s own pill has the same bright failure today; moving it to
the `-fg` fills is a one-line change outside this slice.
