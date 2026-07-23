# Remote station end-to-end checklist

This is the advanced operator proof for Command Center and Remote station
behavior on Linux and macOS. It tests the product contract, including degraded
and offline states. It does not turn a deployment receipt or an old heartbeat
into live telemetry.

## Health semantics

`vellum doctor` reports each registered Remote separately. Run it from an
attached Vellum agent/tooling process so process-bind admission is real.

- **Installed** comes from the Command Center's durable deployment receipt. No
  receipt is reported as no *managed* install receipt; it is not proof that an
  operator never installed Vellum by another route.
- **Reachability, role, and hostId** come from the current SSH probe of the
  registered endpoint.
- **Last pull** comes from the Remote's local station status. Pulls are manual;
  a record older than **24 hours** is stale but remains last-known truth.
- **Armed and last fire** come from the Remote's bounded kernel heartbeat. The
  kernel cycles at least every 30 seconds; a heartbeat older than **2 minutes**
  is stale.
- **Fleet-blind** means the Command Center cannot currently observe enough
  Remote state to make a live claim. Unknown is never converted to success.
- Doctor never returns canvas content, node IDs, agent identities,
  instructions, bearer tokens, or SSH credentials in the station projection.

Expected diagnostic distinctions:

| Observation | Expected Doctor state |
|---|---|
| Registered, no managed deployment receipt | Registered but not installed by Command Center |
| SSH endpoint unavailable | Unreachable + fleet-blind; last-known receipts remain labeled as such |
| Remote files missing or invalid | Fleet-blind or error, with the invalid surface named |
| Remote role or hostId differs from registry | Error; expected and observed identity shown |
| Kernel heartbeat is current, armed count is zero | Not armed |
| Last pull is older than 24 hours | Pull stale |
| Kernel heartbeat is older than 2 minutes | Kernel status stale |
| Kernel fault or orphaned arming exists | Explicit fault/orphan diagnostic |
| Command Center has zero registered Remotes | Clean local-only result; no invented Remote row |

## 1. Local-only Command Center

1. Start Vellum as `command-center` with hostId `local` and no registered
   Remote hosts.
2. On a test canvas, create one region, one local watcher or timer, and one
   local Hermes agent.
3. Draw a soft edge between the watcher/timer and the agent. Merely placing
   both nodes inside the region is not a delivery route.
4. Arm the region in the running app. Trigger the watcher or wait for the
   timer.
5. Confirm the pulse log records the correct source, live/dry state, and
   delivery result. Confirm the region instruction was appended to the routed
   pulse.
6. Remove the edge, trigger again, and confirm automatic delivery does not fan
   out through region membership.
7. Run Doctor. Expect the local station's installed/role/version/hostId,
   current armed count, and last fire; expect zero Remote rows.

## 2. Connected multi-host flow

1. Register a disposable Remote by its stable hostId and SSH endpoint.
2. Install and configure that host as role `remote`, using the same hostId.
   On Ubuntu 24.04 x86-64, install the qualified `deb`, then explicitly enable
   the packaged user service:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now vellum-remote.service
   ```

   On macOS, use the configured Remote deployment/LaunchAgent flow.
3. Pull the test canvas from the Command Center. Do not edit the Remote copy
   through an agent; the Command Center remains the authorial surface.
4. Put the watcher/timer and target agent on the Remote's hostId and connect
   them with an edge. Arm the containing region on that Remote.
5. Trigger the source while the Command Center is running. Confirm the Remote
   fires only its host-scoped source and addresses only an edge-connected
   same-host agent.
6. Run Doctor from the Command Center. Confirm the registered Remote row has:
   managed install state, role, version, observed hostId, last pull, armed
   count, last fire, reachability, and no hidden errors.
7. Change the registered endpoint in a disposable copy of the registry and
   confirm the old deployment receipt is labeled stale rather than attached to
   the new endpoint. Restore the registry afterward.

## 3. Offline Remote island

1. With the Remote healthy and its test region armed, stop only the Command
   Center. Keep the Remote station, Hermes, and its user service running.
2. Trigger a local-data watcher or local timer on the Remote. Confirm the
   edge-connected same-host agent receives the pulse without a Command Center
   RPC.
3. Exercise a watcher whose required fleet/private-source facts are
   unavailable. Confirm it remains unknown/stale and does not invent a rising
   edge or successful predicate.
4. Confirm no freeform `.canvas` write occurs. Kernel arming and edge-detection
   memory remain app-local; restart re-baselines watcher edges by design.
5. Restart the Command Center and run Doctor:
   - current SSH observations replace fleet-blind state;
   - the Remote's last fire is visible only if its bounded heartbeat is fresh;
   - last pull remains last-known and becomes stale after 24 hours.

## 4. Command Center cross-host route

1. While connected, put an executable source on the Command Center and an
   agent on a registered Remote, joined by a human-authored edge.
2. Trigger it from the Command Center and verify delivery uses the existing
   Hermes/Herdr/SSH transport hooks.
3. Verify the Remote did not evaluate the Command Center-owned source and no
   new Remote RPC or ambient region grant was involved.
4. Delete the edge and verify the route is revoked.

## 5. Failure drills

- Stop SSH or use an unreachable endpoint: Doctor must say unreachable and
  fleet-blind without erasing the last-known deployment receipt.
- Stop the Remote station for more than two minutes: kernel state must become
  stale, not remain “armed/live.”
- Leave the station running but disarm every region: Doctor must distinguish
  reachable from not armed.
- Age or inject a disposable last-pull record past 24 hours: Doctor must label
  it stale.
- Corrupt a disposable Remote `settings.json` or `station-status.json`: Doctor
  must fail closed and name the invalid surface without echoing raw contents.
- Register a host but do not install it: Doctor must retain a row for that
  host and explicitly report the missing managed install.

## Evidence to retain

For each platform, retain the Vellum version, OS/architecture, station roles
and hostIds, package/service status, redacted Doctor output, pull time,
arming/fire timestamps, pulse-log result, and the exact failure drills run.
Never include tokens, private keys, raw canvas content, or agent prompts.

Linux package qualification remains governed by
[`linux-package-qualification.md`](linux-package-qualification.md); the macOS
deployment-specific path remains in [`macos-remote-e2e.md`](macos-remote-e2e.md).
