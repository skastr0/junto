import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import type { AgentSignalKind } from "../../shared/agent-signals";
import type { WorkOpName } from "../../shared/work-control";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeJsonCommand } from "../core/output";
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
// diff, compare, commit, video. The JSON attach list keeps its own order.
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
    'A file to show the operator, of any kind and size: /path or "Caption=/path". Repeat for each. Card order: attach, code, diff, compare, commit, video',
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
};

const call = (op: WorkOpName, args: unknown, timeout?: number) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, timeout);
  });

const raiseCommand = (kind: AgentSignalKind, description: string) =>
  Command.make(
    kind,
    { input: sentenceArg, detail: detailOption, ...attachOptions, timeout: timeoutOption },
    ({ input, detail, timeout, suggest, ...attach }) =>
      executeJsonCommand(
        kind,
        Effect.gen(function* () {
          const args = yield* loadSignalRaiseArgs(
            kind,
            input,
            toUndefined(detail),
            attach,
            toUndefined(timeout),
            suggest,
          );
          return yield* call("signal.raise", args, toUndefined(timeout));
        }),
      ),
  ).pipe(Command.withDescription(description));

export const escalateCommand = raiseCommand(
  "escalate",
  "Needs the operator's attention; you keep working. Any time.",
);

export const blockedCommand = raiseCommand(
  "blocked",
  "Work is entirely blocked on the operator; stop and wait for the answer.",
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
