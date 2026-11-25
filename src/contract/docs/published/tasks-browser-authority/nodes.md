# Node kinds

Every node kind on the canvas, its role, and the ports it offers.

| kind | role | offers |
|---|---|---|
| agent | actor | msg.list, msg.prompt, msg.send, seat.wait, terminal.read, threads.read |
| page | sink | browser.automate |
| task | sink | (none) |
| automations | sink | (none) |
| files | sink | (none) |
| terminal | sink | (none) |

A seat holds every command of a resource in its reach, by its kind, and a seat's ports over an edge to it.

Get one node kind in depth: `junto docs node <kind>`