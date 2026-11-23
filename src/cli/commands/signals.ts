import { Argument, Command, Flag } from "effect/cli";
import { Effect, Option } from "effect";
import type { SeatRaiseKind } from "../../shared/agent-signals";
import { SignalBatch, SignalClear, SignalList, SignalRaise } from "../../contract/work/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeJsonCommand } from "../core/output";
import type { AttachFlags } from "../core/signal-attach";
import type { FormFlags } from "../core/signal-form";
import { loadSignalBatchArgs, loadSignalRaiseArgs, type OrderFlags, planOrderFlags } from "../core/signal-input";
import { callWorkRpc } from "../core/socket";

/**
 * Agent signals: how every canvas seat raises its hand to the operator. No
 * edge or port is needed; the seat can only speak for itself.
 */

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const timeoutOption = Flag.Int("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const sentenceArg = Argument.String("input").pipe(
  Argument.withDescription(
    'One sentence, or a JSON object {"text","detail","attach"} inline, @file, or - for stdin',
  ),
);

const detailOption = Flag.String("detail").pipe(
  Flag.optional,
  Flag.withDescription("Longer markdown for the operator: inline, @file, or - for stdin"),
);

// One definition for all three kinds. Repeat a flag for each thing attached.
// On the card they come in this order, each in the order given: attach, code,
// diff, compare, commit, video, task, artifact. The JSON attach list keeps
// its own order.
const attachFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.atLeast(0), Flag.withDescription(description));

const attachOptions = {
  suggest: Flag.String("suggest").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      'A reply the operator can send in one click, ahead of the quick replies: --suggest "Use sqlite" --suggest "Keep JSON". At most two.',
    ),
  ),
  attach: attachFlag(
    "attach",
    'A file to show the operator, of any kind and size: /path or "Caption=/path". Repeat for each. Card order: attach, code, diff, compare, commit, video, task, artifact',
  ),
  code: attachFlag(
    "code",
    'A code block: "ts:const a = 1", where the text may be @file or - for stdin; a caption goes first: "The guard=ts:..."',
  ),
  diff: attachFlag(
    "diff",
    'A diff, no repository needed: unified diff text, @file, or - for stdin (git diff | junto feedback "..." --diff -)',
  ),
  compare: attachFlag(
    "compare",
    'Two files read as a change: "before.ts,after.ts". For two texts typed inline use the JSON attach list',
  ),
  commit: attachFlag("commit", 'A commit in this folder: HEAD, a branch, or an id, as "The fix=HEAD"'),
  video: attachFlag(
    "video",
    'A video at a web address: "https://host/run.mp4". The operator sees the address; nothing is fetched until they press play',
  ),
  task: attachFlag(
    "task",
    'A task in your reach: its junto:// ref, #42, or its id, as "Stamp this=#42". Junto resolves it; a name that matches nothing lists what you reach',
  ),
  artifact: attachFlag(
    "artifact",
    'An artifact in your reach: its junto:// ref or its id, as "The spec=<ref>". Junto resolves it in your reach',
  ),
};

/** Where the signal stands: the thread it is raised in, and what it comes after. */
const orderOptions = {
  thread: Flag.String("thread").pipe(
    Flag.optional,
    Flag.withDescription(
      "Raise it in a thread you have with the operator: the thread id or the id of any mail in it. The signal is also your next mail there",
    ),
  ),
  dependsOn: Flag.String("depends-on").pipe(
    Flag.atLeast(0),
    Flag.withDescription("A signal of yours this one comes after, by id: the operator meets that one first. Repeat for each"),
  ),
  dependsOnLast: Flag.Boolean("depends-on-last").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Comes after the signal you raised last on this canvas; after nothing when you raised none"),
  ),
};

/**
 * The reply form a blocked or escalate signal asks for (0.11/07, N4): what the
 * operator produces in the signal. One per signal; a text reply needs none.
 */
const formOptions = {
  askSecret: Flag.String("ask-secret").pipe(
    Flag.optional,
    Flag.withDescription(
      "Ask the operator for a secret by the environment variable you read: --ask-secret CLOUDFLARE_API_TOKEN. Your region must declare it as a secret; the value goes where your region keeps it, never into the signal, mail or a log. Read it from your environment once the answer says it is set. Main refuses it until the vault lands (0.11, N5): ask in words until then",
    ),
  ),
  askArtifact: Flag.String("ask-artifact").pipe(
    Flag.optional,
    Flag.withDescription(
      "Ask the operator to write a document in the signal, saved in this Artifacts node (its name, id or junto:// ref, in your reach). With --min-words and --label",
    ),
  ),
  minWords: Flag.Int("min-words").pipe(
    Flag.optional,
    Flag.withDescription("With --ask-artifact: the answer counts once the document has at least this many words"),
  ),
  label: Flag.String("label").pipe(
    Flag.atLeast(0),
    Flag.withDescription("With --ask-artifact: a label for the document. Repeat for each; labels fold to lowercase"),
  ),
  askProof: Flag.Boolean("ask-proof").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Ask the operator for proof of work: text with links or files"),
  ),
};

type OrderOptions = { readonly thread: Option.Option<string>; readonly dependsOn: ReadonlyArray<string>; readonly dependsOnLast: boolean };

const raise = (kind: SeatRaiseKind, input: string, detail: Option.Option<string>, timeout: Option.Option<number>, suggest: ReadonlyArray<string>, order: OrderOptions, attach: AttachFlags, form: FormFlags = {}) =>
  executeJsonCommand(
    kind,
    Effect.gen(function* () {
      const flags: OrderFlags = { ...(Option.isSome(order.thread) ? { thread: order.thread.value } : {}), dependsOn: order.dependsOn, dependsOnLast: order.dependsOnLast };
      // The ids are checked before anything is read or uploaded.
      const placed = yield* planOrderFlags(flags);
      const args = yield* loadSignalRaiseArgs(kind, input, toUndefined(detail), attach, toUndefined(timeout), suggest, form);
      return yield* callWorkRpc(SignalRaise, { ...args, ...placed }, toUndefined(timeout));
    }),
  );

const raiseCommand = (kind: SeatRaiseKind, description: string) =>
  Command.make(
    kind,
    { input: sentenceArg, detail: detailOption, ...attachOptions, ...orderOptions, timeout: timeoutOption },
    ({ input, detail, timeout, suggest, thread, dependsOn, dependsOnLast, ...attach }) =>
      raise(kind, input, detail, timeout, suggest, { thread, dependsOn, dependsOnLast }, attach),
  ).pipe(Command.withDescription(description));

/** Blocked and escalate also ask for a reply form. */
const raiseWithFormCommand = (kind: SeatRaiseKind, description: string) =>
  Command.make(
    kind,
    { input: sentenceArg, detail: detailOption, ...attachOptions, ...orderOptions, ...formOptions, timeout: timeoutOption },
    ({ input, detail, timeout, suggest, thread, dependsOn, dependsOnLast, askSecret, askArtifact, minWords, label, askProof, ...attach }) =>
      raise(kind, input, detail, timeout, suggest, { thread, dependsOn, dependsOnLast }, attach, {
        askSecret: toUndefined(askSecret),
        askArtifact: toUndefined(askArtifact),
        minWords: toUndefined(minWords),
        label,
        askProof,
      }),
  ).pipe(Command.withDescription(description));

export const escalateCommand = raiseWithFormCommand(
  "escalate",
  "Needs the operator's attention; you keep working. Any time. Ask for what they must produce with --ask-artifact or --ask-proof; --ask-secret waits for the vault.",
);

export const blockedCommand = raiseWithFormCommand(
  "blocked",
  "Work is entirely blocked on the operator; stop and wait for the answer. Ask for what they must produce with --ask-artifact or --ask-proof; --ask-secret waits for the vault.",
);

export const feedbackCommand = raiseCommand(
  "feedback",
  "Not blocked: the work is ready for the operator to review.",
);

const sinceOption = Flag.String("since").pipe(
  Flag.optional,
  Flag.withDescription(
    "List every closed signal from here on, uncapped: an ISO 8601 time (2026-10-19 or 2026-10-19T12:00:00Z) or a signal id",
  ),
);

const signalListCommand = Command.make(
  "list",
  { since: sinceOption, timeout: timeoutOption },
  ({ since, timeout }) =>
    executeJsonCommand(
      "signal list",
      callWorkRpc(SignalList, Option.isSome(since) ? { since: since.value } : {}, toUndefined(timeout)),
    ),
).pipe(
  Command.withDescription(
    "This seat's signals with the operator's answers: open first, most urgent first, each with its urgency level and rank, its thread and the signal it follows there, what it comes after, and whether it is ready or what it waits on. Every open signal and the newest closed ones; --since pages further back",
  ),
);

const signalClearCommand = Command.make(
  "clear",
  {
    id: Argument.String("id").pipe(
      Argument.optional,
      Argument.withDescription("Signal id; omit to withdraw every open signal of this seat"),
    ),
    timeout: timeoutOption,
  },
  ({ id, timeout }) =>
    executeJsonCommand(
      "signal clear",
      callWorkRpc(
        SignalClear,
        Option.isSome(id) ? { signalId: id.value } : {},
        toUndefined(timeout),
      ),
    ),
).pipe(
  Command.withDescription("Withdraw your own open signal once it no longer applies"),
);

const SIGNAL_BATCH_DESCRIPTION =
  "Raise several signals in the order the operator should act on them, all or none: a JSON list of {kind, text, detail, suggest, form, attach, thread, dependsOn} inline, @file, or - for stdin. Each comes after the one before it unless its dependsOn names earlier items by position from 1 or your own signal ids; [] is after nothing. Answers the ids in order";

const signalBatchCommand = Command.make(
  "batch",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription('A JSON list of signals, or {"signals": [...]}: inline, @file, or - for stdin'),
    ),
    timeout: timeoutOption,
  },
  ({ input, timeout }) =>
    executeJsonCommand(
      "signal batch",
      Effect.gen(function* () {
        const args = yield* loadSignalBatchArgs(input, toUndefined(timeout));
        return yield* callWorkRpc(SignalBatch, args, toUndefined(timeout));
      }),
    ),
).pipe(Command.withDescription(SIGNAL_BATCH_DESCRIPTION));

export const signalCommand = Command.make("signal").pipe(
  Command.withDescription("Read, raise in order, or withdraw this seat's agent signals"),
  Command.withSubcommands([signalListCommand, signalBatchCommand, signalClearCommand]),
);
