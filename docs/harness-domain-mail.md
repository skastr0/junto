# Mail on the harness domain

Status: building, step 6 of `docs/harness-domain.md` (mail delivery goes through
`admitCommand`). Owner: pty-mail. PTY stream only.

Mail is a `DeliverMail { mode: "steer" }` command. Before it is typed, the drive
asks `admitMail` (`src/main/junto/term/drive/mail-admission.ts`), which calls
`admitCommand` with the seat's `SeatSnapshot` and its harness's
`HarnessCapabilities`. A refusal becomes a hold the mailbox already tells; an
admitted seat still goes through the composer gate.

Admission is wired behind two lookups on `createCoreMailTransport`:
`harnessCapabilities`, which defaults to `harnessCapabilitiesFor`
(`src/shared/harness-capabilities.ts`, pty-contract), and `seatSnapshot`, which
pty-state's projection supplies (`seatStateRuntime.snapshot`). While
`seatSnapshot` is absent, `admitMail` gives no verdict and delivery is
unchanged.

## Where each rule lives, and where it goes

| Rule today | Where | Domain mapping | After |
|---|---|---|---|
| Mail asks for steering, never queue | `MAIL_FOLLOW_UP_MODE`, `src/shared/managed-terminal-templates.ts` | `DeliverMail.mode = "steer"` (`MAIL_MODE_ASKED`) | same constant, read through the domain |
| Enters per steer: two on devin and cursor mid-turn, one elsewhere and when idle | `HARNESS_FOLLOW_UP`, `mailSteeringSubmits` | none: a typing recipe, not a support level. `mailSteer` and `mailQueue` are `typed, pty` | stays in `HARNESS_FOLLOW_UP` |
| Mail types mid-turn | drive `writeMailInternal` | `Working { thinking \| tool }` admitted through `mailSteer` | admitted |
| Attention holds mail as `dialog` | `composerAvailability`, `src/shared/composer-availability.ts` | `Blocked { Permission \| Question \| Dialog }` refused, held `dialog` | both, until surfaces read needs |
| Usage limit or auth error | not detected | `Blocked { UsageLimit \| Error }` refused, held `stopped` | new, reachable once the screen emits them |
| Compaction, retry | not detected | `Working { compacting \| retrying }` refused, held `busy` | new, reachable once the screen emits them |
| Harness cannot steer | never: every harness steers | `CommandUnsupportedError`, held `unsupported` | unreachable while every record declares `mailSteer` |
| Process gone, write lost | drive `active` and `activeBinding`, `MailReadinessLatch` on `running` | `Exited` refused, returned `lost` | both |
| Unknown seat state: typed when the composer reads empty | drive `mailHold`, composer probes | `Unknown` admitted through `mailSteer`; the composer decides | admitted |
| A generation starts as `unknown` until it reads ready | `MailReadinessLatch` requires idle first | `Starting` refused, held `busy` | both; the latch holds first, so the hold is not reached today |
| First ready moment of a generation: bracketed paste on, confirmed idle | `mailFirstReady`, `MailReadinessLatch`, `drive/mail-readiness.ts` | none: PTY profile, not status | stays, a harness record's PTY profile at step 4 |
| Amp composer painted while connecting | `AMP_STARTUP_FOOTER` (mail readiness), `isAmpReady` (`drive/readiness.ts`) | none: screen readiness | stays, rule pack at step 4 |
| Hermes needs a positive signal before typing | `isManagedTerminalReady`, `drive/readiness.ts` | none: PTY profile | stays, harness record at step 4 |
| Bracketed paste off: type plain text | `buildMailWriteSequence`, `drive/typing.ts` | `CommandSupport { typed, pty }` | stays the typed recipe |
| Hermes multiline folds to one line | `hermesRefusesMultilinePaste`, `drive/typing.ts` | none: typed recipe | stays, harness record at step 4 |
| Grok paste swallowed in its first 1.5s | `GROK_MIN_POST_SPAWN_MS`, drive `readyAfter` | none: PTY profile | stays, harness record at step 4 |
| Operator draft holds mail | drive `operatorDrafting`, `OperatorInterlock` | none: the operator, not the seat | stays |
| Unread box holds after a grace | `MAIL_UNREADABLE_GRACE_MS`, drive | none: composer | stays |
| Held mail rechecked, mail behind held mail waits | drive `holdMail`, `mailHeld` | admission rechecked with the composer | admission included |
| Delivery waits for a live, onboarded, unfenced seat | `transport.seatLive`, `src/main/junto/term/core-mail.ts` | none: occupancy and lifecycle | stays |
| Held mail retried and told every minute | `MAIL_HELD_RETRY_MS`, `tellHeld`, `src/main/junto/work/message-delivery.ts` | carries every `MailHold` | the three seat holds are told like `dialog` |
| `typedNotice` working or unavailable-setup | `HARNESS_MAIL_TRANSPORT` | none: reported by harness list and doctor, never read by delivery | stays a report fact |

## Hold vocabulary

`MailHold` (`src/shared/mail-hold.ts`) is the composer's `draft`, `dialog` and
`unreadable` plus the seat's `busy`, `stopped` and `unsupported`. It types the
drive outcome, the delivery transport and the `held` field of a wire traffic
event, and each reason has its own copy in `HELD_REASON`
(`src/renderer/lib/preamble-sources.ts`). An onboarding nudge refused by the
seat's status reads `unavailable`.
