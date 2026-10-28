# The needs-you feed holds the operator's work

Owner: product-lead. Asked by the operator 2026-10-28, to start at once.

## Target

The needs-you feed is where everything that depends on the operator waits,
not only what seats escalate. An automation can raise a signal: a monitor
found something, a cron says it is time for today's writing. A signal can
ask the operator to produce something, and the operator produces it right
in the signal: writes the post in the editor, types the API key into the
region's secret store, attaches proof. The operator's baseline work for the
day is done when the feed is empty.

Examples the operator gave: write 500 words every day; five posts across
social media, one signal each, each with a strict reply condition; read ten
pages of the planned reading, the signal showing the artifact to read; a
monitoring script finds a result and raises a signal; a seat needs API keys
or a Cloudflare secret and the operator supplies them in the signal.

## Today (receipts)

- Signals are raised by seats only, three kinds: `escalate`, `blocked`,
  `feedback` (`src/shared/wire/agent-signals.ts:16`), states `open`,
  `answered`, `dismissed`, `withdrawn` (`:20`).
- The feed: `src/renderer/components/feed/OperatorFeed.tsx`; replies:
  `src/renderer/components/signals/SignalReply.tsx`, quick replies.
- Region secrets: `src/shared/region-secrets.ts`, values per machine
  (`docs/machines.md` Rule 9).

## Decisions (product-lead)

- **Automations raise signals.** A new action, `signal`, raises a signal
  whose source is the automation, not a seat. Its title and detail may name
  values (`05-automations.md`).
- **Two new kinds.**
  - `notice`: something happened, read it and clear it. A monitor's
    result, a run that finished.
  - `work`: something the operator must produce. It stays open until its
    reply meets its condition; dismissing it is a separate, deliberate act.
- **A signal may carry a reply form**, one per signal in the first version:
  - `artifact`: the Markdown editor in the signal (`LiveMarkdownField`); the
    reply becomes a document in a named Artifacts node, titled from the
    signal, labels from the signal. Condition: at least N words.
  - `secret`: a secret field; the value goes into the named region secret
    on the machine that needs it and nowhere else. Never in mail, a log, the
    signal's text or its history: the signal records only that the secret
    was set.
  - `proof`: text plus links or files as proof of work.
  - `text`: today's reply.
- **A signal may show artifacts**: the reading for today, the brief for a
  post. They open from the signal.
- **Seats ask for the same forms.** `junto blocked` and `junto escalate`
  can ask for a secret, an artifact or proof, so a seat that needs an API
  key gets it through the feed.
- **An empty feed reads as done.** The empty state says the day's work is
  done, plainly.
- **Out of the first version:** webhooks as a source (they come with
  webhooks), forms other than the four above, several forms in one signal.

## Tracks

| Track | Owner | Reviewer |
|---|---|---|
| N1 contract: source automation, kinds `notice` and `work`, the reply forms and their conditions, how a reply is ruled (artifact created, secret stored, proof kept) | product-feed | automation-lead, remote-lead (secrets, crossing) |
| N2 the `signal` action in automations, with values | automation-lead | product-feed |
| N3 the feed: the new kinds, the embedded editor, the secret field, proof, shown artifacts, the condition as it fills, the empty state | product-automations | product-cron, product-accessibility, product-typography |
| N4 CLI: seats ask for a form; overseer automations raise signals | cli-lead | cli-protocol |
| Verify: a daily cron raises "Write 500 words"; the operator writes it in the signal; the artifact exists; the feed empties. A seat asks for a key; the operator sets it; the seat reads it. Dark and bright. | product-verify | |

N2 to N4 build on a stand-in of N1's names and switch when it lands.

## Urgency (operator, 2026-10-28)

`notice` and `work` follow the urgency framework, the one ladder in
`src/shared/wire/urgency.ts`. Today it describes seats only: who is blocked
or waiting. The operator's own work can be urgent to them without blocking
anyone else, so the ladder gains three levels:

- **`due`**, between `escalated` and `review`: work the operator marked
  urgent, or whose due time has passed. Urgent to the operator, blocking
  only them.
- **`todo`**, between `review` and `done`: open work, not yet due.
- **`notice`**, between `done` and `degraded`: something happened, read it.

A `work` signal carries an optional due time and an urgent mark, set by
whoever raises it (an automation, a seat, the operator); it moves from
`todo` to `due` when either applies. The ladder stays the only order
(`tests/urgency-law.test.ts`), and the phone carries the new levels.

## Secrets: a vault, 1Password first (operator, 2026-10-28)

This replaces "The secret form crosses machines" (4f18819e3, 818ea1bd8):
the operator does not want Junto carrying a typed value between machines.
Rule 9 stands as it is: it protects secrets already on a machine.

- **A vault contract.** Junto names a vault, not a value: a region secret
  may be a reference into the vault. Each machine resolves it with its own
  access when it needs it (a code step, a seat's environment). The value
  travels through the vault, never through Junto.
- **1Password is the first backend**: a vault and a 1Password service
  account the operator sets up once per machine; Junto calls the `op` CLI
  with it. Today's machine-local store stays as the other backend.
- **The secret form writes to the vault** from the operator's machine: the
  operator types the value, Junto stores it in the named vault item, and the
  asking machine reads it through its own service account. The signal
  records only the item, the region and when it was set.
- **Without a vault set up**, the form says so and offers today's local
  store on the machine the window runs on. Nothing crosses.
- **remote-security's conditions that still apply**: the form names who
  asks (machine, seat or automation, region, secret name); only a secret
  the region declares; the window keeps nothing (no draft, view state, undo,
  log); scrubbed from every log and error.
- **Lower priority than the rest of N1 to N4.** If it grows complicated, the
  secret form waits; artifact, proof and text forms ship without it.
- **Out:** Junto's own encrypted store that syncs across machines.

| Track | Owner | Reviewer |
|---|---|---|
| N5 the vault contract and the 1Password backend (`op` with a service account per machine), region secrets as vault references, the secret form writing to it | remote (remote-lead places) | remote-security, tech-lead |
