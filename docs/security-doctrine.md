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
users; they do not isolate processes belonging to their owner. Seat tokens,
edge checks and process ancestry checks attribute Junto calls and prevent
confused use. They are not a sandbox or proof that a human made a request.

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
| Owner command | An explicitly enabled owner-only control socket, with registered seat/terminal process trees refused and an indeterminate ancestry walk denied. Closed commands invoke the same services as the window. |
| App window | The committed trusted renderer identity and origin, validated before privileged IPC dispatch. Arbitrary pages do not receive its bridge. |
| Overseer seat | A live human-granted overseer flag and a closed operation set, attributed to the real seat. It does not become the operator. |
| Another machine | The bound link peer plus authorization for the particular canvas, channel, operation and resource. A successful hello grants no general execution authority. |
| Paired phone | Its restricted companion transport and live device registry, limited to the companion operations. It is not a machine link or a general operator-command relay. |

The window calls the same closed owner commands for machine operations. It
adds no authority of its own and cannot bypass their validation or admission.

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
can use their owner commands while their own managed seats remain refused.
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
- The editing machine keeps the complete canvas and its work. Other machines
  receive only work they are entitled to, including mail for their seats and
  the receipts or answers relevant to their seats' work.
  Notes, labels, files and links stay on the editing machine.

Copy selection must enumerate fields and tables. Adding a field does not
silently make it public. Content that no local seat needs is not copied just
because it has a canvas row. A guidance, reference, briefing or placement
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
machine opens links. At that end, the connection is bound to the selected route
and its pinned installation id. At the receiving end, the first peer id is accepted
only during explicit machine setup. A hello cannot enroll itself or select an
existing peer. Changed ids or names are refused.

Each identity fact has one source: this machine's name in
`machine_configuration`, and peer name-to-installation bindings in
`machine_peers`. The machine list holds routes and presentation only; changing
or recreating a route cannot create or replace a peer binding.

A machine may change its own name only before any peer has ever been pinned,
including a retired peer, and while no seat or other durable reference names
it. A pinned peer's name and installation id never change at either end.
Retirement retains that binding: a different installation under the retired
name is refused. Rename and replacement under a used name require a later
explicit design.

Bindings from the retired Station protocol are discarded, not imported as
pins for this protocol. Existing installation identities needed by durable
rows are preserved; membership in `known_installations` grants no link
authority. Every first pin comes from an explicit owner setup and a validated
hello of this protocol. Migration, discovery and ordinary reconnect cannot
authorize that setup.

SSH authenticates a host and an account. The incoming installation id is an
assertion authorized by that account, not cryptographic proof of a particular
installation. A local relay cannot infer the original SSH caller from its Unix
peer PID. Junto adds no signing or SSH key system for this first version.
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

The transport is symmetric. Authority depends on the bound peer and the
canvas, never on which end opened the connection:

- `rows` permits only the authorized exchange described below.
- `seats` accepts owner control from the canvas's editing installation for
  seats on the receiving machine. The receiver derives executable, folder and
  environment locally from authored intent, not a peer-supplied launch script
  or PID. Terminal handles and subsequent input, resize, stop and output are
  bound to the admitted peer, canvas, seat and occupant generation.
- `status` returns bounded availability and missing-secret metadata for the
  shared scope. It is not arbitrary shell inspection, environment export or
  a transcript reader.

Responses must match the requesting session. A peer cannot gain another
channel's authority by wrapping a request in a response or naming its handle.

## Immutable work and revocation

One machine writes each immutable row. `(writer, seq)` identifies it; the
receiver checks its actual content, not only a peer-supplied hash. An identical
row is harmless; different content under the same identity closes the link.
Only the closed exchange operations for mail, receipts, signals and seat
sessions are admitted. A generic repository decoder must not expose disabled
work kinds through the link.

Before registering a writer, materializing a row or advancing a cursor, the
receiver verifies the peer's authority for that exact canvas, the row's writer,
author and subject, and the recipient's entitlement. A machine writes for its
own seats. Operator mail and signal answers or dismissals come from the
canvas's editing machine. A receipt cannot claim delivery to another machine's
seat. Rejection leaves rows and cursor unchanged.

A machine may relay other writers' rows only for canvases it keeps in full.
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
They are never included in canvas copies, row exchange, status, diagnostics or
launch records. Missing-secret reports carry names and state only. Harness
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
The machines feature carries no browser control or browser credentials.

The phone companion keeps its separate restricted forced-command keys, device
revocation and bounded operation set. Pairing material is a credential, never
ordinary log or canvas content. A phone's authority cannot be widened by the
new machine or owner command handlers sharing a process.

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
state or keys, and proves that its managed seats cannot use its owner socket.
Tests do not weaken production admission to obtain a pass.

A release claim is limited to the code and packaged behavior actually exercised.
Unimplemented or untested boundaries remain visible. No review declares the
whole system secure because its selected checks found nothing.
