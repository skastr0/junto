---
version: 1
slug: "src-renderer-components-capture-quickcapture-tsx"
primary_target: "src/renderer/components/capture/QuickCapture.tsx"
related_targets: []
---

# Quick capture (Cmd+T)

Mode: operate. Audience: the one operator, mid-task, writing anything from one line to a long working document. Job: write without losing a word, find any artifact, route a capture to its Artifacts node. Constraints: docs/plans/0.11/11-quick-capture.md for behaviour; the operator's rulings on 2026-10-29: the triage desk, sized like an Artifacts node window, and state that survives close, app quit and a reboot.

## Direction contract

THESIS: Capture is a desk, not a popup. Three columns (Inbox, the writing, where it goes) at the size of a node window, so long writing has room and routing is one key away. It refuses the small command palette split pane.

OWN-WORLD: Junto's dark and bright tokens unchanged. Raise frame, stroke hairlines between columns, overlay-2 for the focused row, amber 10% wash plus full amber frame for the chosen destination, cyan key caps, mono throughout, 14px title, 12px writing.

STORY: The operator presses Cmd+T, finds exactly what they left (same capture, caret, list, query), writes, presses 1, 2 or 3 to route it, and trusts that closing, quitting or rebooting loses nothing.

FIRST VIEWPORT: Workspace measure (1280px, clamped to the window) at the immersive height an Artifacts node opens at. Left 280px: search, then Inbox and Recent. Centre: head (where it lives, type, Saved) over the writing, whose first line is the title. Right 280px: Move to, three suggestions with a reason each, then Other node. Footer: key hints.

FORM: Triage desk, dealt structure 3 of 3 (option 2). seed:60ad34e8d00e0bdf

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
