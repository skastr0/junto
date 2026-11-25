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
| Working | `--color-steel` | 7px dot, `--color-cyan-fg`, static | `Machines, sending Junto to Mac mini` (`updating Junto on Mac mini`, `waking Mac mini`); `Machines, 2 are busy` for more | same |
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
- `aria-haspopup="dialog"` and `aria-expanded` in every state: the button
  always opens the popover (below).

## 2. The popover

Opens under the button through `Popover`, as the help popover does, in
every state, quiet included. One press does one thing whatever the state,
since the state can change under the pointer, and the Needs you button
beside it also always opens the same place. Quiet shows `Every machine is
ready.` and the footer.

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
     sentence in `title`. On a failed command's row, a third line may
     follow: core's reason, see rule 3.
  3. One action, `Button size="sm"`:
     - `variant="chrome"` for a fix (`Send Junto`, `Reconnect`, `Update
       Junto`, `Update now`, `Check for updates`, `Try update again`,
       `Reinstall Junto`, `Check again`, `Add machine`).
     - `variant="danger"` for `Delete on Boat` and `Remove`, in both
       states. They arm first, with the seat Kill's two-press pattern
       (`src/window/lib/terminal-kill-ux.ts`, `KILL_ARM_MS`, TerminalSurface
       `fireKill`). The first press arms, and the label says what the
       second press does: `Delete Mac mini on Boat`, `Remove Mac mini`. It
       disarms on its own after `KILL_ARM_MS`, or when focus leaves the row.
       The second press on `Delete on Boat` fires. The second press on
       `Remove` opens remote-seats' remove dialog, which names the seats
       placed on that machine.
     - A working row has no button: its sentence says what runs (`Sending
       Junto, step 2 of 5`).
     Rows use chrome, not primary, so a list of five is not five amber
     buttons; the one primary is `Update all`.
- While a row's action runs, its button shows the pending label (`Updating…`)
  disabled, and the row moves to working when the badge does.
- With no rows, quiet or after the last one leaves, the list is one line,
  `Every machine is ready.`, `--text-body` dim, 12px padding. The popover
  stays open until dismissed.
- Footer: 1px `--color-stroke` top line, 8px 12px padding, flex, space
  between. Left: `Open Machines`, `Button variant="subtle" size="sm"`.
  Right: `Update all`, `Button variant="primary" size="sm"`, only when two
  or more idle machines need an update.

## 2b. The words on each row

The row's status sentence, for each state. remote-window builds these into
`classifyBarEntry` (`src/window/lib/machines-view.ts`), and
`tests/machines-bar.test.tsx` holds them word for word.

Four rules, then the table:

1. **The label is already on line one, so the sentence never names the
   machine.** It says `there` or `it`, as the recovery card does.
2. **The sentence says what is wrong; the button says the fix.** No
   sentence ends in "Press Update" or "Send Junto to set it up".
3. **No words from the machine or the harness in a row.** A check's
   `read.message`, a peer's `status.detail`, a peer's scrubbed refusal and
   any raw error text are mechanics ("Command failed: tar"). They stay on
   the Machines window card (its `reason(...)` advice), which the label
   opens. The row always shows the fixed sentence below.

   **The one exception: core's own reason, on its own line.** A failed
   command's row (`send-failed`, `update-failed`, `update-stopped`,
   `send-unconfirmed`, `update-unconfirmed`, `sent-not-ready`,
   `updated-not-ready`, `add-failed`) shows a third line under the status
   sentence when, and only when, core marked the refusal's message as its
   own fixed words. Core sets that mark only where the message is a literal
   it wrote: a typed refusal's constant (`bundle must be a directory, not
   a link`), never a `cause.message`, never a `remote-refused` message
   (scrubbed or not), never a string built with a path or a peer's text.
   Without the mark the line is absent; the window never guesses from the
   text's shape, since `Command failed: tar` is one line with no path.
   - It stands alone: no `Why:` or other label. Under a sentence that says
     what failed, the next line reads as the reason.
   - `--text-body`, `--color-dim`, one line with an ellipsis, the whole
     line in its `title`. It does not count against rule 4's two lines.
   - Core's words as they are, first letter raised and a period added when
     missing: `Bundle must be a directory, not a link.`
   - The Machines window card keeps its advice line as it is, so the card
     shows the same words and more.
4. **It fits two lines.** The text column is about 210px at
   `--text-body` 11px, near 36 characters a line, so a sentence with its
   seats clause stays under 64 characters. The whole sentence is the row's
   `title`.

Each row's first sentence is the Machines window headline for that state,
so the popover and the window say the same thing.

| State | Severity | Sentence | Button |
|---|---|---|---|
| `boat-failed` | broken | `Boat says it failed.` | `Delete on Boat`, arms `Delete Mac mini on Boat` |
| `gone` | broken | `No longer on Boat.` | `Remove`, arms `Remove Mac mini` |
| `update-stopped` | broken | `The update failed, and nothing runs there now.` | `Reinstall Junto` |
| `update-failed` | broken | `Junto could not be updated. The old build still runs.` | `Try update again` |
| `update-unconfirmed` | broken | `Could not confirm Junto was updated.` | `Check again` |
| `updated-not-ready` | broken | `Junto was updated, but it is not ready.` | `Check again` |
| `send-failed` | broken | `Junto could not be sent.` | `Send Junto` |
| `send-unconfirmed` | broken | `Could not confirm Junto was sent.` | `Check again` |
| `sent-not-ready` | broken | `Junto is on it, but it is not ready.` | `Check again` |
| `add-failed` | broken | `Could not finish adding it on Boat.` | `Check again` |
| `unreachable`, seats on it | broken | `Cannot be reached.` + seats clause | `Check again` |
| `check-failed`, seats on it | broken | `Could not be checked.` + seats clause | `Check again` |
| `unreachable`, no seats | needs you | `Cannot be reached. Check that it is on.` | `Check again` |
| `check-failed`, no seats | needs you | `Could not be checked.` | `Check again` |
| `needs-update` | needs you | `Runs a different build of Junto.` + seats clause | `Update Junto` |
| `peer-newer` | needs you | `Runs a newer build of Junto. Update this machine to connect.` | `Check for updates` |
| `not-set-up` | needs you | `Junto is not on it yet.` | `Send Junto` |
| `installed-not-linked` | needs you | `Junto is installed there, but not connected.` | `Reconnect` |
| `boat-unfinished` | needs you | `Made on Boat, not added yet.` | `Finish adding` |
| harness or secret missing | needs you | the missing line below | `Check again` |
| keychain sign-in blocked | needs you | `Sign-in is blocked. Sign in at its screen, then restart Junto.` | `Check again` |
| `adding`, no step yet | working | `Making it on Boat` | none |
| `sending`, `updating` | working | `Sending Junto, step 2 of 5` (`Updating Junto, copying 120 of 340 MB`), as today | none |
| `waking` | working | `Waking` | none |

**The seats clause.** Only where the table says so, and only when
`runningSeats` is above zero. It says when the count was read, since a
machine out of reach cannot say what runs there now:

- `Had 3 seats running at 09:12.`
- `Had 1 seat running at 09:12.`
- With no `runningSeatsAt`: `Had 3 seats running.`

It replaces `runningSeatsLine` in the row only (that line names the machine
and puts the time in brackets); the Machines window keeps its own.

**The missing line.** Harnesses by name up to two, past two by count.
Secrets always by count, never by name in a row: their names are on the
Machines window card.

- `Claude Code is missing there.`
- `Claude Code and Codex are missing there.`
- `3 harnesses are missing there.`
- `1 secret is missing there.`, `2 secrets are missing there.`
- `Claude Code and 2 secrets are missing there.`

Longest rows, counted against the 64 limit with a two-digit count:
`needs-update` with its clause (63), the keychain line (62), `peer-newer`
(60). `peer-newer` is the one sentence that names a fix, because the fix
is on this machine, the one the operator sits at (a Mac or Linux), not on
the machine in the row.

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
  1. Eyebrow: the seat's state word as today, `stopped` in amber, `asleep`
     in steel. Not the machine's label.
  2. Headline: `.native-terminal-surface__dead-title` as it is
     (`--text-title`, display, 600, ink). It carries the machine's label,
     once: `Mac mini needs an update`.
  3. Detail: one sentence, `.native-terminal-surface__dead-detail` as it is
     (`--text-body`, `--leading-body`, dim). It does not name the machine
     again; it says `there` or `its screen` where the sentence allows. No
     line from the harness; the machine's reason replaces it.
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

    STOPPED
    Sign-in blocked on Mac mini
    Claude Code uses its Mac keychain, which stays locked until someone
    signs in at its screen. Sign in there, then restart Junto.
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
`NeedsYouButton`'s own pill has the same bright failure today, and its icon
tints bare amber. product-design has sent its owner the move of both, the
pill fills and the icon, to the `-fg` tokens, so the pair matches in
bright.

## 4. Delete anyway: when a seat's machine cannot confirm the stop

The second step of the node delete. The first step is the shared
`ConfirmDialog` from `deleteNodesInternal` (`src/window/lib/mutations.ts`,
514b30e16), unchanged. When `terminalBeginNodeDelete` comes back not ok
with `unstoppedRemote`, the window asks again through the same
`askConfirm`, instead of today's error line ("Junto could not stop the
managed terminal cleanly"). Delete anyway sends the same seats again with
`confirmedUnreachable: true`. Cancel keeps every node and every seat.

A seat on this Mac that fails to stop never gets this step: it keeps
today's error.

**The request.**

| Field | One seat | Several nodes |
|---|---|---|
| `source` | `node-delete` | same |
| `title` | `Delete quasar-lead anyway?` | `Delete 3 nodes anyway?` (the subject of step one) |
| `confirmLabel` | `Delete anyway` | same |
| `cancelLabel` | `Cancel` | same |
| `tone` | `danger` | same |

**The body**, one sentence a line, in this order:

1. For each machine, its reason line (below). The dialog has no label line
   above it, so here the machine and the seat are named.
2. Right after it, what Delete anyway does there:
   `Delete anyway removes it here, and it may keep running on Mac mini.`
   With several seats on that machine: `Delete anyway removes them here,
   and they may keep running on Mac mini.`
3. The open signal line from step one, as it is: `2 open signals close
   with it.` Only when above zero.
4. The connected edges line from step one, as it is.

Line 2 promises no later stop on purpose. Read at 952df5d6d: the seat's
machine finishes a delete only for a stop it received and holds
(`finishHeldSeatDeletes`, `src/core/work/exchange/live.ts:475`). A machine
that was asleep or out of reach never received it, and nothing calls
`sweepOwedMachine` yet, so its seat can keep running after the node is
gone. When that is built and run on two machines, line 2 becomes `Junto
stops it there the next time it reaches Mac mini.`

**The reason line.** The core gives four reasons
(`src/shared/terminal-delete.ts`). Asleep is the window's own: a Boat
machine whose power reads `asleep` or `falling-asleep` says asleep in
place of `unreachable` or `timeout`.

| Reason | Line |
|---|---|
| `epoch-changed` | `quasar-lead restarted on Mac mini while Junto was stopping it.` |
| `refused` | `Mac mini would not stop quasar-lead.` |
| `timeout` | `Mac mini did not answer in time, so Junto could not stop quasar-lead there.` |
| `unreachable` | `Junto cannot reach Mac mini, so it could not stop quasar-lead there.` |
| asleep (Boat) | `Mac mini is asleep, so Junto could not stop quasar-lead there.` |

Several seats on one machine with one reason: three or fewer are all
named (`quasar-lead, quasar-db and quasar-maintenance`); four or more name
two, then the rest by count, which is then always 2 or more, so it never
reads `and 1 more`: `Junto cannot reach Mac mini, so it could not stop
quasar-lead, quasar-db and 2 more there.` Seats on different machines, or
with different reasons, take a pair of lines each, in the table's order,
then by machine label.

**Sample, one seat:**

    Delete quasar-lead anyway?
    Junto cannot reach Mac mini, so it could not stop quasar-lead there.
    Delete anyway removes it here, and it may keep running on Mac mini.
    2 open signals close with it.
                                            [Cancel] [Delete anyway]

Words that stay out: terminal, binding, receipt, proven, managed, lease,
occupant. No middle dots.

## 5. A removed machine's link that outlives it

Two answers from remote-core's remove fix. `<this>` is the machine that ran
`machine remove`; `<removed>` is the machine it removed. `<this>` forgets
`<removed>`'s route and link key, but `<removed>` keeps `<this>`'s link
line until Junto reaches it. Builders fill both from the answer, never
from an example.

Rules: name both machines and never say `this machine`, since everywhere
else in Junto that means the Mac the operator sits at. Say what is still
true and who clears it; no `trusts`.

**Remove, when `<removed>` cannot be reached.** The remove itself
succeeded, so the sentence says so first.

- CLI: `<removed> is removed, but it still accepts <this>'s link key.
  Junto clears it the next time it reaches <removed>.`
- Window: `<removed> is removed. It still lets <this> connect until Junto
  reaches it.`

**A send to a re-added `<removed>` that still accepts the old link from
`<this>`.** The send clears the stale link itself (remote-core's guard
amendment); this replaces the earlier `junto machine link` refusal, and
shows only when that clearing fails.

- Core's words, `ownWords: true`, for the CLI and the row's third line:
  `That machine still accepts an old link from this one, and Junto could
  not clear it. Send Junto again.`
- `still accepts`, not `still works`: this machine holds no key for that
  link; what it knows is setup's `keyBound` answer (remote-security).
- `Send Junto again` is the step: the send is what clears a stale link, so
  sending again tries the clear again. `Check it again` named no step.
- No machine name: the row already shows the label (rule 1), and the CLI
  answer names the machine. `That machine` is the one sent to; `this one`
  is the near machine.

**A send when this machine's link key for that machine exists but
cannot be read.** A resend fails the same way, so the step is not `Send
Junto again`.

- Core's words, `ownWords: true`: `This machine's link key for that
  machine cannot be read. Remove that machine, then add it again and send
  Junto to it.` The clear runs only in a send, so the step names it.
- Not `junto machine link`: this refusal comes from a send whose setup
  failed before the machine was saved, and link then answers `Set up ...
  from this machine before linking it` (remote-verify, receipt 15).
  Remove deletes the key directory without reading it (`removeLinkKey`),
  and the next send, with no key here, clears the stale link itself.
- True only once remote-core's fix lands: today `machine.remove` calls
  `forget`, the one caller of `removeLinkKey`, only when a pin exists
  (`machine-owner.ts:336-338`), and here there is none, so the key stays
  and the next send refuses the same way. The fix: remove deletes the key
  for the host's name whether or not a pin exists, and a failed delete is
  answered in words (remote-security, on 23a7b0735).

**Remove, when Junto cannot confirm `<removed>` stopped accepting the
link.** This machine holds no link key for it, and the far end could not
be asked: it was out of reach, its status did not answer, or the key here
was unreadable. remote-security: the sentence says Junto could not
confirm, never that `<removed>` still accepts the key.

- Core's words, `ownWords: true`, a `linkKept` message beside the one
  above, naming both machines as it does: `<removed> is removed, but Junto
  could not confirm it stopped accepting links from <this>. To clear that,
  add it again and send Junto to it.` Approved by remote-security; true
  once remote-core fixes its MEDIUM on 09a3755af (no key and no saved
  holder answers `clear`).

**Remove, when the link key this machine holds for `<removed>` cannot be
deleted.** A `linkKeyKept` field, `ownWords: true`, as remote-security
asked that a failed delete be answered in words.

- `<removed> is removed, but Junto could not delete the link key <this>
  holds for it. Add <removed> again, then remove it.`
- Not `Remove it again`: the machine is gone, so a second remove answers
  not found. Adding it, then removing it, reaches the delete by name.

**Remove, when the list of removed machines that still accept the key
cannot be read.** Junto sets the file aside and does not overwrite it.

- Core's words, `ownWords: true`: `Junto could not read its list of
  removed machines that still accept <this>'s link key, and set the list
  aside unchanged. Machines on it may still accept the key until you link
  them again or remove them again.`
- No path in that message: rule 3 keeps a path out of core's own words.
  The path travels in its own field, and the CLI prints it on its own line
  after the sentence: `Set aside at <path>`. The window shows the sentence
  only; the path stays in the CLI and the logs.

**A send that finds the machine's name answering as another
installation**, as after a reinstall there. It refuses before changing
anything; the way on is the take-over, whose preview shows the seats and
automations that move (`docs/machines.md`, take-over).

- Core's words, `ownWords: true`, for the CLI and the row's third line:
  `It now answers as a different install of Junto, so nothing changed.
  Preview a take-over with junto machine takeover to see which seats and
  automations move.`
- The step is the CLI command: the window has no take-over button on
  main. When remote-window builds one, the sentence names its label
  instead. `nothing changed` holds on the near side, since the send
  refuses before it changes anything.
- The preview needs the machine name and the new installation id
  (`MachineTakeoverInput`), so the CLI prints the ready preview command on
  its own line after the sentence, built from the refusal's typed fields
  (the name from this machine's list, the id decoded as `InstallationId`),
  as the set-aside path is. Neither is in core's words, and the window
  shows the sentence only.
- remote-security's three conditions (on 209adfb83): print the line only
  when the id decodes as `InstallationId`, else no command at all and
  never a raw or escaped far string; join argv parts with single spaces,
  never through a shell-quoting path; and the preview shows both the
  pinned id and the answering id (`previousInstallationId` and
  `installationId`), since the id is what that machine answers, not what
  this one verified.

**The same, found only after the new build started there** (case B,
remote-verify's receipt 18): no core ran there, so the send installed the
new build, started it, and met a different installation. No sentence
here says `nothing changed`.

- The near side picks the sentence by the disposition the far end gives
  (remote-security, on cli-identity's deb667f07); any other disposition
  gives no words, and the far text stays unmarked.
  - `rolled-back`: `It answers as a different install of Junto, so Junto
    put its old build and data back, but the old build may not be
    running. Preview a take-over with junto machine takeover to see which
    seats and automations move.` Not `nothing changed`: the old service's
    restart is best-effort (`mod.rs:747`), as `start-rolled-back` says.
  - `activated` (a fresh home, no restore point; the stop is always
    confirmed on this path): `The new build is installed there but answers
    as a different install of Junto, so Junto stopped it. Preview a
    take-over with junto machine takeover to see which seats and
    automations move.`
  - `uncertain` (the stop not confirmed; reached only if that branch keeps
    the code and the started id, as remote-security recommends): `The new
    build is installed there but answers as a different install of Junto,
    and it may still be running. Preview a take-over with junto machine
    takeover to see which seats and automations move.`
- Each is followed by the same printed preview line, under the same three
  conditions.

**S6, set up but no link opened in time.** Retryable.

- Core's words, `ownWords: true`: `Junto is set up there, but no link to
  it opened in time. Send Junto again, and if that fails too, check it
  again.`

**S4, the far machine already trusts another installation under this
machine's name**, so it refused to pin this one. Nothing there moves on
its own.

- Core's words, `ownWords: true`: `Junto is installed there, but it
  already trusts a different install of Junto under this machine's name.
  Preview a take-over there with junto machine takeover-remote to see
  which seats and automations move.` S4 is raised only after the install
  receipt (remote-core), so the build is installed and `nothing changed`
  never holds.
- The step: `machine.takeover-remote` starts a take-over on the far
  machine that holds the old pin (`MachineTakeoverRemoteInput`,
  `src/shared/machine-control.ts`), which is this case; `machine takeover`
  is the other way round, a stale pin held here. The CLI prints the ready
  preview command on its own line, with the name from this machine's list,
  under the same conditions as the take-over line above.
- A first send gets the same sentence and the same takeover-remote line
  (remote-verify's receipt 24): it is the common case, after this machine
  is reinstalled, and the sentence reads true there, since the far
  machine trusts this machine's earlier install under its name. The old
  `could not finish setup` advice to choose another name is wrong there
  and goes.

**takeover-remote, refused because the old install is still live there**
(an open link, or heard from within 10 minutes; remote-security R3).

- `That machine refused the take-over, because another Junto using this
  machine's name is still live there. If that one is gone for good, try
  again once it has been quiet for 10 minutes. If it is not, remove it on
  that machine with junto machine remove <this>.`
- No `nothing changed`: the refusal is that machine's word, not something
  this one established. Two steps, since a live twin and a just-reinstalled
  machine look the same from here: waiting fits the reinstall, removing
  fits a twin. There is no Junto command to rename this machine, so the
  sentence does not offer one.

**takeover-remote, confirmed** (R6).

- `That machine now trusts this one. Send Junto to it again to finish
  setting it up.`

**The take-over preview's last-heard line.**

- Today: `It last heard from the old install at 09:12.`
- Another day: `It last heard from the old install on 24 November.`
- Never: `It has never heard from the old install.`

**The send's own `pinned` step.** It shows, on a send only, as a sixth
step after `Junto answers`, so a refused pin shows where it stopped
instead of five done steps beside a failure. An update never pins and
keeps its five; a send counts `step N of 6`.

- Upcoming `Trust this machine`, done `Trusts this machine`, the verb S4
  uses.

## 6. The far install's refusal codes

When a send or update fails on the far machine, its refusal carries one
closed code (`MachineInstallCheck`), and the near side maps the code to the
sentence below with `ownWords: true`. It shows as the failed row's third
line (rule 3) and as the Machines window card's advice. The far text goes
to logs only.

Rules, from remote-security's term 5 and this doc:

- No path, no host name, no far text. The far machine is `it` or `there`,
  as rule 1 says, never a name and never `this machine`, which means the
  operator's own machine, a Mac or Linux.
- Never an instruction to delete, edit or move a file by hand.
- Each ends in one next step, a Junto action: `Send Junto again`, `Check it
  again` (the row's `Check again`, `junto machine status` in the CLI), or
  `Remove it`.
- The row's status sentence already says what failed, so these say why.

| Code | Sentence |
|---|---|
| `bundle-not-directory` | `What arrived there was not a Junto package. Send Junto again.` |
| `bundle-special-file` | `The package from this machine holds a link or a special file. Update Junto on this machine, then send again.` |
| `bundle-manifest-invalid` | `The package from this machine has a list of files that cannot be read. Update Junto on this machine, then send again.` |
| `bundle-writable-by-others` | `The package from this machine has files others can change. Update Junto on this machine, then send again.` |
| `bundle-mismatch` | `The files that arrived did not match the package. Send Junto again.` |
| `install-folder-not-ours` | `Its install folder belongs to another Junto. Remove it, then add it again with another install folder.` |
| `send-in-progress` | `Junto is already being sent there. Send again when that send ends.` |
| `install-lease-unavailable` | `Junto could not take the install lock there. Check it again.` |
| `machine-path-unsafe` | `A Junto folder there is outside its home or not private. Check it again.` |
| `service-not-ours` | `The Junto service there belongs to another install. Check it again.` |
| `service-platform-unsupported` | `Junto runs on macOS and Linux machines only. Remove it from your machines.` |
| `service-not-quiescent` | `The old Junto there did not stop. Check it, then send Junto again.` |
| `core-mismatch` | `The Junto running there is not the one just installed. Check it again.` |
| `database-copy-failed` | `Junto could not keep a copy of its data there, so nothing changed. Check it again.` |
| `database-not-private` | `Its Junto data is not private to its account, so nothing changed. Check it again.` |
| `restore-owed` | `Its data still waits for a restore, which finishes when Junto starts there. Check it again.` |
| `restore-interrupted` | `An earlier restore of its data did not finish. Check it again before you send Junto.` |
| `start-failed` | `Junto did not start there, and it is not confirmed stopped. Check it again before you send.` |
| `start-rolled-back` | `The new build did not start there. The old build and its data are back, but it may not be running. Check it again before you update.` |
| `installed-not-started` | `The new build is installed there but did not start, and nothing runs there now. Update Junto on this machine, then send again.` |
| `start-and-restore-failed` | `The new build did not start, and its data was not restored. Check it again.` |
| `home-lock-refused` | `Its Junto home is held by another Junto or another account. Check it again.` |
| `status-unreadable` | `Junto there did not report its status. Check it again.` |
| `boat-key-not-placed` | `Its machine key could not be written there. Check it again.` |
| `seats-did-not-stop` | `A seat there did not stop when asked. Check it again before you update.` |
| `running-seats-unreported` | `Junto there did not say how many seats it runs. Check it again before you update.` |
| `restore-finish-blocked` | `Junto could not finish restoring its data there. Its data is kept. Send Junto again.` |

**An outcome only the near side knows.** The code comes from the far
machine, so a sentence never claims an outcome the near side did not
establish. `, so nothing changed` in `database-copy-failed` and
`database-not-private` shows only when the near disposition is `staged` or
`rolled-back`; otherwise the clause is dropped and the rest stays:
`Junto could not keep a copy of its data there. Check it again.` and `Its
Junto data is not private to its account. Check it again.` (remote-security,
on 811334d0a). `start-failed` says `it is not confirmed stopped`; if a site
raises it after a clean rollback, that site gets its own code rather than
these words.

**Which fix a bundle code gets.** A send packs a fresh archive, but from
the same package folder on this machine (`send.ts:83`). So only
`bundle-not-directory` and `bundle-mismatch`, transfer faults, say `Send
Junto again`. The other three are defects of the package here, and only a
new package fixes them: `Update Junto on this machine`, as `peer-newer` names
its fix on this machine. `this machine` is the near machine, the one the operator
sits at, which may be a Mac or Linux; it names no host, so term 5 holds
without a name from the core. `install-folder-not-ours` points to `machine add` with its
`installRoot` (`machine-control.ts:161`); the window's add form has no
install folder field today, so in the window this step runs from the CLI.

`start-rolled-back` claims the old build is back only on the `rolled-back`
disposition it comes with, and never that the old build runs, since its restart is best-effort (`mod.rs:747`); `start-failed` is only the uncertain site
(`mod.rs:714`). `installed-not-started` claims it is installed and that
nothing runs there only on the `activated` disposition its site sets
(`mod.rs:761`); on any other it reads `The new build did not start there.
Update Junto on this machine, then send again.` (remote-security, on
7eeab8b04).

`restore-finish-blocked` says `Send Junto again` (the window's `Send
Junto`, `junto machine send` in the CLI), never `Reinstall`: on a machine
owing a restore, reinstall reads as uninstall first, which would lose the
data being restored. remote-security confirmed sending is the safe path:
a new install finishes the owed restore under the home lock before it
copies anything (`mod.rs` `lock_for_copy`), so the sentence may say the
data is kept.

Changed from remote-core's draft: no machine name (term 5); `Check this
machine` is `Check it again`, since `this machine` is the operator's Mac;
`Rebuild` is `Update Junto on this machine`, the Junto action that makes a new
package; `Start the installed Junto on it` is gone, because it
is not a Junto action; `database` is `data`.
