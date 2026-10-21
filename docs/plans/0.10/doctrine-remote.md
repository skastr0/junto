# Remote doctrine rewrite, drafts

Owner: remote-design. Reviewer: remote-security. Status: drafts, reviewed
by remote-security and approved by remote-lead; none landed.

The text that replaces remote's half of "Doctrine this plan changes"
(README). Each change lands in `docs/machines.md` or
`docs/security-doctrine.md` in the same commit as the code that makes it
true, never before (`docs/security-doctrine.md:6`). Each is named by the
commit that triggers it. This file is deleted when the last one lands.

| Change | Lands with | Files |
|---|---|---|
| D1 Copy carries every non-host node except notes (landed `77f7a7134`, remote-cut) | R3 copy cut (`src/shared/canvas-copy.ts`) | machines rule 2; security "What crosses machines" |
| D2 Exchange admits commands, rulings and resource facts (commands and rulings landed with `95ed7b998`) | R2 exchange filter opening (`src/shared/work-exchange.ts:54,72`) | machines rule 4; security "Immutable work" |
| D3 Entitlement for resource facts, commands to the editor only (commands and rulings landed with `95ed7b998`) | R2 `entitledTo` (`work-exchange.ts:273-284`) | machines rule 5; security relay paragraph |
| D4 Replication is not access | First resource fact replicated with each core's reach check on reads (R2 with C1) | security "What crosses machines" |
| D5 "Not carried" rewritten | D1 landed, and the deletions it names (C2, product-shell) | machines "Not carried" |
| D6 Signal attachments as refs | The exchange admitting attachment refs (`work-exchange.ts:133-137`) | machines "Later" |
| D7 Browser control by a seat elsewhere removed | R4 browser out of Junto Remote | machines "Later"; security browser line |

Not remote's: rule 6's "a wire admits mail and nothing else" and
security-doctrine 84-89 change with region reach (01, canvas C1).

## D1 Rule 2, the copy

Landed by remote-cut in `77f7a7134` with its own wording (R3). Differences
from this draft go to remote-lead by mail, not as edits here.

## D2 Rule 4, the exchange

Landed with `95ed7b998`: the closed list gains `command.queued`,
`ruling.applied` and `ruling.refused`; a command row is for its canvas and at
most 64 KiB; rulings keyed by writer and opId. Writer rules landed with
`41db5ad26` (a seat's command judged where its seat was) and `3ee4ad729`
(rulings, operator and automation commands only from the editing machine).
Every-row cap and byte paging landed with `a194abcc2` and `1dd8fdddd`.
Design change `387564472`: resource facts ride inside `ruling.applied`, so
rows still stand alone and no predecessor crosses; the rule 4 sentence for
it lands when the code carries facts in the ruling (today it carries fact
seqs). Still held: that sentence, seat occupancy, and the queue bound with
`queue_full`.

`docs/machines.md:71-72`. Replace

> Only mail, receipts, signals and session facts are exchanged; the
> exchange has its own closed list and admits nothing else.

with

> The exchange has its own closed list and admits nothing else: mail,
> receipts, signals, session facts, seat occupancy facts, `command.queued`
> rows, the rulings `ruling.applied` and `ruling.refused`, and the resource
> fact families `task.*`, `artifact.*`, `thread.*` and `automation.*`.
> Seat occupancy facts are valid only from the machine that seat is on, as
> receipts are. A seat changes a resource by proposing: its machine writes
> a `command.queued` row, valid only from the machine placement says the
> actor was on when the row was written. Only the machine that edits the
> canvas rules. It writes each ruling and its facts in one transaction,
> every fact carrying its opId, keyed by the sending installation and the
> opId; a repeated opId gets the first ruling and writes nothing. A ruling
> or resource fact from any other writer closes the link. A resource fact
> may name a predecessor, and only an earlier fact of its own writer, the
> editing machine; that is safe because rows go per writer in seq order.
> Mail, receipts, signals and command rows still stand alone. The editing
> machine stays the one writer of resource state, so there is still nothing
> to merge: first ruled wins. Every buffer here is bounded: every row a
> machine writes is at most 64 KiB, checked where it mints the row, and
> anything larger travels as a content ref; a received row is at most
> 256 KiB; unruled command
> rows per machine and canvas are at most 50,000 rows and 256 MiB, and a
> command past that is refused at once on the writing machine as
> `queue_full`, the only write refusal that comes from the editing machine
> being away.

Checked against the contract at cc270e4a8 (`src/shared/resource-command.ts`):
actor kinds seat, operator and automation (`writtenOn`, 50-59), the ruling
shape (181-183), `queue_full` (114, 134) and the bounds (290-294).
The row bound is `WORK_ROW_MAX_BYTES` in `src/shared/exchange-bounds.ts`,
enforced at `commitLocalFact` (remote-send, hash to cite when it lands);
the received bound is `WORK_PROTOCOL_MAX_RECORD_BYTES`
(`src/shared/work-protocol.ts:46`).

The family name for seat occupancy facts is pty's (P5); it is filled in
when pty names it. Mail from the operator or an automation is R6's
sentence, landed by remote-security with that code, not here.

`docs/security-doctrine.md:239-241`. Replace

> Only the closed exchange operations for mail, receipts, signals and seat
> sessions are admitted.

with

> Only the closed exchange operations are admitted: mail, receipts, signals,
> seat sessions, seat occupancy, command rows, rulings and the resource
> fact families. Only a resource fact may name a predecessor, and only an
> earlier fact of the same writer.

`docs/security-doctrine.md`, "Immutable work". After R6's sentence "A mail
author is one of a closed set of kinds (seat, operator, automation), each
admitted from one machine; an identity on a node that is not its own is no
author." (`a530ccc85`) insert

> A command's actor is judged the same way: a seat's command row is valid
> only from the machine placement says that seat was on when it was
> written, and an operator's or an automation's command is written on the
> editing machine and taken from no peer. Rulings and resource facts come
> only from the editing machine, which takes them from no peer. A seat
> occupancy fact is valid only from the seat's own machine.

`docs/machines.md` rule 4, after R6's "mail from the operator or an
automation, and an answer to a signal, only from the machine that edits the
canvas", the same three writers in one sentence: a seat's command from its
machine, an operator's or automation's command, a ruling and a resource fact
only from the machine that edits the canvas.

## D3 Rule 5, entitlement

Landed with `95ed7b998`: rulings to every machine, a command to the editing
machine only and never relayed. Ruling shape landed with `3ee4ad729`: a
refusal carries only the closed `RefusalReason`, an optional head and the
root. Still held: resource facts for every machine, and the refused body
ref served only to the writer.

`docs/machines.md:76-77`. Replace

> Every machine on a canvas gets the canvas rows. A machine gets the mail
> addressed to its seats.

with

> Every machine on a canvas gets the canvas rows, and every ruling and
> resource fact for that canvas. A machine gets the mail addressed to its
> seats. A `command.queued` row goes to the editing machine only and is
> never passed on, so a pending command is seen only on the machine that
> wrote it. A ruling carries the writer, the opId, and the facts it applied
> or the typed error with its root opId, and never the command's op or body, so a refused command
> reaches no other machine through its refusal. A refused body kept as a
> content ref is named only in what the writing machine reads, and content
> transfer serves it only to that machine.

`docs/security-doctrine.md:250`. After "A machine may relay other writers'
rows only for canvases it keeps in full." insert

> It never relays a command row: those go from their writer to the editing
> machine and nowhere else. A ruling never carries a command's op or body.

## D4 Replication is not access

`docs/security-doctrine.md`, a new paragraph after the "What crosses
machines" list:

> **Replication is not access.** Every machine holds every resource of the
> canvas. Reach binds seats through Junto: each core checks region reach on
> its own reads, against its own copy, and the editing machine checks it
> again at ruling, so a seat sees and changes only resources in its reach,
> on any machine. Reach does not bind the account that owns a machine's
> files. A resource in a region with no seat on that machine still sits on
> its disk, readable by that account (Trust and its limits).

`docs/machines.md` rule 5 gains the closing sentence

> Entitlement is not access: each core checks reach on its own seats'
> reads, and every resource still sits on every machine's disk.

## D5 "Not carried"

`docs/machines.md:368-372`. Replace the section with

> ## Carried and not carried
>
> Tasks, artifacts, automations, labels, files and links are universal:
> every machine holds them and a seat on any machine reads and writes those
> in its reach with the same commands and the same result (rules 2, 4, 5).
> Notes are not carried. Browser pages are local: a page lives on the
> machine that edits the canvas, which must have a window, and only seats on
> that machine drive it. Board, requests, pad, sheet, cron and relay are
> deleted.

The last sentence lands only when every kind it names is deleted; until
then it names the ones still off.

## D6 Signal attachments

`docs/machines.md:376-377`. Delete the "Later" item

> A signal's file attachments. Its words and detail cross to the editing
> machine; attached files stay on the machine that raised it.

and in rule 4, after the exchange list, add

> A signal's attachments cross as content refs in the signals frame, at
> most 10 per signal. The bytes move on demand through content transfer,
> checked against the ref's digest, to a machine entitled to the signal.
> The receiving machine judges each attachment's media type and name again
> from the bytes it fetched (`attachmentMediaType`, `attachmentName`), as it
> does for a local attachment; a ref's stated type and name are never
> trusted.

The cap of 10 matches the operator and companion attachment caps
(`src/shared/operator-attachments.ts:20`). Signal attachments carry no cap
today (`src/shared/wire/agent-signals.ts:192`); the code that lands D6 adds it.

## D7 Browser control from another machine

`docs/machines.md:378-380`. Delete the "Later" item

> Browser control by a seat. Its socket admission was cut when the peer
> process read was removed and answers "not available in this build"; it
> comes back on the generation credential when the browser is enabled.

It is not deferred any more: D5 says pages are driven only on their own
machine.

`docs/security-doctrine.md:293`. Replace

> The machines feature carries no browser control or browser credentials.

with

> The machines feature carries no browser control or browser credentials;
> a page is driven only by seats on its own machine, and a machine without
> a window has no pages.
