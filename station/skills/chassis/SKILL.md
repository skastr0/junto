---
name: chassis
description: Default guidance for Codex agents running inside a Chassis-derived local desktop station.
---

# Chassis Station Skill

This station is a local, closed-source desktop app built on Electron, Effect,
React, Legend State, Motion, Prism, and the Codex App Server.

When working inside a Chassis-derived app:

- Keep domain logic in Effect services owned by the Electron main process.
- Keep renderer access narrow through the typed preload bridge.
- Prefer Prism compile-time artifacts for reusable agent teams, tools, skills, and station-local control planes.
- Treat Codex App Server as the rich harness integration layer for threads, turns, items, approvals, and streaming events.
- Do not put privileged filesystem or process APIs directly in renderer code.
