# Node kind: terminal

**Role:** sink

A terminal resource sink (v1 access family only).

## Ports offered
- (none — access family only in v1)

## Data model
_Terminal resource: PTY session surface._

- `kind`: string
- `id`: string
- `x`: number
- `y`: number
- `width`: number
- `height`: number
- `z`: integer
- `color`: string
- `label`: string
- `host`: string
- `bindingId`: string
- `launch`: object

## Events
- terminal.session — PTY attach/detach lifecycle

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

_This kind carries no edge contract in v1._