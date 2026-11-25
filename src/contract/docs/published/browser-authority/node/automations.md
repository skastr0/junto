# Node kind: automations

**Role:** sink

Automations: triggers, conditions and actions the editing machine runs, in place of the old cron, relay, watcher and timer schedulers. A seat reads the ones in its reach with `junto automation list`, `show` and `history`; only the operator and overseers write them.

## Ports offered
- (none — access family only in v1)

## Data model
_Automations node: each automation has a schedule, poll or change trigger, conditions in `when` and actions in `then`, and is created off unless enabled. Firings are kept as history, each with its actions' rulings or why it was skipped._

- (no native node schema)

## Events
- (none documented)

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

_This kind carries no edge contract in v1._