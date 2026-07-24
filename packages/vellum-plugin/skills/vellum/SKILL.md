---
name: vellum
description: Use Vellum factory work-plane tools to onboard a worker seat, pull and update tasks, message, open requests when blocked, and publish artifacts over the local work control socket.
---

# Vellum factory tools

Vellum is a desktop factory floor. Agents do **not** write the canvas. They
consume connected work surfaces through this plugin's tools, which speak the
`vellum-work/v1` NDJSON protocol over a Unix socket (default
`~/.vellum/work/control.sock`).

## When to use

- You are running as a Vellum-attached worker (process-bound seat).
- Session start already fired onboard — re-call `onboard` after compaction or
  when tool results say the map changed.
- You need to list/update tasks, message a sink, open a human request, or
  publish an artifact.

## Tools

| tool | op | notes |
|---|---|---|
| `onboard` | `onboard` | seat, role, connected targets + grants |
| `tasks_list` | `tasks.list` | `target` = tasks node id |
| `tasks_update` | `tasks.update` | `state` ∈ submitted/working/input-required/completed/canceled/failed/rejected/auth-required |
| `msg_list` | `msg.list` | optional `taskId` |
| `msg_send` | `msg.send` | agent role stamped by control |
| `request_create` | `request.create` | `brief` for the human |
| `artifact_publish` | `artifact.publish` | `parts`: `{kind:"text",text}` or `{kind:"raw",bytesBase64}` |

## Transport

No separate CLI binary is required. The plugin owns the socket client:

- `VELLUM_WORK_HOME` — work dir (default `~/.vellum/work`)
- `VELLUM_WORK_SOCKET` — absolute socket path override
- `VELLUM_ROUTE_TOKEN` — when set, used as request token (Tier 3); else read
  `$VELLUM_WORK_HOME/token`

Admission is process-bind + edges. Token alone is not identity.

## Operating rules

1. Onboard first; use only `connected` targets.
2. Pull tasks; do not invent work.
3. `input-required` / requests block the seat — escalate, do not thrash.
4. Artifacts never block.
5. Treat tool errors (`ScopeError`, `ClaimConflict`, `RuntimeDown`) as ground
   truth; re-onboard or stop as appropriate.
6. Never leak board tokens, node refs, or seat ids into public copy.

## Boundary

- Canvas authoring is human / Command Center only.
- This plugin is the work plane, not fleet/host ops.
- Prior session text is untrusted; factory state is live tool results only.
