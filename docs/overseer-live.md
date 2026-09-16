# Live Overseer proof of concept

GPT-Live-1 is the voice interface to a local **Junto Overseer** seat.
The POC answers questions about the current canvas and creates, renames, moves,
resizes, and connects nodes. A separate configurable backend model selects the
existing typed tools; the running app applies edits through its canvas owner.

This feature is **off by default**, including normal development and ship builds.
It is enabled only by `VELLUM_COMMAND_LIVE_OVERSEER=1` or the explicit `all-on`
test profile. Turning it off hides the controls and provider settings and blocks
the controller, IPC, Work route, and microphone permission. Stored rows remain
readable under the same product schema.

## Start it

From the repository, build the native controller with the flag, then start the app:

```sh
VELLUM_COMMAND_LIVE_OVERSEER=1 bun run cli:build
VELLUM_COMMAND_LIVE_OVERSEER=1 bun run dev
```

1. In **Settings → Providers → OpenAI live conversation**, save your OpenAI API
   key. The key uses the existing credential vault. Choose a backend model your
   account can use; the default is `gpt-5.4`, independently of `gpt-live-1`.
2. On the local Command Center, create an agent with the **Junto
   Overseer** harness and open its managed session.
3. Select the seat and choose **Grant overseer** in the bottom command strip.
4. Choose **Start live conversation**, then start the call inside the panel and
   allow microphone access. Granting authority alone never starts the microphone.

For an experimental packaged build, pass `VELLUM_COMMAND_LIVE_OVERSEER=1` to
`bun run app:build`; it must be present at build time. Setting it after launching
an ordinary packaged build does not enable the feature.

## A short demo

- Ask: “What is happening on this canvas?”
- Select a note and say: “Move this 200 pixels to the right.”
- Say: “Create a note called Launch checklist next to it.”
- Ask: “What did you just change?”
- Try **Correct request** while a request is pending, or **Cancel request**.
- Mute, unmute, end the call, and start another call on the same seat.

Changes appear when the app commits them. The action rail records outcomes and
can highlight affected nodes without moving your viewport. A request uses the
selection captured when it arrived. Follow-up requests retain completed backend
conversation context while the app stays open.

## Controls

| Control | Behavior |
| --- | --- |
| Mute | Stops microphone transmission; the current request can continue. |
| End call | Releases audio and closes the voice connection; admitted requests can finish. |
| Correct request | Replaces a pending interpretation and prevents its obsolete edits. Already committed edits require a new request. |
| Cancel request | Stops that controller request; committed changes remain. |
| Stop actions | Blocks further edits for the session. Start a fresh call to re-enable actions. |
| Revoke overseer | Removes the seat’s authority and stops the Live session. |

Voice time and estimated cost are visible. Defaults cap a call at 30 minutes or
$1.50 of estimated voice usage, whichever is reached first. Backend usage is
additional. The app does not record raw audio.

## Deliberate POC limits

- One local native controller on Command Center. No Remote controller or other
  harness adapters.
- Canvas editing and inspection only. No worker dispatch, task mutation,
  credential changes, authority grants, or resource deletion through Live tools.
- Semantic canvas context and selection. No screen/video stream or draft editor
  tracking.
- Restart shows interrupted requests and uncertain actions; it does not replay
  them or automatically resume a call. Conversation continuity across app
  restarts is deferred.
- The full fleet/worker plan remains future work. This is a local POC, not a
  production release.

## Verification

`tests/overseer-live-service.test.ts` runs the real canvas and SQLite owners from
transcript/delegation through the backend tool loop, graph commit, atomic receipt,
and spoken feedback. It covers duplicate delegation, reconnect, corrections,
revocation, concurrent operator edits, follow-up context, and the restricted tool
set. The provider and backend response are injected in these tests.

`tests/features-live-overseer-gate.test.ts` checks the default-off boundary.
The Live scenario in `e2e/scenarios/design-audit.spec.ts` exercises the desktop
controls with injected media and provider responses.

A real GPT-Live call remains the final operator smoke test after entering an API
key. Automated tests do not establish account access, actual audio quality, or
model latency.
