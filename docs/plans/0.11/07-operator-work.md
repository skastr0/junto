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

## The secret form crosses machines (operator, 2026-10-28)

**Decided by the operator when they asked for this feature, relayed by
product-lead.** A secret typed into a seat's or an automation's signal is
stored in that region's secret store on the machine that asked, which is
mostly the mini or a VPS while the window runs on the MacBook. That is a
crossing Rule 9 did not allow, and this is its one exception. Shape
(remote-lead):

1. **Never a row.** The value is never in a signal row, a reply, mail, the
   exchange, the canvas log or a copy. The reply records only the secret id,
   its name, the machine and when it was set.
2. **One direct delivery.** The window hands the value to its own main
   process, which sends it once as an owner-only `secret.deliver` frame
   straight to the asking machine over that machine's key-bound link (S5),
   never through a keeper or relay. The asking machine puts it into its
   region secret store and answers stored or refused. Nothing is kept on the
   way: no queue, no retry, no draft, no undo entry, no renderer state after
   sending, and the frame is in no trace or log.
3. **Only what was asked, once.** The asking machine takes a delivery only
   for an open secret request its own seat or automation raised, for the
   secret id its region names. The request closes when the value is stored.
   Anything unasked is refused.
4. **Unreachable means not now.** If the asking machine is not linked, the
   form says so and keeps nothing. The signal stays open.
5. **Same machine, no crossing.** When the window's machine is the asking
   machine, the form is today's local put.
6. **Doctrine.** Rule 9 gains this one crossing, and the security doctrine
   gains the frame and its admission, reviewed by remote-security.

remote-security's conditions, part of the shape:

- **The asker's own record names the target.** The frame carries the
  request id and the value only. The asking machine stores the value under
  the secret name and region it recorded when it raised the request, never
  a name taken from the frame.
- **Only a declared region secret.** The name must be one the region's
  environment declares for that machine, in the region-secret namespace. A
  request for any other store entry (the Boat account key, a link key, a
  harness credential) is refused when it is raised.
- **Admission on both ends.** The asking machine takes `secret.deliver` only
  over the key-bound link of a listed machine. The sender sends it only from
  the trusted window or an owner command, never from a seat's environment.
- **The window keeps nothing.** The field is never in a draft, view state,
  undo, an IPC log or a crash report. It is cleared after the attempt and
  never retried on its own. A timeout may have landed, so the asking machine
  reports set or not set in a row that carries names only.
- **Scrubbed in flight.** Both ends search the value out of every log and
  error on this path, since it is in no child's environment yet.
- **The form names who asks:** the machine, the seat or automation, the
  region and the secret name. Once set, anything on that machine's account
  can read it, so a hostile asker gets what the operator types. The form is
  the operator's judgment, not a check.
- **No platform store means no encryption.** On a machine without one, the
  owner-only file is not encrypted, and the form says so.

| Track | Owner | Reviewer |
|---|---|---|
| N1 the secret form's contract: the request, the reply record, the form | product-feed | remote-lead |
| N5 `secret.deliver`: the frame, its admission on the asking machine, the request it closes, Rule 9 and doctrine | remote-core | remote-security, remote-lead |
