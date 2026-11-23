import { Argument, Command, Flag } from "effect/cli";
import { Option } from "effect";
import { MESSAGES_PAGE_DEFAULT, PAGE_MAX, THREAD_GROUPS, THREADS_PAGE_DEFAULT } from "../../shared/mail-threads";
import { ThreadListArgs, ThreadShowArgs } from "../../shared/thread-control";
import { ThreadList, ThreadShow } from "../../contract/work/thread";
import type { CommandCapability, CommandExample, CommandSchemaContract } from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeJsonCommand } from "../core/output";
import { callWorkRpc } from "../core/socket";

/**
 * `junto thread list` and `junto thread show <threadId>`: a seat's threads,
 * those with the operator and those between seats. With no --seat, the caller's own; with --seat, a
 * connected seat's, as `seat read` names it, on port threads.read. Reading
 * marks nothing read, and the operator's read state is left out.
 */
const timeoutOption = Flag.Int("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const seatOption = Flag.String("seat").pipe(
  Flag.optional,
  Flag.withDescription("A connected seat, by name or node id; absent, your own threads"),
);

const limitOption = (what: string, fallback: number) =>
  Flag.Int("limit").pipe(Flag.optional, Flag.withDescription(`${what} in the page (default ${fallback}, max ${PAGE_MAX})`));

const LIST_DESCRIPTION =
  "List a seat's threads, newest activity first: your own, or with --seat a connected seat's. Marks nothing read.";
const SHOW_DESCRIPTION =
  "Read one thread's messages, oldest first in the page: the newest, or with --before the page above. Marks nothing read.";

const some = <A, K extends string>(key: K, value: Option.Option<A>): { readonly [P in K]?: A } =>
  (Option.isSome(value) ? { [key]: value.value } : {}) as { readonly [P in K]?: A };

const threadListCommand = Command.make(
  "list",
  {
    seat: seatOption,
    limit: limitOption("Threads", THREADS_PAGE_DEFAULT),
    after: Flag.String("after").pipe(Flag.optional, Flag.withDescription("The next cursor a previous page answered")),
    group: Flag.Literals("group", THREAD_GROUPS).pipe(
      Flag.optional,
      Flag.withDescription("One list alone: with-you (the operator is in it) or between (seats only)"),
    ),
    timeout: timeoutOption,
  },
  ({ seat, limit, after, group, timeout }) =>
    executeJsonCommand(
      "thread list",
      callWorkRpc(
        ThreadList,
        { ...some("seat", seat), ...some("limit", limit), ...some("after", after), ...some("group", group) },
        Option.getOrUndefined(timeout),
      ),
    ),
).pipe(Command.withDescription(LIST_DESCRIPTION));

const threadShowCommand = Command.make(
  "show",
  {
    threadId: Argument.String("threadId").pipe(Argument.withDescription("Thread id, as junto thread list prints it")),
    seat: seatOption,
    limit: limitOption("Messages", MESSAGES_PAGE_DEFAULT),
    before: Flag.String("before").pipe(Flag.optional, Flag.withDescription("The older cursor a previous page answered")),
    timeout: timeoutOption,
  },
  ({ threadId, seat, limit, before, timeout }) =>
    executeJsonCommand(
      "thread show",
      callWorkRpc(
        ThreadShow,
        { threadId, ...some("seat", seat), ...some("limit", limit), ...some("before", before) },
        Option.getOrUndefined(timeout),
      ),
    ),
).pipe(Command.withDescription(SHOW_DESCRIPTION));

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Your threads, or a connected seat's"),
  Command.withSubcommands([threadListCommand, threadShowCommand]),
);

export const threadSchemas: ReadonlyArray<CommandSchemaContract> = [
  {
    command_id: "thread.list",
    command: "thread list",
    schema_id: "thread.list.input/v1",
    description: `${LIST_DESCRIPTION} Each thread carries no readAt and no unread: those are the operator's.`,
    schema: ThreadListArgs,
  },
  {
    command_id: "thread.show",
    command: "thread show",
    schema_id: "thread.show.input/v1",
    description: `${SHOW_DESCRIPTION} The thread id is typed as a plain argument: junto thread show <threadId>.`,
    schema: ThreadShowArgs,
  },
];

export const threadExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "thread.list",
    command: "thread list",
    name: "list your threads",
    description: "Your own threads, newest activity first. Page on with --after <next>.",
    input: {},
    args: ["thread", "list"],
  },
  {
    command_id: "thread.list",
    command: "thread list",
    name: "list a connected seat's threads",
    description: "A seat your edge grants threads.read, by name or node id.",
    input: { seat: "planner", group: "with-you" },
    args: ["thread", "list", "--seat", "planner", "--group", "with-you"],
  },
  {
    command_id: "thread.show",
    command: "thread show",
    name: "read one thread",
    description: "The newest messages of one thread, oldest first. Page up with --before <older>.",
    input: { threadId: "01M852PM9NWTBBVNYYPSPR0HNV" },
    args: ["thread", "show", "01M852PM9NWTBBVNYYPSPR0HNV"],
  },
];

export const threadCapabilities: ReadonlyArray<CommandCapability> = [
  {
    command_id: "thread.list",
    command: "thread list",
    category: "workflow",
    description: LIST_DESCRIPTION,
    schemas: [threadSchemas[0]!],
    examples: [threadExamples[0]!, threadExamples[1]!],
  },
  {
    command_id: "thread.show",
    command: "thread show",
    category: "workflow",
    description: SHOW_DESCRIPTION,
    schemas: [threadSchemas[1]!],
    examples: [threadExamples[2]!],
  },
];
