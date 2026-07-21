<p align="center">
  <img src="assets/brand/vellum-command-icon.png" alt="Vellum Command" width="160" height="160" />
</p>

<h1 align="center">Vellum Command</h1>

<p align="center"><strong>Run your agent fleet from one spatial board.</strong></p>

<p align="center">
  Managing agents on macOS is overwhelming — terminals stay opaque, the fleet spreads across panes and hosts, and status lives nowhere you can trust.<br />
  <strong>Vellum Command</strong> puts the whole station on one deep-field canvas.
</p>

<p align="center">
  <a href="https://github.com/skastr0/vellum/releases/latest"><strong>Download for macOS</strong></a>
  ·
  <a href="https://vellumcommand.com">vellumcommand.com</a>
</p>

---

## The pain

Managing agents is overwhelming.

- **Terminals stay opaque** — signal buried in scrollback; hard to read, harder to operate at scale
- **The fleet scatters** — local and remote agents become an unmanageable pile of panes and hosts
- **Status lives nowhere** — running, blocked, waiting, and done never share one surface

## The station

**Vellum Command** lays your Hermes fleet, Herdr terminals, browser pages, and agent work on one portable spatial canvas — so **you author the board** and the fleet acts through a real work plane.

### Why operators choose it

- **One spatial board for the whole fleet** — agents, work, and regions as geography, not a pile of windows
- **Herdr terminals made legible** — operable on the canvas, not buried in a dock of tabs
- **Hermes multi-agent presence** — who is up, blocked, waiting, or done, live on the board
- **Multi-host / multi-fleet over SSH** — without a second remote tool to babysit
- **A2A work plane** — tasks, requests, input-required, messages, and artifacts with protocol, not chat chaos
- **Vellum CLI** — control surface agents use so work happens without freeform canvas thrash
- **Browser pages as first-class nodes** — same plane as agents and terminals
- **Regions, pulse, and watchers** — operational geography; the document is the product (portable JSON Canvas)

### Is / is not

| Vellum Command **is** | Vellum Command **is not** |
|---|---|
| A deep-field command station for agent fleets on macOS | Another chat app or prompt playground |
| A spatial canvas humans author; agents act through the work plane | A free-for-all where agents rewrite your board |
| A portable JSON Canvas document the app projects | A multi-platform toy chasing every OS |

## Download

**[Download the notarized macOS build →](https://github.com/skastr0/vellum/releases/latest)**

Requirements: **macOS 13+** (arm64 primary). Install **Hermes** and **Herdr** for live fleet and terminal features; browser nodes ship with the station.

Prefer source?

```bash
bun install
bun run app:build
bun run app:install:skip-build
```

## Vellum CLI

Talk to the live station without hand-editing canvas files:

```bash
vellum ping              # is the station up?
vellum doctor            # what can this host do?
vellum capabilities      # edge contract
vellum onboard           # join the work plane
vellum tasks …           # drive A2A tasks
vellum msg …             # messages between agents
vellum request …         # requests / input-required
vellum artifact …        # artifacts on the board
```

Human authorship stays on the board. Agent work stays on the control plane — stable commands, not scrollback ritual.

## Brand

Deep-field instrument: warm near-black ground (`#0B0A08`), parchment ink (`#EDE6DA`), amber signal (`#E6A94A`). Factory and cartography — not a chat app. Product language lives on [vellumcommand.com](https://vellumcommand.com).

Visual identity: [`assets/brand/IDENTITY.md`](assets/brand/IDENTITY.md) · mark: [`assets/brand/vellum-command-icon.png`](assets/brand/vellum-command-icon.png)

## License

MIT © Guilherme Castro. See [`LICENSE`](LICENSE).

## Security

Report security issues privately. See [`SECURITY.md`](SECURITY.md).

## Contributing

Issues welcome with enough context to reproduce. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
