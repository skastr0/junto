# Vellum security doctrine

**Status:** normative product doctrine

**Scope:** product trust, operator intent, agents, canvases, stations, fleet
topology, and Vellum-owned control paths

This document is the governing security doctrine for Vellum. It defines the
product Vellum is becoming and the claims a production release must be able to
prove.

When another document, backlog item, review, test, or implementation conflicts
with this doctrine, the conflict must be removed. Internal compatibility,
dual-read, dual-write, and dormant fallback paths are not exceptions to the
doctrine.

## Product position

Vellum is unapologetically a **one-person business factory**.

One operator may own many machines, accounts, regions, projects, agents, and
business assets. Those resources still express one sovereign intent and one
factory workstream. Vellum is not a collaboration canvas for independent
people performing separately authorized work.

Vellum v1 does not attempt to provide:

- multi-tenant isolation;
- team roles or employee RBAC;
- mutually distrustful collaborators;
- enterprise identity governance;
- security boundaries between multiple human operators in one factory.

A Vellum installation belongs to one operator and one factory. A competent
operator may run separate installations under separate operating-system
accounts. Vellum does not add a machine-global tenancy system to coordinate
those accounts.

## Security objective

Vellum makes the operator's existing power **explicit, legible, scoped, and
recoverable**. It must not silently enlarge that power or create routes the
operator did not choose.

No powerful fleet application can truthfully promise that compromise or data
loss is impossible. Vellum instead makes concrete, testable promises:

1. Vellum does not secretly create authority.
2. Vellum enforces operator intent throughout every Vellum-owned control path.
3. A boundary Vellum advertises is a boundary Vellum actually enforces.
4. Vellum does not silently create lateral fleet reach.
5. Vellum exposes loss of reach or control honestly and immediately.
6. Vellum preserves operating-system, root, web-content, package, and physical
   machine boundaries rather than pretending to replace them.
7. Vellum minimizes the authority and sensitive data placed on each resource.
8. Safety controls protect the user's machine from mistakes without treating
   the trusted factory as an adversary.

## The trust model

### Trusted

- The single human operator.
- Machines and accounts the operator explicitly enrolls.
- Agents the operator intentionally attaches to the factory.
- External actors and provider resources the operator explicitly enrolls.
- Vellum processes and owner-local control transports on an enrolled station.

Attached agents are trusted participants, but they are not assumed to be
perfect. They may be eager, mistaken, unaware of Vellum's topology, operating
on stale context, influenced by prompt injection, or affected by a harness or
tool bug. Vellum therefore enforces operator-authored edges and ports on every
Vellum-owned action.

This is protection of operator intent and protection of agents from mistakes.
It is not an attempt to contain a malicious process that already has arbitrary
shell access as the operator's operating-system account.

An **external actor** is external to a Vellum runtime, not external to operator
ownership or trust. Vellum does not add warnings or repeated disclosure
ceremonies merely because an operator-owned actor uses a harness, provider, or
managed resource outside the local Vellum process.

### Untrusted boundaries and inputs

- Arbitrary websites and browser page content.
- Unenrolled machines and unauthenticated network peers.
- Downloaded packages, updates, imports, and network responses until verified.
- Data crossing into privileged filesystem, process, shell, browser, or root
  operations until decoded and validated.
- Other operating-system users.
- Responses and payloads crossing an external provider connector until decoded
  and validated.
- Root authority except during an explicit, bounded operator transaction.

Agent and model output is treated as untrusted **input** when it crosses one of
these privileged boundaries. That does not make the attached agent an
adversarial tenant.

### Explicit non-claim

Vellum does not claim to isolate mutually hostile processes running as the same
operating-system user. Such a process may already be able to inspect files,
invoke binaries, automate applications, or use the user's credentials outside
Vellum.

Controls whose only purpose is defeating an arbitrary malicious same-user
process require an explicit change to this doctrine. They must not quietly
enter the product through a review or backlog item.

## Governing laws

### 1. Single sovereign

The operator is the sole author of factory intent. Agents execute, report,
request, and produce artifacts. They do not become co-authors of the canvas,
settings, topology, or station roles.

### 2. No surprising authority

Vellum never creates, discovers-and-uses, broadens, transfers, or retains
authority without a corresponding operator-visible action.

In particular, Vellum must not silently:

- open a port;
- enroll or connect a host;
- reuse an SSH destination merely because it was discovered;
- install an integration;
- grant an agent another machine's capabilities;
- turn a facility into an execution actor;
- promote a Station to Command Center;
- make one Station directly reachable from another.

Discovery may produce a visible suggestion. It never produces authority.

### 3. Operator intent is sacred

The canvas and protected settings are executable operator intent. Every
Vellum-owned path must use the current intent available to that runtime.

A control path that bypasses an edge, port, station assignment, actor class, or
role boundary is a product security failure even when the attached agent is
trusted.

### 4. Advertised boundaries are real

An edge, port, actor tier, host assignment, profile boundary, role, revocation,
or termination state must not be advisory when the UI presents it as
protective.

Vellum may state an external limit honestly. It must not display a stronger
guarantee than the runtime can enforce.

### 5. Explicit enrollment

Every host and external resource begins outside the execution graph.
Enrollment is always an operator action.

Defaults are strict and deny new reach. The operator may deliberately broaden
the factory. Vellum then enables that chosen power without repetitive approval
ceremonies.

Configuration must remain small enough to understand. Prefer a predictable set
of atomic capabilities and strong presets over vague security levels or a
settings swamp.

### 6. No Station-to-Station control plane

Vellum guarantees Command Center-to-Station communication. It does not create a
Station-to-Station control plane.

Any future cross-station action must route through Command Center and remain
subject to current operator intent. Mere network adjacency does not create a
route.

### 7. Stateless Stations

**Stateless here applies to authorial intent and fleet coordination.** It does
not mean a Station has no durable database or stateful runtime.

Command Center is the sole authority for intent. A Station holds only:

- its factory and Command Center pairing;
- the latest complete intent projection it received;
- rows single-homed to that installation, including work, receipts, cursors,
  and the local runtime resources required to execute them.

Station-hosted actors, Sinks, browser profiles, cookies, terminals, processes,
artifacts, and runtime recovery data may be stateful or persistent. They remain
physical or operational resources governed by the current projection; they do
not become an independently authoritative copy of factory intent.

The Station projection is a replaceable cache, not an independently
authoritative document.

A Station does not author, merge, negotiate, elect, reinterpret, or veto
intent. It does not coordinate intent with another Station.

When a complete projection arrives through the paired Command Center's
authenticated Station API route, that projection supersedes the previous
projection in one transaction and the Station enacts it. Projection generation
and content hash enforce idempotence and conflict detection; they are not a
consensus protocol.

If Command Center is sleeping, closed, crashed, or otherwise unavailable, the
Station continues under the latest intent it received. There is no delegation
ceremony, lease state machine, election, or recovery protocol on the Station.

If Command Center cannot reach a Station, it cannot update or command that
Station. It must:

- mark the Station and affected canvas resources as unreachable or stale;
- show the last acknowledged projection;
- warn the operator without claiming synchronization or control;
- offer visible, safe diagnostic tools;
- leave remediation and fleet/network decisions with the operator.

The unreachable Station continues under its last received intent. Vellum does
not attempt to solve a network or machine the operator cannot reach.

### 8. Honest operator tools

Vellum may provide Doctor, connectivity tests, SSH or network inspection, safe
scans, and exact remediation guidance.

These tools remain visible to the operator. Read-only diagnosis may run
automatically when disclosed by the UI. Active remediation, topology changes,
new connectivity, installation, or privilege escalation requires an explicit
operator action.

### 9. Safety without autoimmunity

Machine safety protects against confused code, malformed input, partial
failure, dangerous path selection, PID reuse, and destructive mistakes.

It does not justify treating trusted same-user agents as hostile tenants.
Security machinery must identify:

- the real boundary;
- the plausible failure or attacker;
- the reachable path;
- the material consequence;
- the property the control actually enforces.

If those cannot be named, the control is security theater and must not become a
product requirement.

## The protected operator-intent plane

### Canonical canvas

The canonical canvas is a protected Vellum document authored only through the
operator interface.

The target product contract is:

- canvas and protected settings have one app-owned authoring path;
- only direct operator actions in Command Center author intent;
- agents never write the canonical canvas;
- agents consume read-only compiled projections and Vellum tools;
- automatic history records operator changes without adding authoring chores;
- undo, recovery, and "what authority changed?" remain operator facilities.

JSON Canvas is an import/export and interoperability format. Its contents are
not inherently secret. It is not the canonical live authority store. Importing
an edited document is an explicit operator action. Exporting a document does
not grant the exported file live authority over a running factory.

Canonical live and durable state is `~/.vellum/state/vellum.db`. It is an
owner-only SQLite database opened by the Electron main process through one
Effect `StateEngine`; renderers, CLIs, helpers, and fleet callers use
IPC/control APIs and never open it. App-owned write/create/remove operations
commit full-map `canvas_generations` and advance `canvas_head` transactionally.
History is ordinary queryable database state, not a content-addressed directory
or manifest tree.

Every installation uses the same schema. Role changes which rows are resident
and active, not which storage implementation exists:

- Command Center holds authorial canvas generations, fleet enrollment and
  coordination, and all work homed to Command Center;
- a Remote holds its complete replace-only projection, Station pairing and
  configuration, logical propagation cursors, and work homed to that Station;
- messages remain Command Center-homed;
- browser profiles and other physical resources remain on the installation
  that owns them.

One durable row has one home. Re-homing is an explicit move; it is never a
dual-read or dual-write interval.

Startup accepts only a fresh database or exactly the current composed schema.
Inside one transaction, Vellum executes the current DDL and compares the
normalized actual `sqlite_schema` (tables, constraints, indexes, and triggers)
with a fresh in-memory compile of that same DDL. Only an exact match is stamped
and committed. Every non-current shape fails closed; startup contains no
obsolete-schema recognition, repair, compatibility reader, or fallback. The
transient in-memory compiler contains no product data and is not an authority
connection.

Canvas confidentiality follows the operator's operating-system account, disk,
backup, and export choices. Vellum does not become a general secret-management
or key-management system merely because the canvas is authoritative.

### Agent surface

The protected document remains the product. Compiled projections and
capability-bound tools are the agent API.

Agents may receive deterministic text or visual projections, scoped context,
pulse briefings, work requests, messages, and artifact facilities. They do not
receive an authorial canvas mutation path.

### Portability and derivatives

JSON Canvas files, digests, SVG renders, screenshots, diagnostic bundles, and
other derivatives are explicit export and interoperability surfaces. They keep
the operator from being locked into Vellum.

An exported derivative:

- does not become canonical operator intent;
- carries no live authority over a running factory;
- may be consumed by the operator or an attached agent through an authorized
  Vellum tool;
- remains an ordinary operator-owned file when deliberately persisted.

Vellum must not silently treat an exported derivative as authorial input or
live factory state. This protects the canonical authoring boundary without
turning deliberate operator portability into a warning ceremony.

### Protected settings

Station role, Command Center identity, factory membership, host enrollment,
security capabilities, and equivalent topology state are protected operator
intent. They are normalized rows in `vellum.db` and are mutated only through
app-owned services. There is no plaintext settings or hosts document whose
edit, signature, HMAC, or deletion can mint or transfer that authority.

Ordinary use should favor operator comfort. Explicit reauthentication or
recovery ceremony is reserved for catastrophic actions such as Command Center
transfer, factory recovery or reset, and factory identity or recovery export.

The exact authoring lock, catastrophic-action reauthentication, factory
pairing, and recovery design remain open decisions below.

## Factory topology

### One Command Center per factory

There is exactly one Command Center for one Vellum factory.

Many independent Command Centers may exist on the same physical network when
they belong to different factories. Network discovery never establishes
factory membership and never disables a new installation.

A new installation may:

- create a new factory;
- explicitly join an existing factory as a Station;
- remain an unenrolled local installation or facility.

One Vellum installation belongs to at most one factory and has one role in that
factory.

### Command Center transfer

A Station never becomes Command Center through SSH enrollment, a CLI request,
an agent tool, a canvas edit, or a settings mutation.

Command Center transfer is a catastrophic operator workflow. The current
Command Center must deliberately yield, and the operator must directly open
Vellum on the target installation to accept its new role. Exact transfer and
permanent-loss recovery mechanics remain open decisions.

### Actor classes

- **Command Center actor** — executes within the Command Center runtime.
- **Station actor** — executes within an enrolled Station runtime.
- **External actor** — executes outside a Vellum runtime but reaches an
  assigned runtime through a supported Vellum MCP/CLI or provider connector.
- **Facility** — acknowledged infrastructure with no Vellum execution
  authority; not yet an actor in the execution graph.

External describes runtime placement, not ownership: an enrolled external
actor remains an operator-owned, trusted factory resource.

Actor class, placement, and access tier constrain the ports and edges the
operator may create. They do not themselves grant an action.

### Runtime access tiers

| Tier | Relationship to Vellum | Promise |
|---|---|---|
| **1** | Actor can access Command Center in the same runtime | Full local protocol plus explicit factory-administration surfaces |
| **2** | Actor can access a Station in the same runtime | Full host-local execution within Station assignment and current edges |
| **3** | Actor has no local Vellum runtime but has a configured Vellum MCP/CLI route to its assigned Command Center or Station | Protocol-enforced remote capabilities; no claim of local runtime ownership |
| **4** | Resource has no Vellum runtime or configured Vellum MCP/CLI | Facility/onboarding value only; cannot operate in the execution graph |

The product should make as much useful capability as safely and honestly
possible available at Tier 3. Truly host-local or sensitive capabilities may
remain Tier 2. Tier 1 should differ from Tier 2 primarily where factory
administration genuinely requires Command Center.

Enrollment may progress from acknowledged facility, through optional
work-surface or harness integration, to a Tier 3 configured actor, and finally
to a Tier 2 Vellum-managed Station. Tier 1 is never granted through SSH
enrollment.

Actor class, tier, assigned runtime, and meaningful edge constraints must be
visible on the canvas and in inspection overlays.

## Edges, ports, and enforcement

An edge is an enforceable delegation within Vellum. It is not a claim that the
operating system confines a trusted shell process.

For every protected Vellum action:

- the actor is attributed to its real Vellum seat;
- the target belongs to the expected runtime and host;
- a current edge connects actor and target;
- the requested operation matches the edge's ports;
- the actor's class and access tier support the route;
- every Vellum-owned relay repeats the relevant checks.

Process binding is automatic attribution of a live process to a seat. It must
not grow into a user-facing enable ceremony or be described as same-user
malware containment.

### Revocation and deletion

On every reachable runtime, edge deletion or restriction affects the next
Vellum action immediately. New actions are denied and queued actions are
canceled.

When a page is deleted or moved to another Station, Vellum does everything
available at that actor tier to close its page, session, and owned
connections. When an actor node is deleted, Vellum does everything available
at that tier to stop the actor's Vellum-owned process and revoke its tools.

Actions already completed in an external system cannot be reversed. Failure to
terminate a resource must be visible; Vellum must not manufacture a successful
revocation receipt.

An unreachable Station necessarily continues under its last received intent.
Command Center must display that limit rather than claiming the new revocation
reached it.

## Enrollment and fleet reach

Host enrollment is always explicit.

Vellum may discover SSH, Tailscale, harness-owned, Vouch-managed, or other
resources and offer onboarding. Discovery alone does not:

- connect the resource;
- open an inbound port;
- install software;
- copy credentials;
- configure an agent harness;
- add a Station;
- add an execution edge.

Vellum starts with the strictest useful defaults. The operator may enable a
small, comprehensible set of atomic host capabilities. Existing operator-owned
connectivity may be used only after the operator enrolls the resource and
selects the relevant Vellum capabilities.

External and provider-managed resources are first-class factory facilities,
but Vellum presents the guarantees it actually owns. It must not display a
provider-controlled resource as though it were a Vellum-managed Station.
Runtime placement and provider capability remain legible because they affect
available ports and termination guarantees, not because Vellum requires a
special disclosure ceremony for an operator-owned resource.

### Command Center-to-Station protocol

Fleet coordination is a transport-neutral typed request/response protocol with
exactly five verbs: `pair`, `configure`, `project`, `report`, and `status`.
Browser operations are never Station API verbs. There is no Station-browser
protocol, browser PKI, or browser session-handle exchange on this wire.

The current transport adapter is OpenSSH. Command Center invokes the fixed
`vellum-station` command and exchanges one bounded JSON request on stdin for
one bounded JSON response on stdout. The helper connects to the Remote app's
owner-local control socket; the Remote main process validates the request and
owns every database transaction. SSH never writes settings, projections,
acknowledgements, status, or database files.

Tailscale (or other mesh/VPN) may supply network reachability to the enrolled
SSH endpoint. It is optional connectivity, not Vellum authority and not a
Station credential plane.

A future public transport, if shipped, is authenticated HTTPS — not plain
HTTP. That remains a future ship unit; the five verbs and their semantics do
not change with the adapter.

The owner-only socket is transport containment, not sufficient authority.
Remote main reads the socket's kernel peer PID and requires the peer itself to
be the exact packaged `vellum-station` executable under a bounded ancestry
containing the root-owned system `/usr/sbin/sshd`. Identity is exact executable
realpath plus file device/inode and pid/ppid/start epoch at every hop; process
names and client claims are irrelevant. Main takes a coherent observation
before reading caller JSON, then an identical fresh observation before decode
and before dispatch. Direct same-account socket clients and direct local
`vellum-station` invocations are denied before even `status` disclosure.
OpenSSH's authenticated operator account is the authority for this route; no
second Vellum credential or compatibility path exists.

Installation, host, factory, actor, and resource identifiers on this protocol
are routing facts, not credentials.

Authenticated transport does not grant role-promotion authority. The Station
wire's `configure` request contains only `RemoteConfiguration`; Command Center
configuration is a distinct local-main operation. Strict decoding rejects
unknown or retired credential fields rather than pruning them. Pairing refuses
an existing Command Center configuration, and local Command Center selection
refuses an existing pairing, transactionally. On Remote configuration the same
transaction removes all authorial canvas generations, so a Remote cannot retain
a dormant Command Center document plane behind its projection.

Projection transfer is complete and replace-only. Work and receipt propagation
uses route-local `(event_home, entity_home, seq)` identities and cumulative
acknowledgements. Retries send canonical Work rows after the last acknowledged
route sequence and are idempotent. A Command Center mutation homed on a Remote
remains a pending command until that Remote durably applies or causally rejects
it and returns an ordered disposition; transport ACK alone never materializes
it. Origin and received timestamps are retained for operator display; neither
is an ordering key. Tick phase and wall-clock drift can change propagation
latency, never ownership or ordering.

Role is never inferred, and an unconfigured installation rejects every work
mutation without writing an event or material row. Configured role and host
identity are immutable until an explicit transfer ceremony exists. Fleet
host-to-installation bindings follow the same rule: retirement preserves the
identity tombstone, exact reactivation is allowed, and fresh-install
replacement requires a new host identity.

A Remote may mutate only rows homed on its configured host. Actor inbox
messages are always Command Center-homed: a Remote cannot append an unscoped
inbox message, while host-local task and request history remains permitted.

Schedulers obey the same single-home law. A local tick evaluates only
schedulers homed on that installation. The current interval timer kind
coalesces missed intervals into at most one firing on wake. Any future
absolute-time or calendar timer must declare its stale/catch-up behavior as
part of its contract before it can ship.

## Credential ownership

Vellum is not a KMS and does not become the owner of credentials belonging to
the operator's operating system, network, harness, or provider.

- SSH configuration, private keys, known-host decisions, and agent state remain
  OpenSSH and operator-machine concerns. Vellum may invoke the operator's
  configured SSH client after explicit host enrollment; it does not import,
  copy, escrow, or reissue SSH private keys.
- Harness and provider credentials remain in their native harness or provider
  configuration. Vellum integrates with the authenticated tool; it does not
  absorb the provider's secrets.
- Tailscale identity and credentials remain owned by Tailscale and the
  operator's installation.
- Browser cookies and authenticated session data remain in the browser profile
  on the Station that hosts the page. Moving or recreating a page elsewhere
  does not copy or migrate that profile.
- Administrator passwords may cross Vellum only for one explicit privileged
  transaction, remain memory-bounded, and are never retained as fleet
  credentials.

Vellum may mint only credentials intrinsic to a Vellum-owned protocol, such as
owner-local control tokens or the minimum factory/Station pairing material
required by the final transport. Those credentials are narrowly scoped to
Vellum; they never substitute for general SSH, provider, operating-system, or
root credentials.

Before introducing a Vellum-specific credential, the design must show that it:

1. establishes a real boundary not already supplied by SSH, Tailscale, the
   operating system, or the provider;
2. materially improves security or operator ergonomics;
3. has a comprehensible creation, rotation, revocation, and recovery lifecycle;
4. does not duplicate an existing authentication step or create a ceremonial
   proof that the underlying system does not enforce.

If those conditions are not met, Vellum reuses the native authenticated
transport and adds no credential. Factory, Station, actor, and resource
identifiers are not secrets merely because they participate in routing.

## Privilege and machine safety

Root or administrator authority is a real boundary.

- Privileged mutation is bounded to an exact operator-requested transaction.
- Vellum does not retain an administrator password as ambient fleet authority.
- Installation and update inputs are verified before privileged mutation.
- Partial installs and updates are recoverable and honestly reported.
- Once an update candidate may have opened the current SQLite database,
  recovery is forward-only: Vellum retains or stops that candidate and never
  restores or launches an older bundle against possibly advanced state.
- Host-destructive APIs accept Vellum-owned resources or tightly bounded
  targets rather than arbitrary paths or PIDs.

These controls prevent catastrophic mistakes and corrupted input. They do not
exist to simulate isolation from the trusted operator account.

Remote machines are physical blast-radius boundaries. Enrollment of one
Station must not silently provide it reusable credentials or direct routes to
other Stations or Command Center administration.

## Browser and external-content boundary

Web content is untrusted even when the operator and attached agent are trusted.

Browser automation is host-local (Tier 2). The actor and the page node must
share the same installation. The enrolled host capability `"browser"` means
that installation may physically host browser pages and owner-local browser
control; it is not a remote RPC grant and never appears on the Station API.

There is no Station-browser protocol, browser PKI, projected browser trust,
Command Center browser session handle, or cross-installation browser relay.
A page on a Remote is driven only by actors and tools on that Remote.

Browser pages must remain isolated from Electron, Node, filesystem, shell,
canvas, fleet credentials, and other profiles except through explicit
Vellum-owned operations allowed by current intent.

An edge to a page grants the connected actor the represented operations on
that specific page node and session. The page may navigate or otherwise change
through ordinary use; the grant continues to follow that page. It does not
implicitly grant a full browser, profile administration, sibling pages, or
newly created pages.

Vellum should not add repeated confirmations after the operator deliberately
grants that page capability.

Vellum can promise:

> No agent lacking the required current edge on the same installation may
> control that browser surface through a Vellum API, CLI, socket, or
> automation surface.

Vellum cannot promise that arbitrary malicious same-user code, an operating
system compromise, or an unknown browser or kernel vulnerability cannot reach
the user's data by means outside Vellum.

## Termination promises by tier

- **Tier 1/2, Vellum-owned process:** revoke admission, request graceful
  termination, escalate within a bounded window when safe, and verify exit.
- **Tier 1/2, externally attached process:** revoke every Vellum capability and
  request termination; report honestly when lifecycle ownership is external.
- **Tier 3:** revoke protocol access, close Vellum connections, request
  provider or harness cancellation where supported, and report its result.
- **Tier 4:** no Vellum actor or execution authority exists.

Vellum only claims the termination strength available at the actor's tier.

## Security review discipline

Every security requirement and finding must begin with this doctrine.

Before adding a control, reviewers must answer:

1. What exact trust boundary is crossed?
2. Is the source actually controlled by an entity outside that boundary, or is
   this merely a trusted same-user hypothetical?
3. What executable path reaches what privileged sink?
4. What material operator or fleet harm follows?
5. What property will the proposed control genuinely enforce?
6. Does the control preserve operator intent without adding hidden authority,
   ceremony, or failure states?
7. Could a smaller control at an operating-system, physical-machine, provider,
   root, web-content, or package boundary provide the real protection?

Security reviews must distinguish:

- malicious external input;
- accidental or confused trusted-agent behavior;
- ordinary reliability failure;
- compromised physical machine;
- limits Vellum cannot enforce.

Review severity follows reachability and impact inside this threat model, not
the most adversarial imaginable model.

## Explicit non-goals

- Confining an arbitrary hostile process already running as the operator.
- Multi-user, team, tenant, or collaborator isolation.
- Station elections, consensus, CRDT intent, or decentralized canvas
  authority.
- Station-to-Station control or credential sharing.
- Inferring compromise merely because a Station is unreachable.
- Automatically repairing operator networking or fleet topology.
- Approval ceremonies that do not establish a real boundary.
- Claiming control over provider infrastructure Vellum does not operate.
- Claiming revocation reached an unreachable physical machine.

## Forbidden architectural residue

A release is blocked while any product path preserves:

- `.canvas` files, generation directories, manifests, pointer files, JSON
  settings/host/status files, seals, or drop files as live durability;
- topology keys, topology seals, hosts keys, or hosts seals;
- `incoming.frame`, `applied.ack`, or SSH writes/reads that substitute files
  for the Station API;
- direct database access from a renderer, headless CLI, helper, or second
  process;
- dual reads, dual writes, legacy imports, compatibility adapters, or a
  rollback path to a retired file store;
- Station merging, negotiating, electing, or vetoing Command Center intent;
- security requirements derived solely from a hostile same-user model;
- readiness or deployment ceremonies whose only protection is against a
  trusted same-user process.

There is no supported pre-SQLite state to protect or recover. If obsolete
storage code is found, it is deleted in the same change that exposes it.

## Open doctrine decisions

These questions remain intentionally open. Implementations must not resolve
them by accident:

1. Exact operator authoring lock, catastrophic-action reauthentication,
   factory/Station pairing, and recovery-code format.
2. Permanent Command Center loss and whether recovery material may reclaim
   Stations.
3. Exact Command Center transfer protocol and catastrophic-action
   reauthentication.
4. Exact Sink and scheduler taxonomy, ownership, and behavior while Command
   Center is unavailable.
5. Exact contents of a Station's scoped intent projection, including global
   resources.
6. The bounded set of operator-facing host capability controls and presets.
7. Intent-history retention and compaction policy. Coherent live backup uses
   SQLite `VACUUM INTO`; export remains an explicit operator output.
8. Provider-specific guarantees for harness-owned and managed-cloud actors.

Until decided, these remain product questions rather than invitations to add a
general distributed system or a stricter threat model.

## Release test

A production security claim is acceptable only when:

- the claim names the boundary it covers;
- executable code enforces it on every Vellum-owned path;
- tests exercise allowed, denied, revoked, stale, unreachable, and failure
  behavior proportionately;
- packaged artifacts prove the same behavior as source tests;
- the UI communicates external limits and degraded control honestly;
- the mechanism does not rely on an adversary already excluded by this
  doctrine;
- the operator can understand what authority exists and how it was created.

The goal is not maximum security machinery. The goal is a factory the operator
can trust because its power is deliberate, its boundaries are real, and its
limits are honest.
