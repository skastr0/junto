# Vellum Command fresh-mail qualification

This extends the [native submission proof](pty-native-submission-2026-09-14.md)
with fresh task-comment mail on both already-running Devin seats. Both
boards passed individual and multiline-content cases; intake also passed
the identical-content queued-batch case. Replacement-package qualification
remains in progress at this checkpoint.

## Environment and method

The installed production app remained PID `14290`, source `7d2d6cb1`, with
the archive inode and SHA-256 recorded in the earlier proof. The original
192-node, 57-edge factory stayed playing. The existing named sessions remained
warm; the binding below was not newly spawned for this exercise.

Computer Use created task `01M2G74ZY7DJ98J7AC5TCRJJ7G`,
“Fresh mail qualification 2026-09-14”, on the existing intake board. The task
requires every existing board and region rule, the normal downstream path,
and a working task with an idle agent between mail cases. Comments were
submitted through the task UI. No terminal Enter, Escape or Ctrl+C advanced
the agent. Store evidence was read through the running app's canvas control
API; no helper opened the product database.

The intake binding is `01M27TCSRRRBFQHGSBD5RXDN8F`.
Journal offsets refer to `~/.vellum-command/logs/pty-delivery.jsonl`.
Private receipt snapshots and the read-only collection helper are under
`/tmp/vellum-command-fresh-mail-20260914/`.

## Intake receipts

| Case | Physical delivery | Trace result | Work-plane result |
|---|---|---|---|
| Task claim | `80772640-11d0-4a39-a3a9-a7c4140076dd`, rows 533–565 | One 5,435-byte paste, one submit CR, one chip CR; submitted at `15:04:13.739Z` | Live rules read; `MAIL_READY_20260914` recorded; empty composer observed |
| Fresh individual A | `7de58f8a-09c6-4c59-849a-6eed2cffd040`, rows 577–601 | One 142-byte paste and one CR; submitted at `15:10:16.064Z` | Mail `01M2G7G0DGZGC418XQPZ1QXE6W` receipted one millisecond later; one reply containing `amber` |
| Multiline content B | `19133d02`, rows 619–643 | One 142-byte paste and one CR; submitted at `15:14:12.324Z` | Mail `01M2G7Q8KVCYZZHNY0G7SMX5SD` receipted one millisecond later; one reply with `cedar, violet, 47` in order |
| Two identical-content comments C | `18504d85-856e-43e1-a01b-30d5cddce103`, rows 649–672 | One 112-byte batch notice and one CR; submitted at `15:19:30.396Z` | Both distinct mail IDs receipted; one reply for each distinct source comment |

The C source IDs are `01M2G7QP7752NCY460CNQNDGQ4` and
`01M2G7R2Q67DQQTBBHGN9PWY6S`. Their mail-copy IDs are
`01M2G7QP7E8GQ988VMPQVVNX8N` and `01M2G7R2Q84Y0Q8BRGFBS4H7D5`;
their durable delivery timestamps are respectively `15:19:30.405Z` and
`15:19:30.397Z`.

Those comments were appended while B was working. Both remained pending
without interrupts or extra pastes until the next idle boundary. While
handling B, Devin read the task thread and answered both C comments before
their batch notice arrived. That content read alone is not delivery evidence.
The subsequent physical batch and both durable receipts establish delivery.
After the notice, Devin recognized the existing replies and returned idle.
At `15:24Z`, Computer Use showed an empty composer and the app-owned thread
still contained exactly one reply to A, one to B and one per C source ID.

Checkpoint totals: four physical pastes including the claim, four submit CRs,
one chip CR, four submitted verdicts, no recovery CR, no interrupts and no
duplicate physical pastes. The four fresh mail messages used three notices.
The intake completion instruction was then submitted through a normal task
comment, to exercise the existing handoff rather than move the task manually.

## What this proves

The running package can deliver fresh mail after a warm Devin turn completes,
queue multiple comments during work, preserve distinct IDs with identical
content, stamp accepted members, and re-arm without manual terminal input.

Mail uses a compact PTY notice followed by CLI retrieval of full content.
The B case proves multiline message-content preservation and retrieval; it
does not exercise a multiline PTY chip. The claim does exercise a long paste
and bounded chip CR. A chip visible just after CR does not distinguish a
swallowed CR from observer repaint delay.

These native results belong to `7d2d6cb1`. Later source commits repair mail
receipt recovery, supervisor acceptance, generation evidence and Remote
composition; this run does not qualify those uninstalled changes. Crash
reconciliation, the full producer and harness matrix, and Remote execution
retain the limits in the [matrix assessment](pty-matrix-2026-09-14.md).

## Handoff and second warm seat

The intake completion instruction was accepted as delivery
`d0140b76-22c4-4750-a9c0-45d7240c330e` at `15:25:04.999Z`.
Intake completed through normal task rules at `15:30:42.152Z`; its handoff
preserved all four source-comment IDs and their acknowledgment values.
The same task then became working on the existing second board and binding
`01M27TDQYGX75C0ESBPB0SVNKD`.

The downstream claim, `458afbbd-31cd-4789-a916-af668c8dbf45`, submitted at
`15:30:42.317Z` with one paste, one submit CR and one chip CR. Its progress
note and thread acknowledgment carried `MAIL_READY_20260914`. Computer Use
verified the empty welcome composer before the next fresh comment.

| Case | Source comment | Mail copy | Physical acceptance and response |
|---|---|---|---|
| D, fresh individual | `01M2G93T0TMF7Z3YCMA62388HW` | `01M2G93T10JPPTEGTV30ZPEN4V` | `d9ef3226-e2c5-427e-a0ca-8b6b9f0047d7` submitted and receipted at `15:38:33.519Z`; one reply containing `silver` |
| E, multiline while D worked | `01M2G94EXC4K26FBDK46CCPK4H` | `01M2G94EXGZANBG08T8ANNPB5X` | `71c81271-68b0-4bac-bcfb-4ba2b7c7172b` submitted at `15:42:48.447Z`, receipted two milliseconds later; one reply with `maple, copper, 83` |

E remained pending while D worked. As at intake, Devin read the full thread
early and answered E before the later notice; the subsequent notice and
durable receipt independently establish its physical delivery. After that
notice, Computer Use showed the agent recognize the existing answer and
return to an empty composer without replying again.

At the second-seat checkpoint, the app-owned thread contains exactly six
case replies across both boards. All six fresh mail IDs have durable
receipts, transported by five short notices. Including both claims and the
intake completion notice, the trace has eight pastes, eight submit CRs,
two chip CRs and eight submitted verdicts; no recovery CR, interrupts or
duplicate physical pastes. The downstream task remains working intentionally
for a final fresh-mail check after the replacement package resumes its named
session; its final completion instruction has not yet been sent.
