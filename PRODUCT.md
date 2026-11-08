# Product

<!-- impeccable:product-schema 1 -->

Source: written by product-design on 2026-10-29 from the repository's own product record (docs/brief.md, AGENTS.md, docs/how-junto-works.md, docs/plans/0.11/11-quick-capture.md), not from an interview. Every line below is inferred from those files; the operator may correct any of it.

## Platform

web

Electron desktop app (macOS 13+ on Apple silicon; Linux alpha). The renderer is web, so web conventions apply.

## Users

One operator running several coding-agent CLIs at once (Claude Code, Codex and others) on one machine, for hours at a stretch. They watch a canvas of agent seats, answer what needs them, and move work between agents and documents. Built for one person, not a team (docs/security-doctrine.md).

## Product Purpose

Junto puts coding agents on one canvas and lets them talk. Seats keep their harness, folder and session across restarts; agents mail each other only over lines the operator drew; the canvas shows who is working, idle or waiting on the operator. Artifacts (documents, pads, sheets, links, files) are where the operator and the agents keep their writing. Success: the operator never relays text between terminals, never loses track of who needs them, and never loses a thought.

## Positioning

The operator draws the reach: an agent can talk only along a line the operator drew, locally, with no account. One canvas holds the agents, their mail, their tasks and their documents together.

## Operating Context

The operator is mid-task in a terminal or on the canvas when a thought arrives. Keyboard first: Cmd+K searches and acts, Cmd+I opens the needs-you feed, Cmd+T opens quick capture. Long sessions, mostly in dark, on a laptop or a large desktop display.

## Capabilities and Constraints

- Quick capture (Cmd+T) is the operator's second brain: it opens straight into a new Markdown document with the caret in it, saves on every keystroke into an Inbox Artifacts node, searches every artifact with previews, edits one in place, and routes a capture to the right Artifacts node with suggestions (docs/plans/0.11/11-quick-capture.md).
- One token source for the whole renderer, dark and bright (src/shared/theme, DESIGN.md).
- Copy law: no middle dots anywhere. Motion law: visible motion is never slowed, stepped or stilled; it runs on the compositor (AGENTS.md, tests/motion-law.test.ts).
- The UI shows what needs the operator and stays out of the way otherwise (AGENTS.md, Attention).

## Brand Commitments

- The product name is Junto, in every public and runtime string.
- Operator copy is plain spoken English that names the action, never the mechanism (ports, grants, masks).

## Evidence on Hand

- docs/brief.md: receipts for mail, reach and signing.
- Real-app frames of every surface come from the product-verify and product-automation seats; no customer testimonials, metrics or pricing exist and none may be invented.

## Product Principles

- Show what needs the operator; everything else stays quiet.
- Keyboard first, and every keyboard path has a visible equivalent.
- Nothing the operator writes is ever lost.
- One visual language across every surface: a new surface joins the system, it does not start a new one.

## Accessibility & Inclusion

Every control is keyboard reachable with the house focus ring; text meets 4.5:1 in both themes (scripts/theme-build.ts fails under it); visible motion respects the motion law.
