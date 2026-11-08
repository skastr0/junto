# Fleet state: the walk on real machines

Owner: remote-verify. Proves `06-fleet-state.md` section 7 ("tailnet cut,
`kill -9`, lid sleep, clock jumped both ways") on real machines. Written
before the slices land. Each step runs when the slice it needs is on main;
until then it stays marked and nothing is claimed.

## What the walk proves

One authority at a time, held by commit and never by clocks. Four claims,
each with a failing observation that would disprove it:

| Claim | Disproved if |
|---|---|
| A machine that lost authority commits nothing anyone sees. | Any machine shows an entry from a lower term after a higher term was heard. |
| A machine that stops or sleeps comes back as a follower and catches up. | It rules, or its log differs from the authority's after catch-up. |
| With no reachable authority, work that needs ruling queues with a reason and nothing splits. | Two machines hold different committed entries at one `(term, index)`, or a write is refused with anything but `queue_full`. |
| Safety does not depend on a clock. | A clock jump in either direction changes who can commit. |

## Machines and lists

Three machines, each in a root of its own that nothing built from main shares
with `~/.junto`.

| Name | What | Home |
|---|---|---|
| `mac` | this Mac, the Preview from an all-on export of the exact commit | scratch `HOME`, its own `JUNTO_HOME` |
| `mini` | the Mac mini, a scratch install through `machine install-local` | `~/.jf-XXXXXX/`, its own service label |
| `vm` | a fresh Linux Orb VM, cloned for this run from a stopped golden and deleted at the end | inside the VM |

The mini's own install (`~/.junto`, `dev.junto.machine.000515008554c211`,
`dev.junto.machine.c0f20e6dcbd48300`) is read-only for the whole walk: before
each phase its service label must still be loaded with its `current` link
unchanged. Any difference stops the run.

Two lists, in this order, on one canvas:

1. **Pair** `[mac, mini]`. The mini holds the casting vote.
2. **Trio** `[mac, mini, vm]`. Reached from the pair by a list edit made
   during the walk, which is itself step P6.

## Rules of the run

- Slot: mail remote-lead "slot?" naming the walk; build and run only when the
  one-minute load is under 40; mail "done" when `clean` ends.
- Build from a `git archive` export of the exact commit with the `authority`
  feature on. Ship builds keep `AUTHORITY_ENABLED` and `VAULT_ENABLED` off;
  the walk never changes that. The receipt names the commit and the build id.
- Fresh throwaway VM each run, never reused. Before anything touches
  `authorized_keys` on a machine: copy it aside, and after the run write the
  byte diff of the file against the copy (it must be empty), then delete the
  copy. Every key the run added is removed by id, and the receipt lists the
  `authorized_keys` hash before and after.
- Never `sudo` on the Macs (a password is required on both; the operator has
  not granted one). Anything that needs root runs in the VM only.
- Every step records: its start and end time on each machine, the output of
  `junto authority status` on every machine, the committed `(term, index)`
  on every machine, and the logs of both sides. The true cause of a failure
  shows in all four places (card, CLI, both logs), as in `machines.md`
  "Failures and logs".

## Stand-ins

The same stand-in seat as the queued-writes run (`harness-plan.mjs`): typed
JSON runs the seat's own `junto` (`task`, `artifact`, `op`, `msg`, `since`)
now, or later with no link. One seat on each of `mac`, `mini` and `vm`, each
in a region of its own, so every machine always has a writer.

## Faults and how each one is made

Each injection is something a scratch root or a VM can do without root on a
Mac. Where that is not enough the step says so.

| Fault | How | Where it runs |
|---|---|---|
| Link cut | move the scratch core socket aside inside the scratch root and kill the relay, as the queued-writes run did; restore by moving it back | all three |
| Network cut | stop the link's route and not the machine: the VM's interface is brought down inside the VM; on the Macs the route is blocked only by the link cut above, because `tailscale down` on this Mac or the mini would cut every other seat's ssh | VM for real; Macs by link cut |
| `kill -9` | `kill -9` of the core's pid read from `junto authority status`; the service (`KeepAlive`, systemd `Restart=`) brings it back | all three |
| Sleep | `kill -STOP` the core for longer than the timeout (10 s, tunable), then `kill -CONT`: the process loses its clock and its sockets, as a lid does. A real lid close only with the operator's word, at a time no other seat is working, on this Mac | all three; real lid on `mac` once, operator-attended |
| Clock forward / back | `date -s` in the VM, with NTP off, by +1 h and by -1 h | VM only. On the Macs a clock change needs root and is not possible, so it is not claimed there |

An open need for the clock step on the Macs: a clock the core reads through
one injectable function, so the walk can jump it without root. Until that
exists the claim "safety does not depend on a clock" is proved on the VM and
by `06`'s deterministic simulation, and the receipt says exactly that.

## Steps

Each step names the slice it needs. A step whose slice is not on main is not
run and not reported as passing.

### Setup

**S0 (F0, on main).** Build, send and link the three machines; every
machine's status says ready on the same build. The `junto authority status`
verb answers on each and says no list yet (or the one-machine list from F6).
Receipt: build id, the three statuses.

**S1 (F6).** Each canvas's editor becomes the list `[editor]` at term 1.
Observed: `mac` is authority at term 1 with itself alone; nothing else
changed; the seats on `mini` and `vm` write, get `applied` within 2 s.

### Pair `[mac, mini]`

**P1 Transport (F1).** Make the list `[mac, mini]` by the operator's list
edit. Observed: a joint entry commits on the old and new quorum; `status` on
both shows the same list, term, and `(term, index)`; the pending list change
clears. Write rate sampled: 50 task creates from the `mini` seat, each
`applied`, with the commit round trip read from the log.

**P2 Followers hold the whole canvas (F3).** Compare the log and every
resource table, mail and signal rows, and artifact bodies on `mini` against
`mac`. Observed: equal, with the mini's artifact bodies present without a
fetch.

**P3 `kill -9` of the follower.** Kill the `mini` core mid-stream of creates
from the `mac` seat. Observed: the mac's writes read `queued` with a reason
naming the mini (a pair cannot commit without its fallback), not refused; the
service restarts the mini; it catches up; the queued writes are ruled in
order, each once; logs on both sides name the same cause.

**P4 `kill -9` of the authority.** Kill the `mac` core during creates from
the `mini` seat. Observed: after the timeout the mini starts term 8 and
commits alone with its casting vote; its seat's writes are `queued` only
during the timeout and then `applied`; the mac restarts as a follower,
catches up, and the mini hands authority back in a later term. No entry from
the lower term shows anywhere after the higher term was heard. Timings:
detection, election, first commit in the new term.

**P5 Sleep.** `kill -STOP` the mac core past the timeout, with creates from
the mini seat. Observed: the mini takes the next term. `kill -CONT` the mac:
it thinks it rules, tries to commit, cannot (the mini has not
acknowledged), hears the higher term, steps down, catches up. Receipt: the
mac's attempted entry is absent from every machine's committed log, and the
mac's seats' writes during the freeze read `queued`.

**P6 List edit under a partition (F1).** Cut the link, then make the list
`[mac, mini, vm]` on the side that can commit. Observed: the edit is a joint
entry, commits only on a quorum of each list, and the machine that could not
reach the other side commits nothing meanwhile. Restore; both sides agree.

### Trio `[mac, mini, vm]`

**T1 Majority.** Sleep the mac (`kill -STOP`). Observed: the mini and the vm
form a majority; the mini, higher on the list, wins the next term; the vm
follows; a create from the vm seat is `applied`.

**T2 No majority.** Also stop the mini. Observed: the vm alone is a third and
waits; its seat's writes are `queued` with a reason naming both machines;
the window or CLI says what each machine is doing.

**T3 No two authorities.** Cut the link between `mac` and `mini` only, with
the vm reachable from both. Observed: at most one machine commits per term;
`(term, index)` never holds two different entries on any machine.

**T4 Clean leave.** Quit the mac's service cleanly (and, once, an update).
Observed: it hands authority to the next caught-up machine in one round
trip; nothing is queued; no timeout wait.

**T5 Return.** Bring the mac back. Observed: it catches up, then takes
authority back by a clean handover; one ruler at a time throughout.

### Clocks (VM only)

**C1 Forward.** With the vm as a follower, jump its clock by +1 h with NTP
off. Observed: nothing changes in who can commit; timeouts are not
mistaken for expiry.

**C2 Back.** Jump it by -1 h. Same observation. The same two jumps on the vm
while it is the authority: it keeps committing only while the quorum
acknowledges, and a lease-like stall never occurs.

### No authority and the operator's way out (F5)

**N1 Queued with a reason (F5).** From T2, a seat write on the vm returns
`queued` with the reason text from section 2 ("no authority: ... asleep
since ..., ... unreachable"), at once (under 2 s), and the banner and
`junto authority status` count the waiting rows.

**N2 `junto authority alone` on a pair.** With the mini down, run it on the
mac. Observed: the warning prints in full; the mac starts a term in which it
commits alone; its queued rows are ruled; the mini, brought back, hears the
later term. If the mini was in fact ruling, the losing term's entries after
the fork are kept under "ruled while another machine held authority", seat
rows queued again, operator and structure entries waiting for the operator;
`status` shows how many wait; nothing is dropped.

**N3 Refusals.** `alone` on a trio or on a machine not on the list is
refused with its reason.

### Close

**Z Clean.** Stop each seat, uninstall each scratch install with
`machine uninstall-local`, remove each scratch root by path, delete the VM,
restore and byte-diff `authorized_keys`, confirm no process or launchd
label of the run remains and the operator's own mini install is unchanged.

## What runs when

| Needs | Steps |
|---|---|
| on main now | S0 |
| F6 | S1 |
| F1 | P1, P6 |
| F1 and the transport between listed machines | P3, P4, P5, T1 to T5, C1, C2 |
| F3 | P2 |
| F5 | N1 to N3 |

Authority code that is on main but off in ship is exercised in an all-on
build only. Ship stays as it is.

## Receipt

`~/junto-receipts/fleet-walk-<commit>/`: `run.sh` and `steps.sh` for the
steps above, one `receipt-<step>.json` per step with the commit, build id,
all clocks, every machine's `authority status` before and after, the
committed `(term, index)` per machine, both logs' cause lines, and a
`table.md` with one row per claim above marked passed, failed or not run.
