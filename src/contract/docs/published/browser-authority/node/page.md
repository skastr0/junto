# Node kind: page

**Role:** sink

The browser surface (feature-gated): page automation grants.

## Ports offered
- `browser.automate` — Control a granted page session (browser CLI).

## Data model
_Browser surface: admitted page sessions controlled via the browser CLI._

- `kind`: string
- `id`: string
- `x`: number
- `y`: number
- `width`: number
- `height`: number
- `z`: integer
- `color`: string
- `url`: string
- `profile`: string
- `onRemove`: string
- `label`: string

## Events
- page.load — page session navigation state
- browser.session — session open/close/detach lifecycle

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

These examples cover the offered ports; your live edge may grant fewer.
```
### Contract — browser (target `<page-node-id>`)

| intent | command |
|---|---|
| list granted pages | `junto browser pages` |
| open a granted page | `junto browser open <node-ref>` |
| navigate | `junto browser goto <sessionId> <url> [--tab <tab>]` |
| inspect | `junto browser eval <sessionId> <code> [--tab <tab>]` |
| capture | `junto browser shot <sessionId> [--tab <tab>]` |
| comment on a box | `junto browser comment <sessionId> --box x,y,w,h --text "..." [--tab <tab>]` |

`browser.automate` is a live edge grant realized by `junto browser` from
the managed agent's existing shell. Existing sessions may use it immediately
after an edge appears — re-run `junto capabilities` for the current command.
```