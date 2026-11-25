# Node kind: files

**Role:** sink

A folder the operator opened on the canvas. Seats work in it with their own filesystem tools; Junto has no files command. A comment on a file reaches a seat as mail naming the node and a relative path; answer it with junto msg reply.

## Ports offered
- (none — access family only in v1)

## Data model
_Files node: one folder on one machine. The root never leaves that machine: onboard gives it to a seat there and only the node's name to a seat elsewhere._

- (no native node schema)

## Events
- (none documented)

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

_This kind carries no edge contract in v1._