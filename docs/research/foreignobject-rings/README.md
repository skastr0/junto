# Rings inside a pad card's foreignObject

Question (motion sweep, operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8): a pad
card draws the preview card, rings included, inside an SVG `<foreignObject>`
(`PadCardShape.tsx`). Does Chromium composite a ring there, and does the
ring stop when no one can see it?

Run 2026-10-29 in the app's Electron 43.8.4, load under 40, one process per
case: `CASE=<name> electron composite-lab.js` and `electron observer-lab.js`.

Compositing (the `Animation` trace event's `compositeFailed`, a spinning
transform part):

| case | compositeFailed |
| --- | --- |
| plain HTML, on screen | 0 |
| inside foreignObject, on screen | 0 |
| inside foreignObject placed outside its svg | 131072 (not composited) |

IntersectionObserver, root null and no margin, as ActivityMark watches:

| case | isIntersecting |
| --- | --- |
| foreignObject on screen | true |
| foreignObject outside its svg | false |
| foreignObject in a group panned out of the svg | false |
| svg itself out of the window | false |

Verdict: no change needed. A ring a pad card shows composites like any other.
A ring panned out of the pad, or out of the window, is reported not
intersecting, so ActivityMark already takes its parts off and nothing runs
in the case that would not composite.
