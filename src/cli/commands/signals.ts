// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
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
    ({ input, detail, timeout, ...attach }) =>
      executeJsonCommand(
        kind,
        Effect.gen(function* () {
          const args = yield* loadSignalRaiseArgs(kind, input, toUndefined(detail), attach, toUndefined(timeout));
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

const signalListCommand = Command.make(
  "list",
  { timeout: timeoutOption },
  ({ timeout }) =>
    executeJsonCommand(
      "signal list",
      call("signal.list", {}, toUndefined(timeout)),
    ),
).pipe(
  Command.withDescription("This seat's signals, open first, with the operator's answers"),
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
