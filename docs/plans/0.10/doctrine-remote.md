# Remote doctrine rewrite, drafts

Owner: remote-design. Reviewer: remote-security. Status: drafts, none landed.

The text that replaces remote's half of "Doctrine this plan changes"
(README). Each change lands in `docs/machines.md` or
`docs/security-doctrine.md` in the same commit as the code that makes it
true, never before (`docs/security-doctrine.md:6`). Each is named by the
commit that triggers it. This file is deleted when the last one lands.

| Change | Lands with | Files |
|---|---|---|
| D1 Copy carries every non-host node except notes | R3 copy cut (`src/shared/canvas-copy.ts`) | machines rule 2; security "What crosses machines" |
| D2 Exchange admits commands, rulings and resource facts | R2 exchange filter opening (`src/shared/work-exchange.ts:54,72`) | machines rule 4; security "Immutable work" |
| D3 Entitlement for resource facts, commands to the editor only | R2 `entitledTo` (`work-exchange.ts:273-284`) | machines rule 5; security relay paragraph |
| D4 Replication is not access | First resource fact replicated with each core's reach check on reads (R2 with C1) | security "What crosses machines" |
| D5 "Not carried" rewritten | D1 landed, and the deletions it names (C2, product-shell) | machines "Not carried" |
| D6 Signal attachments as refs | The exchange admitting attachment refs (`work-exchange.ts:133-137`) | machines "Later" |
| D7 Browser control by a seat elsewhere removed | R4 browser out of Junto Remote | machines "Later"; security browser line |

Not remote's: rule 6's "a wire admits mail and nothing else" and
security-doctrine 84-89 change with region reach (01, canvas C1).

## D1 Rule 2, the copy

`docs/machines.md:51-52`. Replace

> Notes, labels, files, links and every kind that is off stay on the
> editing machine.

with

> Every node that needs no host's runtime goes to every machine: tasks,
> artifacts, automations, labels, files, links and region outlines. The
> copy carries its geometry and label; its body travels as facts or content
> refs, never in the copy, so the copy stays one frame. Notes and every kind
> that is off stay on the editing machine. A browser page goes elsewhere as
> a stub shaped like a peer: id, geometry, label and machine, with no host
> fields.

`docs/security-doctrine.md:124-127`. Replace the bullet

> The editing machine keeps the complete canvas and its work. Other machines
> receive only work they are entitled to, including mail for their seats and
> the receipts or answers relevant to their seats' work.
> Notes, labels, files and links stay on the editing machine.

with

> The editing machine keeps the complete canvas and its work. Every other
> machine on the canvas receives every resource: tasks, artifacts,
> automations, labels, files and links, as geometry and label in the copy
> and as the editing machine's facts. Mail goes only to machines with its
> seats, with the receipts and answers relevant to their work. Notes stay on
> the editing machine. A browser page goes elsewhere only as a stub.

## D2 Rule 4, the exchange

`docs/machines.md:71-72`. Replace

> Only mail, receipts, signals and session facts are exchanged; the
> exchange has its own closed list and admits nothing else.

with

> The exchange has its own closed list and admits nothing else: mail,
> receipts, signals, session facts, `command.queued` rows, the rulings
> `ruling.applied` and `ruling.refused`, and the resource fact families
> `task.*`, `artifact.*`, `thread.*` and `automation.*`. A seat changes a
> resource by proposing: its machine writes a `command.queued` row, admitted
> only from the machine placement says the actor was on when the row was
> written. Only the machine that edits the canvas rules. It writes each
> ruling and its facts in one transaction, every fact carrying its opId,
> keyed by the sending installation and the opId; a repeated opId gets the
> first ruling and writes nothing. A ruling or resource fact from any other
> writer closes the link. Resource facts may name a predecessor. That is
> safe because rows go per writer in seq order and every machine is
> entitled to all of them. The editing machine stays the one writer of
> resource state, so there is still nothing to merge: first ruled wins.

`docs/security-doctrine.md:239-241`. Replace

> Only the closed exchange operations for mail, receipts, signals and seat
> sessions are admitted.

with

> Only the closed exchange operations are admitted: mail, receipts, signals,
> seat sessions, command rows, rulings and the resource fact families.

`docs/security-doctrine.md:245-247`. After "A machine writes for its own
seats." insert

> A command row is valid only from the machine placement says its actor was
> on when it was written; an `operator` command only from the editing
> machine itself. Rulings and resource facts come only from the editing
> machine.

## D3 Rule 5, entitlement

`docs/machines.md:76-77`. Replace

> Every machine on a canvas gets the canvas rows. A machine gets the mail
> addressed to its seats.

with

> Every machine on a canvas gets the canvas rows, and every ruling and
> resource fact for that canvas. A machine gets the mail addressed to its
> seats. A `command.queued` row goes to the editing machine only and is
> never passed on, so a pending command is seen only on the machine that
> wrote it.

`docs/security-doctrine.md:250`. After "A machine may relay other writers'
rows only for canvases it keeps in full." insert

> It never relays a command row: those go from their writer to the editing
> machine and nowhere else.

## D4 Replication is not access

`docs/security-doctrine.md`, a new paragraph after the "What crosses
machines" list:

> **Replication is not access.** Every machine holds every resource of the
> canvas, so holding a row grants nothing. Each core checks region reach on
> its own reads, against its own copy, and the editing machine checks it
> again at ruling. A seat sees and changes only resources in its reach, on
> any machine.

`docs/machines.md` rule 5 gains the closing sentence

> Entitlement is not access: each core checks reach on its own reads.

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

> A signal's attachments cross as content refs; the bytes move on demand
> through content transfer, checked against the ref's digest, to a machine
> entitled to the signal.

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
