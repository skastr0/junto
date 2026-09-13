# Live conversations with your Overseer

GPT-Live-1 provides voice for a **Vellum Command Overseer** managed agent. A
separate OpenAI backend model interprets delegated requests and uses the existing
Overseer tools. The human-granted seat remains the authority for every action.

This guide describes the source implementation. Provider calls, packaged
microphone behavior, and desktop acceptance require separate qualification;
the implementation matrix below does not claim those checks have passed.

## Set up a call

1. In **Settings → Providers → OpenAI live conversation**, enter your own OpenAI
   API key. Set the backend model, maximum call minutes, and voice limit per call,
   then choose **Save live settings**. The default backend is `gpt-5.4`; the voice
   model remains `gpt-live-1`.
2. On the local Command Center, create an agent seat using the
   **Vellum Command Overseer** harness and open its managed session.
3. Select that agent and choose **Grant overseer** in the bottom command strip.
   Only the human can grant or revoke this authority. Ordinary workers do not
   inherit it when the Overseer creates or prompts them.
4. Choose **Start live conversation** in the selected seat's command strip to
   open its panel. The microphone is still off. Choose **Start live conversation**
   in the panel to begin, and allow microphone access when the operating system
   asks. Settings and selection do not start a call.

The OpenAI key stays in the installation's existing credential vault. Settings
show only whether it is configured; saved keys cannot be revealed in the
renderer. The key is delivered to the authenticated native backend only for its
assigned run. It is not placed in the canvas, command-line arguments, or durable
request journal.

Voice and backend charges are separate. The current app estimates voice at
$0.05 per minute and accounts for the provider's initial 15-second billing
minimum. Defaults allow 30 minutes and $1.50 of estimated voice per call. The
first duration or voice-estimate limit ends the call. This is a per-call voice
control, not an OpenAI account spending limit or a cap on backend token charges.
Limits are captured when a call starts; save changes before the next call.

## Talk about actual work

Start with a question such as “What is happening on this canvas?” Selection is
attention context. Canvas, task, and agent facts come from main-owned services.
A reference such as “this agent” uses the selection captured for the request,
not a later selection after the backend finishes thinking. The current renderer
sends canvas selection only; it does not continuously supply unsaved editor text,
viewport geometry, or terminal output.

The transcript is conversational evidence. Transcription alone does not execute
an action: a Live delegation assembles the received speech with captured context
and creates a durable application request. Repeated provider event and delegation
identities do not create another request.

Canvas operations appear through the normal committed canvas update path.
Structural batches can create, configure, and move nodes and edit legal edges on
one canvas in one commit. They cannot grant Overseer authority, replace an entire
document, delete nodes that need resource teardown, change native resource
identity, or combine task creation and external execution into a single
transaction.

## Read action outcomes precisely

The action history distinguishes proposal, admission, dispatch, application, and
failure. An operation marked **unknown** requires checking the target's actual
state before retrying; a disconnected transport does not prove nothing happened.
There is no general exactly-once guarantee and no automatic replay of uncertain
native effects.

These are separate facts:

| Outcome | What it establishes |
| --- | --- |
| Task created | The task exists in its owning Work service. |
| Prompt delivered | Input reached the worker's prompt-delivery path. |
| Worker accepted | A correlated acceptance event or verified Work transition exists. |
| Worker completed | The relevant task/result state establishes completion. |
| Backend completed | The controller's reasoning run ended; this does not prove a worker finished. |

## Control voice and work separately

| Control | Effect |
| --- | --- |
| **Return to canvas, keep call** | Minimizes the panel to a control rail. The call continues while you select other nodes. |
| **Mute** / **Unmute** | Disables or enables microphone transmission. Playback and pending requests continue. |
| **Enable audio** | Retries playback when the browser requires a user gesture. |
| **End call** | Releases microphone and playback and closes the provider session. Queued/running requests and their receipts remain available. |
| **Correct request** → **Send** | Revises that request and captures current selection for the correction. Pending operations for the obsolete intent can no longer admit or commit. |
| **Cancel request** | Fences one request and signals its controller run to stop. It does not undo committed changes or establish that a previously prompted worker stopped. |
| **Stop actions** | Closes the session's admission gate and fences pending controller work. Use a fresh call for new authority admission. |
| **Revoke overseer** | Removes the human grant from the seat. A revoked or replaced occupant cannot continue using the old Live session. Granting authority again requires fresh admission. |

The microphone, playback, controller, and request indicators describe independent
activity. The application can receive speech while a request is running.

Speaking over the voice response can interrupt speech. It is not a cancellation
of a request or a worker. Corrections only prevent an action once the application
has received and applied the correction. An already committed change requires a
separate valid operation to reverse it.

## Recovery and scope

Requests, operations, and outcomes are stored in the app-owned SQLite journal.
Raw microphone and playback packets are not recorded. Startup marks former active
sessions and pending requests interrupted. Operations admitted or dispatched
without a settled result become **unknown** and require reconciliation. Startup
does not replay them or reconnect a microphone.

The native Live controller is currently local-only. Other managed harnesses keep
their existing terminal/ACP behavior; prompt delivery to those harnesses does not
make them structured Live controllers. Station protocol remains version 1. The
Live integration does not add a new Remote authoring tunnel.

The [controller's tool catalog](../src/overseer-host/tools.ts) exposes canvas,
node, edge, task, and agent operations. Board, pad, and artifact access in this
catalog is observational. It does not expose the entire Overseer catalog or
administrative settings. Worker permission dialogs remain on their existing
surfaces; a “waiting for approval” indicator does not approve anything.

Context is bounded: up to 48 nodes, 96 edges, and 12 tasks per node fit inside
32 KiB. Selected nodes and their neighbors come first. Counts and omission
markers identify partial context so the backend can retrieve exact targets before
acting. Quiet voice context uses at most 500 UTF-8 bytes and excludes draft text.

## Implementation and acceptance evidence

“Implemented” below describes the code path. Test links identify relevant
coverage, not a claim that a paid API call or desktop qualification ran.

| Area | Implemented behavior and source | Acceptance boundary |
| --- | --- | --- |
| Credentials and limits | [Settings](../src/shared/settings.ts), [vault projection](../src/main/vellum-command/credentials/project.ts), [provider settings UI](../src/renderer/components/settings/ProvidersSettingsSection.tsx) | [Settings and vault coverage](../tests/live-settings.test.ts) verifies write-only OpenAI projection, limits, rotation, and reset. |
| Media and readiness | [Renderer media owner](../src/renderer/lib/overseer-live-media.ts) keeps microphone tracks disabled until provider startup and main readiness; teardown releases tracks, data channel, peer, and playback. | Real operating-system permission, device, audio routing, and long-call behavior require desktop qualification. |
| OpenAI transport | [Connection adapter](../src/main/vellum-command/overseer/live/openai-connection.ts) creates one client-delegated WebRTC session and main-authenticated sideband, closes explicitly, and reports uncertain finalization. | [Transport tests](../tests/overseer-live-openai-connection.test.ts) use injected transports. Account access and real provider connectivity require a paid call. |
| Request assembly | [Transcript journal](../src/main/vellum-command/overseer/live/transcript.ts) preserves event identities, captures context at delegation, and rejects duplicate, empty, or stale delegations. | Transcript deltas have no authoritative turn-completed event. A missing delta never authorizes a speculative write. |
| Semantic context | [Context projection](../src/main/vellum-command/overseer/live/context.ts) separates committed facts from attention and bounds selected graph/task data. | Viewport and draft contracts are supported when supplied; the current renderer supplies selection only. The bounded view is not a complete task or terminal history. |
| Native backend | [Controller loop](../src/overseer-host/session.ts) uses the Responses API with serialized typed tools and a bounded reasoning run. [Tool catalog](../src/overseer-host/tools.ts) includes explicit request correction, cancellation, and stop-action commands. | A completed controller turn is not worker completion. Additional external harness adapters and Remote controllers are outside this implementation. |
| Operator controls | [Live panel](../src/renderer/components/live/LiveConversation.tsx) provides microphone, call, request correction/cancellation, and stop-action controls separately. | View selection updates while minimized; the panel does not move the operator's viewport. |
| Authority and intent | [Execution constraint](../src/main/vellum-command/overseer/live/execution.ts), [journal](../src/main/vellum-command/overseer/live/repository.ts), and [Work control](../src/main/vellum-command/work/control.ts) retain process-bound admission and add request/occupant/authority constraints. | Grant/reseat/correction races must be checked at dispatch and in the owning transaction. Renderer seat coordinates are not credentials. |
| Structural editing | [Batch authoring](../src/shared/overseer-authoring.ts) and [canvas owner](../src/main/vellum-command/overseer/canvas.ts) validate a bounded graph change and commit once. | [Canvas command coverage](../tests/overseer-canvas-commands.test.ts) exercises legal batches and authority/resource restrictions; native dispatch remains separate. |
| Durable recovery | [Live journal](../src/main/vellum-command/overseer/live/repository.ts) stores immutable operation argument hashes and interrupted/unknown outcomes. [Migration 22 → 23](../src/main/vellum-command/state/migrations.ts) adds journal and OpenAI binding tables. | Installed rows and the released credential table remain intact. Restart requires fresh admission and does not replay work. |

The governing authority boundaries remain in the
[security doctrine](security-doctrine.md), [Overseer plan](overseer-plan.md), and
[operation coverage matrix](overseer-coverage-matrix.md).
