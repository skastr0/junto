import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import type { SeatRaiseKind } from "../../shared/agent-signals";
import type { WorkOpName } from "../../shared/work-control";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeJsonCommand } from "../core/output";
import type { AttachFlags } from "../core/signal-attach";
import type { FormFlags } from "../core/signal-form";
import { loadSignalRaiseArgs } from "../core/signal-input";
import { WorkSocket } from "../core/socket";

/**
 * Agent signals: how every canvas seat raises its hand to the operator. No
 * edge or port is needed; the seat can only speak for itself.
 */

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const sentenceArg = Argument.string("input").pipe(
  Argument.withDescription(
    'One sentence, or a JSON object {"text","detail","attach"} inline, @file, or - for stdin',
  ),
);

const detailOption = Flag.string("detail").pipe(
  Flag.optional,
  Flag.withDescription("Longer markdown for the operator: inline, @file, or - for stdin"),
);

// One definition for all three kinds. Repeat a flag for each thing attached.
// On the card they come in this order, each in the order given: attach, code,
// diff, compare, commit, video, task, artifact. The JSON attach list keeps
// its own order.
const attachFlag = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.atLeast(0), Flag.withDescription(description));

const attachOptions = {
  suggest: Flag.string("suggest").pipe(
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

/**
 * The reply form a blocked or escalate signal asks for (0.11/07, N4): what the
 * operator produces in the signal. One per signal; a text reply needs none.
 */
const formOptions = {
  askSecret: Flag.string("ask-secret").pipe(
    Flag.optional,
    Flag.withDescription(
      "Ask the operator for a secret by the environment variable you read: --ask-secret CLOUDFLARE_API_TOKEN. Your region must declare it as a secret; the value goes where your region keeps it, never into the signal, mail or a log. Read it from your environment once the answer says it is set",
    ),
  ),
  askArtifact: Flag.string("ask-artifact").pipe(
    Flag.optional,
    Flag.withDescription(
      "Ask the operator to write a document in the signal, saved in this Artifacts node (its name, id or junto:// ref, in your reach). With --min-words and --label",
    ),
  ),
  minWords: Flag.integer("min-words").pipe(
    Flag.optional,
    Flag.withDescription("With --ask-artifact: the answer counts once the document has at least this many words"),
  ),
  label: Flag.string("label").pipe(
    Flag.atLeast(0),
    Flag.withDescription("With --ask-artifact: a label for the document. Repeat for each; labels fold to lowercase"),
  ),
  askProof: Flag.boolean("ask-proof").pipe(
    Flag.withDescription("Ask the operator for proof of work: text with links or files"),
  ),
};

const call = (op: WorkOpName, args: unknown, timeout?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, timeout);
  });

const raise = (kind: SeatRaiseKind, input: string, detail: Option.Option<string>, timeout: Option.Option<number>, suggest: ReadonlyArray<string>, attach: AttachFlags, form: FormFlags = {}) =>
  executeJsonCommand(
    kind,
    Effect.gen(function* () {
      const args = yield* loadSignalRaiseArgs(kind, input, toUndefined(detail), attach, toUndefined(timeout), suggest, form);
      return yield* call("signal.raise", args, toUndefined(timeout));
    }),
  );

const raiseCommand = (kind: SeatRaiseKind, description: string) =>
  Command.make(
    kind,
    { input: sentenceArg, detail: detailOption, ...attachOptions, timeout: timeoutOption },
    ({ input, detail, timeout, suggest, ...attach }) => raise(kind, input, detail, timeout, suggest, attach),
  ).pipe(Command.withDescription(description));

/** Blocked and escalate also ask for a reply form. */
const raiseWithFormCommand = (kind: SeatRaiseKind, description: string) =>
  Command.make(
    kind,
    { input: sentenceArg, detail: detailOption, ...attachOptions, ...formOptions, timeout: timeoutOption },
    ({ input, detail, timeout, suggest, askSecret, askArtifact, minWords, label, askProof, ...attach }) =>
      raise(kind, input, detail, timeout, suggest, attach, {
        askSecret: toUndefined(askSecret),
        askArtifact: toUndefined(askArtifact),
        minWords: toUndefined(minWords),
        label,
        askProof,
      }),
  ).pipe(Command.withDescription(description));

export const escalateCommand = raiseWithFormCommand(
  "escalate",
  "Needs the operator's attention; you keep working. Any time. Ask for what they must produce with --ask-secret, --ask-artifact or --ask-proof.",
);

export const blockedCommand = raiseWithFormCommand(
  "blocked",
  "Work is entirely blocked on the operator; stop and wait for the answer. Ask for what they must produce with --ask-secret, --ask-artifact or --ask-proof.",
);

export const feedbackCommand = raiseCommand(
  "feedback",
  "Not blocked: the work is ready for the operator to review.",
);

const sinceOption = Flag.string("since").pipe(
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
      call("signal.list", Option.isSome(since) ? { since: since.value } : {}, toUndefined(timeout)),
    ),
).pipe(
  Command.withDescription(
    "This seat's signals with the operator's answers: open first, most urgent first, each with its urgency level and rank. Every open signal and the newest closed ones; --since pages further back",
  ),
);

const signalClearCommand = Command.make(
  "clear",
  {
    id: Argument.string("id").pipe(
      Argument.optional,
      Argument.withDescription("Signal id; omit to withdraw every open signal of this seat"),
    ),
    timeout: timeoutOption,
  },
  ({ id, timeout }) =>
    executeJsonCommand(
      "signal clear",
      call(
        "signal.clear",
        Option.isSome(id) ? { signalId: id.value } : {},
        toUndefined(timeout),
      ),
    ),
).pipe(
  Command.withDescription("Withdraw your own open signal once it no longer applies"),
);

export const signalCommand = Command.make("signal").pipe(
  Command.withDescription("Read or withdraw this seat's agent signals"),
  Command.withSubcommands([signalListCommand, signalClearCommand]),
);
