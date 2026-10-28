# Junto security doctrine

Junto is one operator's workspace across machines. The build contract is
[machines.md](machines.md); this document states the trust boundaries for that
same design. These are requirements for the product, not a claim that every
implementation has passed an audit. Change both documents when a boundary
changes.

## Trust and its limits

Junto shares the authority of the OS account it runs in. A seat with an
unrestricted shell can reach that account's files, credentials and other
local mechanisms outside Junto. Owner-only sockets and files exclude other
users; they do not isolate processes belonging to their owner. Seat credentials
attribute Junto calls, and edges limit those calls. The CLI refuses owner and
machine commands from a seat environment to prevent confused use. These checks
are not a sandbox or proof that a human made a request. A seat's credential
is in its environment, and any process of the same account can read another
process's environment through the process table (`ps eww`, or the
`KERN_PROCARGS2` sysctl). So any seat can take another seat's credential and
act as that seat on every socket, an overseer's canvas writes included, just
as it can edit `~/.junto` directly. Seat identity is attribution between
cooperating agents on one account, not a boundary between them.

The operator, chosen accounts and attached agents are trusted participants.
Agents are fallible: hostile pages, repositories, messages and tool output can
influence them. Those inputs never become authority merely because an agent
read them. Junto checks its own operations; containing an agent's unrestricted
shell requires isolation outside Junto, such as a separate OS account or VM.

Real boundaries include other OS users, web content entering the native app,
a machine sending data to another machine, and downloaded executable bytes.
A compromised machine can read everything stored there, use its local secrets,
impersonate its seats, and lie about their activity. A compromised editing
machine controls the intent of its canvases. A machine holding ordinary SSH
access can also exercise that access outside Junto. No application protocol
removes those powers.

Junto is not a multi-tenant service and does not isolate mutually hostile
agents running under the same account. It must neither advertise that claim
nor use its absence to excuse missing checks on Junto-owned APIs.

## Authority inside Junto

Each canvas names one editing installation. Only that installation commits
canvas changes. Other machines keep a read-only copy. Local execution facts,
including the harness session pin, belong in the seat's own state, not in
that copy. A seat belongs to one machine, which starts its occupant, mints
its generation credential, owns its terminal and stores its work. Names and
installation ids identify resources; knowing one is not permission to use it.

The core is the sole normal opener of its product database, `junto.db`, and
its install-local bookkeeping database. The window, CLIs, relays, installers
and callers use core services. This is an ownership rule for Junto code, not
a filesystem sandbox against the account that owns the files.

| Caller | Admission and allowed authority |
|---|---|
| Ordinary seat | A live generation credential resolves to its seat. The local copy's edges grant operations on connected targets; caller-supplied ids cannot replace that principal. |
| Owner command | An owner-only control socket, mode 0600 in a 0700 directory, admits the OS account. The CLI refuses owner and machine commands whenever `JUNTO_WORK_TOKEN` is present, including an empty or malformed value. Closed commands invoke the same services as the window. |
| App window | The committed trusted renderer identity and origin, validated before privileged IPC dispatch. Arbitrary pages do not receive its bridge. |
| Overseer seat | A live human-granted overseer flag and a closed operation set, attributed to the real seat. It does not become the operator. |
| Another machine | The bound link peer plus authorization for the particular canvas, channel, operation and resource. A successful hello grants no general execution authority. |
| Paired phone | Its restricted companion transport and live device registry, limited to the companion operations. It is not a machine link or a general operator-command relay. |

Settings the operator writes apply as written on the machine they name,
including a seat's permission mode, its launch arguments and native harness
settings. The operator's decision, 17 October.

The window calls the same closed owner commands for machine operations. It
adds no authority of its own and cannot bypass their validation or admission.

Main mints one credential per occupant generation and injects it as
`JUNTO_WORK_TOKEN` at spawn. The CLI reads it itself. Work and native
overseer calls resolve that credential through the same live registry before
checking their own allowed operations. A seat's descendants holding its
credential are that seat, including for the native overseer protocol. The
credential survives named session resume within its generation and is revoked
when the generation ends. Calls before publication or with a missing,
unknown, suspended or revoked credential fail closed. Missing environment
forwarding receives a clear diagnosis, never a credential-file or process
inspection fallback. Credentials are not command arguments or log content.

The CLI's owner-command refusal is a guard against accidental use, not server
authentication. A same-account process can omit the variable or speak directly
to the owner socket and exercise the account's authority. Neither the absence
of the variable nor access to that socket proves a human is calling. The link
socket has the same account boundary and additionally requires its pinned hello.

A seat uses a resource node (a Tasks or Artifacts node) by region reach: the
node is in the seat's own region, a region inside it or a region around it,
never a sibling's (`src/shared/region-reach.ts`). Reach needs no edge and is
worked out from the rectangles on every admission. It skips the machine
comparison below, because a resource write travels to the editing machine,
which rules it. Region is still geography, not a security domain: reach scopes
what a seat uses by default and isolates nobody.

Ordinary edge-scoped calls compare the caller's and target's machine names.
On the same machine, the existing edge, role and port checks apply. Across
machines, only `msg.send` may pass those checks; every other port is refused
with `other_machine`. A seat's own mail to another seat requires a `messages`
edge. Mail that Junto sends on a seat's behalf because of reach (a mention, a
stamp request, an assignment or automation notice) needs none, so two seats
always reach each other through a shared ancestor resource, the canvas root at
least. The editing machine and the end that opened the link have no special
reach under this rule. A copied `peer` row can be a mail target, never an
admitted caller.

Ordinary agents never write the canonical canvas through their work API.
Own-seat onboarding, references, session notes and signals are narrow local
facilities; they grant no reach to another seat. Signals may be raised without
an edge. Only the operator answers or dismisses them through the editing
machine.

Only a human grants or revokes overseer authority. Copied aliases do not inherit
the grant. An overseer cannot grant it to another seat, remove its own seat,
move the operator's viewport, or acquire machine enrollment or credentials.
Every closed administrative request rechecks the live grant. Timeout after a
mutation may mean it completed; Junto never automatically replays the mutation.

The agent-run exercise uses disposable cores and homes. Its external controller
can use their owner commands from an environment without a seat credential;
their managed seats' CLI calls to owner and machine commands remain refused.
The exercise does not need a bypass of the operator's running Junto.

## What crosses machines

The editing machine sends one atomic canvas snapshot selected for its
destination, with one monotonically advancing canvas count. Every participant
gets the structure needed to resolve seats, machines, regions and edges, plus
play or pause. Private content follows the seats that need it:

- Seat soul, instructions and launch settings go only to that seat's machine.
  Other machines receive a `peer` row: node id, geometry, label, machine and
  seat id. It can be addressed, never started or admitted as a caller. It has
  no harness, binding, launch, guidance or placeholder values.
- Region briefing, references, folders and environment sources go only where
  a local seat is in that region, including its containing regions. Sources
  restricted to a machine remain restricted to it.
- App briefing and app-wide references go to every machine with a seat: those
  texts are already available to every seat.
- The editing machine keeps the complete canvas and its work. Every other
  machine on the canvas receives every resource: tasks, artifacts, labels,
  files and links, as geometry and label in the copy, never a body, path,
  address or contract. Other machines receive only work they are entitled
  to, including mail for their seats and the receipts or answers relevant to
  their seats' work. Notes stay on the editing machine. A browser page goes
  elsewhere only as a stub, with nothing to drive and no wire to it.
- Each live automation's place (its Automations node, its id and the machine
  that runs it) goes to every machine holding the canvas, so the ruling
  machine can judge an automation's rows by the copy it sent. A machine with
  an automation and no seat holds the canvas, and receives nothing that
  follows seats.

Copy selection must enumerate fields and tables. Adding a field does not
silently make it public. A field crosses only because a rule above names
it, never because it has a canvas row. A guidance, reference, briefing or placement
change must advance the count used for replacement. Equality is for the same
canvas, count and destination; different destinations may receive different
bytes. A replacement removes private fields that are no longer selected.

Removing access cannot claw back bytes a machine already received. A canvas
copy contains authored text; a password pasted into a note, reference, command
argument or inline environment value is ordinary text subject to that copy's
selection. Junto's no-secret-transfer promise covers resolved secret values,
not detection of secrets hidden in arbitrary prose.

## Links

The first version uses the operator's chosen OpenSSH routes. Only the editing
machine opens links. During explicit first setup, the opening end creates its
pin only from the checked hello on the selected route, never from an install
receipt or status. Before that hello, the receiving end stores the expected
opener's identity through the owner's setup command over that SSH account.
It admits no channel until a hello matches the pin exactly. That pin records
who may link even if no hello arrives. A hello cannot enroll itself or select
an existing peer. Changed ids or names are refused.

Each identity fact has one source: this machine's name in
`machine_configuration`, and peer name-to-installation bindings in
`machine_peers`. The machine list holds routes and presentation only; changing
or recreating a route cannot create or replace a peer binding.

A machine may change its own name only before any peer has ever been pinned,
including a retired peer, and while no canvas has advanced beyond its first
count (`seq = 0`). Check both conditions in the rename transaction. The canvas
count covers every kind of authored reference, including folder maps and
environment restrictions. A fresh, empty seed permits naming. Migrated
authored canvases retain their advanced counts. A pinned peer's name and
installation id never change at either end.
Retirement retains that binding: a different installation under the retired
name is refused. Rename and replacement under a used name require a later
explicit design.

Bindings from the retired Station protocol are discarded, not imported as
pins for this protocol. Existing installation identities needed by durable
rows are preserved; membership in `known_installations` grants no link
authority. Every first pin requires explicit owner setup in the order above.
Migration and discovery cannot authorize setup. Update and ordinary reconnect
never create or revive a pin.

SSH authenticates a host and an account. The incoming installation id is an
assertion authorized by that account, not cryptographic proof of a particular
installation. The local relay only transports bytes; it does not independently
authenticate the originating installation. Junto adds no signing or SSH key
system for this first version.
Before another machine may open links, the authentication model is reviewed;
a link-only key with a forced command bound to its opener is the candidate.

The link has SSH agent, X11 and port forwarding disabled. Junto does not
silently weaken host-key checking, discover and use routes, copy private keys,
or grant another machine reusable SSH access. Existing account-level access
remains the operator's responsibility.

Hello must finish before data channels open. Both builds must match exactly;
build equality is compatibility, not authenticity. Unknown channels, malformed
frames and unauthorized operations close the link. A valid announcement about
a canvas the peer does not participate in is ignored before storage or status;
it grants nothing and need not close the link. An unauthorized rows frame
still closes it. Bound frame size, buffered bytes, clients, outstanding
requests and transfer size; terminal output and reconnects must not exhaust
the core or block its local work indefinitely.

A windowed channel is bounded by credit. The receiver credits only bytes it
read and finished handling. Credit for bytes never sent, or for a channel
without a window, closes the link, and so do events past the window. A sender
waits for credit before its write queue, so one channel's backlog never stands
in front of another's request. Waiting is bounded in bytes and in time: past
either bound the send is refused, typed, or the link closes, never hangs. An
event handler that would wait is refused.

The transport is symmetric. Authority depends on the bound peer and the
canvas, never on which end opened the connection:

- `rows` permits only the authorized exchange described below.
- `seats` accepts owner control from the canvas's editing installation for
  seats on the receiving machine. The receiver derives executable, folder and
  environment locally from authored intent, not a peer-supplied launch script
  or PID. Terminal handles and subsequent input, resize, stop and output are
  bound to the admitted peer, canvas, seat and occupant generation.
- `status` returns bounded availability and missing-secret metadata for the
  shared scope. It may include a machine form: `macbook`, `mac-mini`,
  `mac-studio`, `mac` or `linux`, derived on that machine. The raw hardware
  string never travels. Status is not arbitrary shell inspection, environment
  export or a transcript reader.

Each channel decodes its payload with its own closed runtime schema before
use. Decoding the common envelope or trusting a TypeScript type does not
establish that payload's shape. Closed means the decode call itself passes
`onExcessProperty: "error"`. A schema annotation alone does not close it:
whether an annotation on a nested struct refuses an extra key changed
between Effect releases, so an upgrade could open it without a failing
build. The machine list derives update-needed state
from the build observed in that peer's hello; a mismatch never admits its
channels, and an unobserved build is not known compatible.

Responses must match the requesting session. A peer cannot gain another
channel's authority by wrapping a request in a response or naming its handle.

## Immutable work and revocation

One machine writes each immutable row. `(writer, seq)` identifies it; the
receiver checks its actual content, not only a peer-supplied hash. An identical
row is harmless; different content under the same identity closes the link.
Only the closed exchange operations for mail, receipts, signals, seat
sessions, resource commands and rulings are admitted. A generic repository
decoder must not expose disabled work kinds through the link.

Before registering a writer, materializing a row or advancing a cursor, the
receiver verifies the peer's authority for that exact canvas, the row's writer,
author and subject, and the recipient's entitlement. A machine writes for its
own seats and automations. An automation's mail and prompts come from the
machine it runs on, named by its Automations node and its automation id, and
are judged as a seat's are: by where that automation was at the canvas count
the row states, from the copies the editing machine sent. Placing or moving
an automation moves that count. Operator mail, mail from before 0.11 that
names no automation, and signal answers or dismissals come from the canvas's
editing machine, which takes them from no peer. A mail author is one of a
closed set of kinds (seat, operator, automation, notice), each admitted from
one machine; only the automation identity may name an automation id; an identity on a node that is not its own is no author. A notice is
a resource's word to one seat, in that seat's own mailbox, written by that
seat's machine: its sender is the resource node, stamped from the author like
every sender, never taken from a row's metadata. A command's actor is
judged the same way: a seat's command row is valid only from the machine
placement says that seat was on when it was written, an automation's only
from the machine it was on, by node and id, at the count the row states, and
an operator's command is written on the editing machine and taken from no
peer. The ruler takes an automation's reach from its own copy of the
definition, its author's, never from the row; an automation it does not hold
reaches nothing. Rulings come only from the editing machine, which takes them from no
peer, and a refusal carries only its closed reason, never text a seat or a
domain wrote. A receipt cannot claim
delivery to another machine's seat. Rejection leaves rows and cursor unchanged.

A machine may relay other writers' rows only for canvases it keeps in full.
It never relays a command row: those go from their writer to the editing
machine and nowhere else. A ruling never carries a command's op or body.
Coverage and cursor advancement are scoped to the canvas and writer; progress
on one canvas cannot suppress missing rows on another. Filtering may leave
sequence gaps. Content bytes require an entitled row, bounded transfer and
verification against its digest; a digest alone grants no right to fetch data.

A sender checks edges against its local canvas copy when it commits mail.
A changed edge takes effect there when the new copy arrives. Previously minted
mail still arrives. Placement history maintained by the editor must let the
receiver validate the author at that stated canvas count after a seat moves
or is removed. The count must be one the editor sent to that machine and must
not move backwards within that canvas's writer sequence. A claimed old count
cannot invent a historical seat-to-machine assignment.

A compromised writer can fabricate mail for its own seats and claim an older
allowed count. Junto cannot prove when that machine really minted it. It must
state that limit and stop accepting the machine's traffic when the operator
removes its participation. Removing it does not erase its data or revoke SSH
credentials outside Junto. An unreachable machine can keep executing its last
copy; the UI must show that revocation or stop has not reached it.

Delivered here, handed to a link and held are different outcomes. A transport
write is not proof that a recipient displayed or read mail. Durable retries
preserve row identity and cannot duplicate terminal delivery or operator effects.

## Secrets and external content

Secret values are resolved on the seat's machine for its child environment.
They are never included in canvas copies, row exchange, status, diagnostics,
failures, logs or launch records. Missing-secret reports carry names and state only. Harness
credentials, browser profiles and SSH credentials remain with their owning
machine and tool; Junto does not install harnesses or log in to them.

A child that receives a secret can read and disclose it. Platform credential
storage protects according to that platform's policy; owner-only file fallback
is not encryption and cannot protect against account compromise. Deleting a
stored value cannot erase copies held by a running child, logs or an external
service.

Web content is untrusted. Managed pages are sandboxed, have no Node integration
or privileged app preload, and cannot become the trusted app renderer through
navigation. Browser commands require a live local seat and the relevant edge
to that page; access to one page does not grant other pages or profile deletion.
While the operator holds a page, a seat sees the timing of the hold, never its
content. Code a seat already ran in the page's document can keep running when
the operator takes the page over, and can watch what the operator types there.
The operator accepted this (21 October): the takeover shows a notice that a
seat ran code on the page, and reloading the page ends that code. A service
worker a seat could have left never outlives a crash: each origin a seat runs
code in is recorded before the code runs, and its workers are removed at the
next start, and one registered during a run is removed as it registers.
The machines feature carries no browser control or browser credentials.

The phone companion keeps its separate restricted forced-command keys, device
revocation and bounded operation set. Pairing material is a credential, never
ordinary log or canvas content. A phone's authority cannot be widened by the
new machine or owner command handlers sharing a process.

**Files node.** A Files node opens one folder, its root, on one machine:
its host, the editing machine's real short name when the node was made. In
0.11 only the editing machine serves Files, because no link verb reads a
peer's files. The service in main (`src/main/junto/files/`) refuses any node
whose host is not this machine (`elsewhere`), so after a later handover the
same root path is never opened on a different disk. The root is set by the
operator, or by an overseer through `node.create` and `node.configure`
(which gives a seat nothing its own shell lacks); the host is fixed at
creation and no edit changes it. The root never leaves the machine: a canvas
copy carries the node as a stub once schema step 52 lands, and nothing
before it (`canvas-copy.ts`), and mention mail,
thread anchors, extracted artifact descriptions, IPC replies, errors, change
events and `junto-file:` addresses carry the node id plus a path relative
to the root, never an absolute path. The renderer never names one either,
with the one exception below: every call names a node and a relative path
(`src/shared/files.ts`), main reads the root off the node on each call,
`realpath`s the target and refuses anything outside the root, symlinks
included (`outside-root`). A target inside Junto's own home
(`~/.junto`) is refused `denied` under any root, so the editor never
overwrites `junto.db` or a seat token and no comment or extract copies them;
a root that holds the home, such as `~`, still opens. Junto runs no command
a folder's own git config names: every git main runs (the Files index, the
git node, the checkout watch) overrides `core.fsmonitor`, `core.hooksPath`,
`log.showSignature` and every filter driver the repository config names,
never looks into a submodule's work tree, and builds diffs with
`--no-ext-diff --no-textconv` (`src/main/junto/adapters/git-guard.ts`).
Renaming, moving or trashing a symlink acts on
the link, never on what it points at. Delete moves to the Trash
(`shell.trashItem`), never `unlink`. A write names the version it read
(mtime and size), is refused `stale` when the file changed, and replaces
the file through a sibling temp file. Open in its default app refuses what
would run rather than open: a file with an execute bit, an `.app` or other
launchable bundle, script or installer; Reveal in Finder still shows it.
`junto-file://<nodeId>/<relpath>` serves bytes only for a node a window of
the trusted renderer has opened, on this machine, inside the root after
`realpath`; anything that is not an image, PDF or media file goes out as
`application/octet-stream` with `nosniff`, so a page under a root is never
rendered as a document. Every response also carries
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`,
because an SVG is an image that can carry script. The renderer shows an
image with `<img>` or a canvas, and a PDF through pdf.js, never in an
iframe or an object or by navigating to a `junto-file:` address. The exception is a drop: Finder files dropped on
the node arrive as OS paths (`webUtils.getPathForFile`), which main reads
as sources to copy from and never changes; a copy never overwrites, it
takes the next free name (`name 2`). All channels sit behind
`trustedRendererIpc`.

## Code steps

An automation's `code` step runs authored TypeScript, or later a shell
script, on the automation's machine as that machine's OS account. It is not a
sandbox. The code may be written on one machine and run on another, so a
machine runs it only when all four checks hold, at every firing:

1. The automation's definition reached this machine as an applied automation
   ruling from the machine ruling the canvas. A row never carries code.
2. The code is a content ref in that ruling. Its bytes travel as content
   does: bounded, entitled to the automation's machine and the ruling
   machines only, never in a canvas copy.
3. The code's author was the operator, or a seat holding a live overseer
   grant on the ruling machine's copy when that machine ruled it. The
   ruling machine stamps that author from the admitted command's actor,
   never from the op, and the author is the actor of the ruling that last set
   the code ref: changing a trigger or another step does not change who wrote
   the program. The automation domain refuses code from any other seat and
   from an automation actor. Code never writes code.
4. The automation names this machine.

A failed check is refused `not_permitted`, and the firing log names the
check and the machine. A code step needs no step on the machine that runs
it: there is no per-machine allowance (the operator's ruling, 28 October). A
move changes the machine, its files and its secrets, never the program. The
machine the code left keeps the bytes it received.

What this admits. The machine that rules the canvas, and any machine hosting
an overseer seat on it, can run code as the OS account on every machine that
hosts an automation on that canvas, and so can any process on those
machines, since seat credentials are readable off the process table (Trust
and its limits). Listing a machine for authority, or granting overseer to a
seat on it, is the operator's grant of that. A compromised ruling machine
controls the code on every machine that hosts an automation on its canvas.
Revoking an overseer grant leaves code that overseer wrote in place; editing
or archiving the automation stops it, for future runs, not one in flight,
which ends at its timeout. An automation that mails or prompts an overseer
gives that overseer input, never authority to write code.

Each run:

- Copies the bytes into a fresh 0700 directory made for that run, verifies
  that copy against the digest, and runs that copy, with the directory as
  its working directory. The directory holds nothing but that copy, so no
  project `.env`, `bunfig.toml`, `package.json` or `tsconfig.json` is there
  to read, whatever the runtime's flags do. It is removed after the run.
- Runs TypeScript with the core's own runtime by absolute path, never one
  found on `PATH`. Imports resolve only to the SDK and the runtime's
  built-ins: no package install, no package resolution from a folder, and no
  `.env`, `bunfig.toml`, `package.json` or `tsconfig.json` read from any
  folder, the same as git config (Files node). Flags alone do not hold this
  on bun 1.4.3: a cwd `.env` and `bunfig.toml` preload load by default, a
  parent `tsconfig.json` applies its paths, and a runtime plugin's resolver
  sees only the entry, so a parent or `HOME` `node_modules` resolves through
  every import form. So the step is bundled in memory with a closed
  resolver, run as a module with no folder, `require` is limited to
  built-ins and a computed `import()` is refused
  (`src/main/junto/automation/code-sdk.ts`;
  `tests/automation-code-runner.test.ts` plants each file in the parent and
  in `HOME`). This keeps folders from changing what a step means. It is not
  a sandbox against the step's author: `eval` or `new Function` reaches the
  runtime's own resolver.
- Runs shell as `/bin/sh <path>`. The path is in argv; the source bytes, the
  trigger and its values never are.
- Gives the child an environment of the region's values on that machine
  plus `PATH`, `HOME`, `TMPDIR` and `LANG`, and nothing of the core's.
  `JUNTO_WORK_TOKEN` is set to the empty string, so the CLI refuses owner
  and machine commands (`src/cli/core/owner-access.ts:7`); that guards
  against confused use, not attack.
- Gives the child no Junto credential. Input arrives as JSON on stdin and the
  result goes out on fd 3. The SDK has no Junto operation; if it gains one,
  the child gets a credential for the automation actor alone, for that
  firing, revoked on exit or timeout, never a seat token or the owner socket.
- Bounds time and output and holds the loop rule. A timeout or an exceeded
  bound stops the process group under the process rule (Install, update and
  machine safety).
- Records in the firing row the definition version, the code digest and the
  machine, so the log says which bytes ran where.

A child that receives a secret can read and disclose it, including in its
result, whose values later steps can mail. A result that carries a region
value as written fails the step; an encoded or transformed value passes.
Argv past the executable, the
environment, stdin, stdout and the result never enter a log or a failure. The
child's stderr contributes a tail only through the stderr-tail rule below,
with the child's environment among the known values.

## Failures and logs

Failures cross the link with their cause chain, and every machine keeps a log
([machines.md](machines.md), Failures and logs). People, agents and another
machine read both, so both are a disclosure path. This is the redaction rule.
A field that crosses a machine or reaches a log is checked against it before
it lands.

**May enter.** Tags, operation ids, machine, canvas, seat and harness names,
installation ids, generation numbers, file and executable paths, exit codes,
signals, durations, byte counts, build ids and digests carried as typed
fields, environment and secret names with their state, and error text that
has passed the scrub below.

**Never enters.** Secret values. `JUNTO_WORK_TOKEN` and every other
credential, token, key, cookie, password or pairing material. Environment
values of any kind, whether a whole environment or one value. Command
arguments past the executable: argv is authored text and can hold an inline
value. Terminal bytes, meaning a seat's terminal input or output, in any
amount. The stdout of a secret tool. The actual value in a decode failure;
carry the path and the expected shape only. Request and row payloads, mail
bodies and canvas text. A field that cannot be shown to belong to the first
list belongs to this one.

**Terminal bytes stay in the terminal.** A seat's terminal merges the
harness's output with the operator's typing, so no part of it is a stderr
tail. A seat that fails to start reports the spawn result, exit code, signal
and a closed classification derived on the seat's machine, such as "harness
not installed" or "harness exited during start". What the harness printed is
read in its terminal, under the existing terminal authorization, never copied
into a failure or a log.

**Stderr tails.** Only processes Junto spawns without a terminal contribute a
tail: the remote core under SSH, the OpenSSH client, install, update and
service commands, the build check and a code step's child. A secret tool's stderr (`security`,
`secret-tool`, `op`, an operator's command) stays classification only. The
machine that read the bytes makes the tail, in this order:

1. Hold at most the last 64 KiB as it arrives, and drop the window's first
   line when it may be partial.
2. Decode as UTF-8 with replacement. Remove escape sequences whole (CSI, OSC,
   DCS and any other ESC pair), C0 controls except newline and tab, DEL, C1
   controls, and bidirectional overrides and isolates. A carriage return ends
   a line.
3. Replace every known value with `[redacted]` through `redactSecretValues`
   (`src/main/junto/credentials/redact.ts`). Known values are the generation
   credential and every value in the process environment and in each live
   seat's and code step's child environment, region values included, except those named
   `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, `PWD`, `TERM`,
   `COLORTERM`, `LANG`, `LC_*`, `JUNTO_HOME`, `JUNTO_SEAT`, `JUNTO_NODE_REF`,
   `JUNTO_SOCKET`, `JUNTO_WORK_SOCKET`, `JUNTO_WORK_HOME` and `JUNTO_CLI`:
   those are names and paths. The list is closed; a new variable is searched
   until it is added here. The credential is searched from four
   characters, environment values from six, so that a value such as `1` or
   `true` does not erase the text.
4. Replace what looks like a credential Junto does not know: the value after
   `Authorization:` or `Bearer`; the value of a `name=value` or `name: value`
   pair whose name contains token, secret, password, passwd, key, credential,
   auth, cookie or session; URL user information and such query values;
   `-----BEGIN ... PRIVATE KEY-----` blocks whole; the token shapes `sk-`,
   `ghp_`, `gho_`, `github_pat_`, `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `AKIA`,
   `ops_` and a three-part JWT starting `eyJ`; and any run of 32 or more
   base64 or hex characters that mixes letters and digits, except Junto's own
   ids of the form `<kind>-<26-character ULID>`.
5. Keep the last 40 lines and at most 4 KiB, cutting at a line start, and
   record that it was cut.

The scrub runs over the whole window before the cut, so truncation never
leaves half a token the patterns miss. Step 4 also removes harmless text,
such as a digest printed to stderr; that is accepted, and the digests that
matter travel as typed fields.

**Error text.** Every message in a cause chain, and every log message, passes
steps 2 to 4 where it is encoded for the link or written to the log, through
one function in one module. A message is at most 1 KiB and a chain at most 8
links; the rest is cut and marked. A cause Junto did not write, from Node,
SQLite or a library, is scrubbed like any other, never trusted to be clean.
Schema decode failures are formatted without the actual value. A typed id or
name field (seat, canvas, machine, operation, link session, request,
installation, binding and generation ids) is checked against its own schema
and dropped when it fails; it is never scrubbed, because a scrubbed id
no longer matches the scope it is read under.

**The receiver distrusts the sender.** A failure from another machine is
decoded with a closed schema whose strings have maximum lengths, then put
through steps 2 and 4 again before it is stored, logged or shown. Shown means
plain text, never markup, a link or a command. Its text is data and grants
nothing; an agent reading it reads untrusted output.

**Logs.** Files under `~/.junto/logs/` are mode 0600 in a 0700 directory.
A row is at most 16 KiB, and rotation bounds the total, so a peer's failures
cannot fill the disk. A row holds only fields from the first list and
scrubbed text. `console.*` routed into the logger is scrubbed like every other
message; that hook is the likeliest leak and is reviewed first. From a seat,
reading this machine's log returns that seat's own rows, rows for seats it
holds a `terminal.read` edge to, and machine rows that name no seat; the
seat comes from its generation credential, never from a flag. Reading a
linked machine's log is an owner command over a closed link operation, not a
shell, and is refused from a seat environment like every machine command. It
returns only rows for canvases that peer participates in, plus machine rows
that name no canvas. A scrubbed log is still the account's data. It is sent
nowhere else, and deleting a secret does not erase a log written before this
rule was in force.

**Review.** The author of every new field in a failure, a link frame or a log
row names the list it belongs to. A field without that claim does not land.
Each scrub step has a test that seeds a value and proves it is absent from the
encoded failure and from the log row at both ends.

## Install, update and machine safety

Sending Junto installs an operator-selected package over the chosen SSH route
under the target user's home, with a per-user service. It requires no admin
account, privileged helper or logged-in screen. A windowless machine runs the
same core without Electron. Installers and relays never open product databases.

The archive checksum and pinned dependency digests establish integrity relative
to the operator's chosen inputs, not publisher authentication. A self-supplied
file inventory is not a publisher signature. Downloaded desktop releases must
still pass their release authentication and artifact-admission path; the
machine-copy rule does not weaken that boundary.

A release app carries no machine bundle. Its authenticated compiled catalog
pins, for each supported target of its own build, the archive path, exact byte
count, SHA-256 and manifest SHA-256. Each download starts at the compiled
HTTPS release origin, `https://releases.juntoagents.com`, and requests an
immutable `/machines/<build>/<target>.tar.gz` object. A downloaded manifest,
response header or separate publication file cannot replace those pins.
Release commands refuse local bundle overrides. Source and Preview builds
use local bundles only and never fall back to a download.

Redirects are handled manually. At most one HTTPS hop is admitted, with the
archive path unchanged and the destination host on a compiled allow-list.
That list contains only `junto-releases.skastr052.workers.dev`. Every other
redirect fails closed with a plain failure message. The compiled archive
size, hash and manifest pins remain authoritative; the allow-list only
bounds where bytes may come from.

The archive must be smaller than 300,000,000 bytes. Bound actual streamed
bytes independently of response headers and verify the complete archive
size and digest before unpacking. Extraction admits only the specified
regular-file archive format, with bounded expanded bytes,
members and paths, and refuses traversal, links, special files and duplicate
paths. Match the manifest's bytes to its compiled digest, then verify the
complete inventory, build and target. These checks finish before disconnecting
the current link, copying to the destination or changing its installation.
Offline, incomplete or invalid downloads leave the destination as it was.
Download progress counts bytes separately from the SSH copy; neither means
that installation succeeded.

Cache archives per build under the Junto home, rechecking their actual bytes
on every use and extracting into a fresh private attempt. Only fully verified
archives enter the cache atomically. Cleanup and pruning use authority for
owned cache entries, never a caller's path or a symlink redirect, and cannot
remove a concurrent operation's inputs. Failed or interrupted acquisition
cannot become a reusable success or permanently block a later explicit retry.

Removing bundles from the app does not remove their signing audit. Strip
before signing, sign Darwin binaries with the existing identity, hardened
runtime and entitlement policy, then seal the manifest and run the relocated
boot check. Audit the exact archive payload against that same policy before
sealing the catalog; it no longer inherits the enclosing app's resource seal.
No signing or repacking may change bytes after the catalog pins them. The
publisher proves its archive metadata equals the catalog compiled into the
qualified app, uploads the archives before advancing `latest-mac.yml`, and
refuses different bytes at an existing immutable key. Rebuilding the same
source does not authorize replacing a previously published signed archive.

An install or update must:

1. Verify the exact admitted package and target platform before activation.
   Recheck staged and reused installed files against that same inventory.
2. Prove ownership of every path it creates, overwrites or removes, including
   existing descendants and service definitions. A string prefix is not proof
   against a symlink redirect. Act only on the selected installation.
3. Quiesce the exact owned incumbent and prove exit before selecting a new
   package. Never run two product-database owners for one home.
4. Confirm the candidate's build, installation, home and required core readiness.
   A service manager's active state alone is not a ready Junto.
5. Report whether activation occurred. If the candidate may have opened state,
   uncertainty is not permission to replay installation or launch an older
   binary. Recovery is forward-only after durable state advances.

SQLite evolution remains forward-only, with released migrations immutable and
an exact schema identity. Older binaries refuse advanced state before writing.
Retirement requires the specific approval in the build contract; neither
migration nor repair invents permission to erase installed user data.

Destructive process and filesystem operations use authority minted for an
owned resource, not a caller's bare PID or path. Stop and cleanup must verify
their result and report uncertainty. These controls prevent confused code and
partial failures from harming the machine; they do not pretend to constrain
its account owner.

A process is identified by its pid and its start time, read in one
observation, and a group by its pgid. The session is not evidence: macOS
`ps -o sess=` prints 0 for every process. A pid with no row proves nothing
about who holds that number next. A group is ours only while a process seen
in it has lived since we could prove it ours: a pgid stays in use while any
member lives, but once the group empties, the number can return as someone
else's session and group. A process is signalled only by its own positive
pid, after a fresh read shows the same pid, pgid and start time.

## Boat machines

A Boat sandbox ([machines.md](machines.md), Boat machines) is a machine under
every rule above. Boat runs it with root, so the operator trusts Boat with
whatever a seat there can reach. Boat adds three credentials, and each one
keeps its own place.

**The account key** lives only on the editing machine, in its platform secret
store, under one fixed id. The operator's browser-signed-in `boat` CLI mints
it, and the core runs that CLI with fixed argv. For this call the CLI is a
secret tool: its stdout is parsed in memory and only the key reaches the
store; its stdout and stderr are never a tail, a log or a failure, only a
closed classification. The key's actions are exactly `sandbox.create`,
`sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`,
`sandbox.delete-own` and `ssh`, checked against the CLI's answer after
minting. A key with any other action, such as minting keys or an admin or
account action, is refused. No key rides an owner request. Junto calls Boat
only for sandbox ids in its machine list. A reconnect revokes the old key by
its id.

**The machine key** is minted, each time, by the operator's CLI on the editing
machine, for one sandbox and only `sandbox.read`, `sandbox.update` and
`sandbox.stop`. Its scope is checked after minting, as the account key's is.
It is the one credential that crosses machines, and only at setup:
- it is written over the dialled SSH session, after strict host-key checking;
- it travels on stdin, never in argv, an environment value or a command string;
- it is written atomically to that machine's Junto home, at mode 0600, with
  owned-path proof.

It never enters a canvas copy, a row exchange, status, a log, a failure or a
seat's child environment. The machine core searches for its value as a known
value in the scrub. A seat on that machine runs as the same user and can read
it. That is accepted, because the key can only keep that one sandbox awake or
stop it, which a busy seat already causes. An update, a remove and a delete
each revoke the old key, and a revocation that failed is shown.

**The host key** is pinned from Boat's API over HTTPS at every wake, because
the address and sometimes the key change on resume. Each wake rewrites that
machine's own known-hosts file with exactly the one key Boat answered, under
a fixed host key alias. The dial uses strict host-key checking and Junto's
own identity, which is used for nothing else. Boat's API is the trust anchor
for the key, and that adds no party Boat was not already.

The client calls only the compiled origin `https://boat.dev`. It follows no
redirect and bounds every answer. A failure carries a fixed sentence, Boat's
status and a code that matches a pattern, never the key or a response body.
Sandbox and key ids are typed fields. The scrub carries Boat's key shapes.

## Evidence before a security claim

A finding names the boundary, attacker or failure, reachable path, consequence,
source or runtime receipt, and smallest repair. Keep a design requirement,
a source trace, a unit test and an observed packaged run distinct. A proposed
fix is not a verified fix, and a boot-only exercise does not prove mail,
terminal authorization or update safety.

Boundary checks cover legitimate use and refusal: wrong peer or canvas,
forged author, changed duplicate, stale intent, revoked generation, malformed
or oversized input, interrupted update and uncertain completion. The two-machine
exercise runs from disposable homes without touching the operator's active
state or keys, and proves that its managed seats' CLI refuses owner and machine
commands before connecting or changing an installation. This establishes the
client guard, not isolation of same-account processes from the owner socket.
Tests do not weaken production admission to obtain a pass.

A release claim is limited to the code and packaged behavior actually exercised.
Unimplemented or untested boundaries remain visible. No review declares the
whole system secure because its selected checks found nothing.
