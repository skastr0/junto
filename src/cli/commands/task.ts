import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { mintItemId } from "../../shared/resource-command";
import {
  TASK_ARGS,
  TASK_LIST_LIMIT_MAX,
  isTaskWriteOp,
  type TaskControlOp,
} from "../../shared/task-control";
import { STAMPS_REQUIRED_MAX, TASK_STATES } from "../../shared/task-model";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { opIdFlag, opIdOf } from "../core/op-id";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";
import { taskCheckCommand } from "./board";
import { taskWaitCommand } from "./seat";
import { taskRulesCommand } from "./work";

/**
 * `junto task` (plan 04): list, show, create and edit tasks on the task
 * nodes in this seat's reach, and move them through their states. A task is
 * `#42`, its id, or a `junto://` ref; a seat is `@name`, its name or its id,
 * or `me`; main resolves both in reach. Every write mints its opId here, or
 * takes --op-id to retry one, and create mints the task's id.
 */

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const taskArg = Argument.string("task").pipe(Argument.withDescription("A task: #42, its id, or a junto:// ref"));

const call = (op: TaskControlOp, args: unknown, timeout: Option.Option<number>) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, args, Option.getOrUndefined(timeout));
  });

/** One verb's call: the args it names, with an opId when it writes. */
const run = (
  verb: string,
  op: TaskControlOp,
  args: Record<string, unknown>,
  opId: Option.Option<string>,
  timeout: Option.Option<number>,
) =>
  executeJsonCommand(
    `task ${verb}`,
    Effect.gen(function* () {
      const written = isTaskWriteOp(op) ? { opId: yield* opIdOf(opId), ...args } : args;
      return yield* call(op, written, timeout);
    }),
  );

/** Flags left out stay out of the args, so main's schema sees only what was named. */
const present = (fields: Record<string, Option.Option<unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => (Option.isSome(value) ? [[key, value.value]] : [])));

const DESCRIPTIONS = {
  list: "Tasks on every task node in this seat's reach, or on the one named by --node, newest change first.",
  show: "One task with its layers: earlier nodes show their handoff note, stamps and cited refs.",
  create: "Create a task in backlog on the task node in reach, or the one --node names.",
  edit: "Change a task's title or body.",
  assign: "Assign a task to a seat in its node's reach, or to this seat. The seat is mailed a notice in the task's thread.",
  unassign: "Take a task back to backlog with no assignee.",
  start: "Start the task assigned to this seat: assigned becomes working.",
  pause: "Ask for input: working becomes input-required.",
  resume: "Go back to work: input-required becomes working.",
  finish: "Finish a task: in-review while it waits on stamps, then done, or sent on to the node --next names.",
  cancel: "Cancel a task that is not done.",
  archive: "Archive a done or canceled task.",
  depend: "Make a task wait on another: it cannot finish until --on is done.",
  undepend: "Drop a dependency.",
  "reviewer-add": "Name a reviewer: a seat in the node's reach, operator, or this seat.",
  "reviewer-remove": "Drop a reviewer.",
  "stamp-policy": "Set how many approvals finishing needs.",
  stamp: "Stamp a task in review: approve, or changes with what to change.",
  comment: "Post in the task's thread.",
} as const;

type Verb = keyof typeof DESCRIPTIONS;
const opOf = (verb: Verb): TaskControlOp => `task.${verb}` as TaskControlOp;

const stateFlag = Flag.choice("state", TASK_STATES).pipe(
  Flag.atLeast(0),
  Flag.withDescription("Only tasks in this state; repeat for several (default: every state but archived)"),
);

const listCommand = Command.make(
  "list",
  {
    node: Flag.string("node").pipe(Flag.optional, Flag.withDescription("A task node: its id, its name or a junto:// ref")),
    state: stateFlag,
    assignee: Flag.string("assignee").pipe(Flag.optional, Flag.withDescription("Only tasks assigned to this seat, or me")),
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription(`At most this many (1 to ${TASK_LIST_LIMIT_MAX}, default 50)`)),
    timeout: timeoutFlag,
  },
  ({ node, state, assignee, limit, timeout }) =>
    run("list", "task.list", {
      ...present({ node, assignee, limit }),
      ...(state.length === 0 ? {} : { state }),
    }, Option.none(), timeout),
).pipe(Command.withDescription(DESCRIPTIONS.list));

const showCommand = Command.make("show", { task: taskArg, timeout: timeoutFlag }, ({ task, timeout }) =>
  run("show", "task.show", { task }, Option.none(), timeout)).pipe(Command.withDescription(DESCRIPTIONS.show));

const bodyFlag = Flag.string("body").pipe(Flag.optional, Flag.withDescription("Markdown body"));

const createCommand = Command.make(
  "create",
  {
    title: Argument.string("title").pipe(Argument.withDescription("The task's title")),
    body: bodyFlag,
    node: Flag.string("node").pipe(Flag.optional, Flag.withDescription("The task node, when more than one is in reach")),
    stamps: Flag.integer("stamps").pipe(Flag.optional, Flag.withDescription(`Approvals finishing needs (0 to ${STAMPS_REQUIRED_MAX}; default the node's)`)),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ title, body, node, stamps, opId, timeout }) =>
    run("create", "task.create", { taskId: mintItemId(), title, ...present({ body, node, stamps }) }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.create));

const editCommand = Command.make(
  "edit",
  {
    task: taskArg,
    title: Flag.string("title").pipe(Flag.optional, Flag.withDescription("A new title")),
    body: bodyFlag,
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, title, body, opId, timeout }) => run("edit", "task.edit", { task, ...present({ title, body }) }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.edit));

const assignCommand = Command.make(
  "assign",
  {
    task: taskArg,
    seat: Argument.string("seat").pipe(Argument.optional, Argument.withDescription("@name, a seat's name or id; this seat when left out")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, seat, opId, timeout }) => run("assign", "task.assign", { task, ...present({ seat }) }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.assign));

/** The verbs that name one task and nothing else. */
const oneCommand = (verb: "unassign" | "start" | "pause" | "resume" | "cancel" | "archive") =>
  Command.make(verb, { task: taskArg, opId: opIdFlag, timeout: timeoutFlag }, ({ task, opId, timeout }) =>
    run(verb, opOf(verb), { task }, opId, timeout)).pipe(Command.withDescription(DESCRIPTIONS[verb]));

const finishCommand = Command.make(
  "finish",
  {
    task: taskArg,
    next: Flag.string("next").pipe(Flag.optional, Flag.withDescription("The downstream task node to send it on to, when there are several")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, next, opId, timeout }) => run("finish", "task.finish", { task, ...present({ next }) }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.finish));

const dependCommand = (verb: "depend" | "undepend") =>
  Command.make(
    verb,
    {
      task: taskArg,
      on: Flag.string("on").pipe(Flag.withDescription("The task it waits on: #42, its id, or a junto:// ref")),
      opId: opIdFlag,
      timeout: timeoutFlag,
    },
    ({ task, on, opId, timeout }) => run(verb, opOf(verb), { task, on }, opId, timeout),
  ).pipe(Command.withDescription(DESCRIPTIONS[verb]));

const reviewerVerb = (verb: "add" | "remove") =>
  Command.make(
    verb,
    {
      task: taskArg,
      reviewer: Argument.string("reviewer").pipe(Argument.optional, Argument.withDescription("@name, a seat's name or id, or operator; this seat when left out")),
      opId: opIdFlag,
      timeout: timeoutFlag,
    },
    ({ task, reviewer, opId, timeout }) =>
      run(`reviewer ${verb}`, opOf(`reviewer-${verb}`), { task, ...present({ reviewer }) }, opId, timeout),
  ).pipe(Command.withDescription(DESCRIPTIONS[`reviewer-${verb}`]));

const reviewerCommand = Command.make("reviewer").pipe(
  Command.withDescription("Name or drop a task's reviewers"),
  Command.withSubcommands([reviewerVerb("add"), reviewerVerb("remove")]),
);

const stampPolicyCommand = Command.make(
  "stamp-policy",
  {
    task: taskArg,
    required: Argument.integer("required").pipe(Argument.withDescription(`Approvals finishing needs (0 to ${STAMPS_REQUIRED_MAX})`)),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, required, opId, timeout }) => run("stamp-policy", "task.stamp-policy", { task, required }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS["stamp-policy"]));

const stampCommand = Command.make(
  "stamp",
  {
    task: taskArg,
    verdict: Argument.choice("verdict", ["approve", "changes"] as const),
    text: Flag.string("text").pipe(Flag.optional, Flag.withDescription("What to change, with changes; a note with approve")),
    subjectHash: Flag.string("subject-hash").pipe(Flag.optional, Flag.withDescription("The review subject hash task show printed")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, verdict, text, subjectHash, opId, timeout }) =>
    verdict === "changes" && Option.isNone(text)
      ? executeJsonCommand("task stamp", Effect.fail(new InputError({ message: "changes says what to change: add --text", path: "text" })))
      : run("stamp", "task.stamp", { task, verdict, ...present({ text, subjectHash }) }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.stamp));

const commentCommand = Command.make(
  "comment",
  {
    task: taskArg,
    text: Argument.string("text").pipe(Argument.withDescription("The comment; @name mentions a seat")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, text, opId, timeout }) => run("comment", "task.comment", { task, text }, opId, timeout),
).pipe(Command.withDescription(DESCRIPTIONS.comment));

export const taskCommand = Command.make("task").pipe(
  Command.withDescription("Tasks on the task nodes in this seat's reach"),
  Command.withSubcommands([
    listCommand,
    showCommand,
    createCommand,
    editCommand,
    assignCommand,
    oneCommand("unassign"),
    oneCommand("start"),
    oneCommand("pause"),
    oneCommand("resume"),
    finishCommand,
    oneCommand("cancel"),
    oneCommand("archive"),
    dependCommand("depend"),
    dependCommand("undepend"),
    reviewerCommand,
    stampPolicyCommand,
    stampCommand,
    commentCommand,
    taskCheckCommand,
    taskRulesCommand,
    taskWaitCommand,
  ]),
);

// --- discovery ---------------------------------------------------------------

const VERBS = Object.keys(DESCRIPTIONS) as ReadonlyArray<Verb>;
const commandOf = (verb: Verb): string => (verb.startsWith("reviewer-") ? `task reviewer ${verb.slice("reviewer-".length)}` : `task ${verb}`);

export const taskSchemas: ReadonlyArray<CommandSchemaContract> = VERBS.map((verb) => ({
  command_id: opOf(verb),
  command: commandOf(verb),
  schema_id: `${opOf(verb)}.input/v1`,
  description: isTaskWriteOp(opOf(verb))
    ? `${DESCRIPTIONS[verb]} The CLI mints the opId (--op-id retries one). Returns applied with the task's number and state, or queued with the opId while the editing machine is away.`
    : DESCRIPTIONS[verb],
  schema: TASK_ARGS[opOf(verb)] as Schema.Top,
  input_modes: ["argv"],
}));

const example = (verb: Verb, name: string, description: string, args: ReadonlyArray<string>, input: unknown): CommandExample => ({
  command_id: opOf(verb),
  command: commandOf(verb),
  name,
  description,
  input,
  args: [...commandOf(verb).split(" "), ...args],
});

export const taskExamples: ReadonlyArray<CommandExample> = [
  example("list", "my open tasks", "Every task node in reach, assigned to this seat.", ["--assignee", "me"], { assignee: "me" }),
  example("create", "add a task", "Lands in backlog on the one task node in reach.", ["Ship the task CLI", "--stamps", "1"], {
    title: "Ship the task CLI",
    stamps: 1,
  }),
  example("assign", "hand a task to a seat", "The seat is mailed in the task's thread.", ["#42", "@cli-identity"], { task: "#42", seat: "@cli-identity" }),
  example("start", "start my task", "assigned becomes working.", ["#42"], { task: "#42" }),
  example("finish", "finish and send on", "--next names the downstream node when there are several.", ["#42", "--next", "Review"], { task: "#42", next: "Review" }),
  example("stamp", "ask for changes", "changes needs --text.", ["#42", "changes", "--text", "Cover the replay path"], {
    task: "#42",
    verdict: "changes",
    text: "Cover the replay path",
  }),
  example("comment", "post in the thread", "@name mentions a seat.", ["#42", "@cli-lead the ruler landed"], { task: "#42", text: "@cli-lead the ruler landed" }),
];

export const taskCapabilities: ReadonlyArray<CommandCapability> = VERBS.map((verb) => ({
  command_id: opOf(verb),
  command: commandOf(verb),
  category: isTaskWriteOp(opOf(verb)) ? "workflow" : "discovery",
  description: DESCRIPTIONS[verb],
  schemas: taskSchemas.filter((schema) => schema.command_id === opOf(verb)),
  examples: taskExamples.filter((entry) => entry.command_id === opOf(verb)),
}));
