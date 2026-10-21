import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import { mintItemId } from "../../shared/resource-command";
import {
  TASK_ARGS,
  TASK_LIST_LIMIT_MAX,
  TaskCheckArgs,
  isTaskWriteOp,
  type TaskControlOp,
} from "../../shared/task-control";
import { CHECK_OUTPUT_TAIL_MAX, STAMPS_REQUIRED_MAX, TASK_HANDOFF_MAX, TASK_STATES } from "../../shared/task-model";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { InputError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { opIdFlag, opIdOf } from "../core/op-id";
import { executeJsonCommand } from "../core/output";
import { readSource, sourceOf } from "../core/signal-input";
import { WorkSocket } from "../core/socket";
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
  list: "Tasks on every task node in this seat's reach, or on the one named by --node, newest change first. --reviewer lists the reviews a seat owes, longest waiting first.",
  show: "One task with its layers: each shows its assignee, reviewers and stamps, and the evidence and handoff note its finish left.",
  create: "Create a task in backlog on the task node in reach, or the one --node names.",
  edit: "Change a task's title or body.",
  assign: "Assign a task to a seat in its node's reach, or to this seat. The seat is mailed a notice in the task's thread.",
  unassign: "Take a task back to backlog with no assignee.",
  start: "Start the task assigned to this seat: assigned becomes working.",
  pause: "Ask for input: working becomes input-required.",
  resume: "Go back to work: input-required becomes working.",
  finish: `Finish a task: in-review while it waits on stamps, then done, or sent on to the node --next names. --claim answers each rule in force on the node (task rules lists them); a rule left unanswered is refused rules-unmet, and a required check that is not green at this epoch is refused checks-unmet, naming the red and the not run. A task it depends on that is not done refuses it deps-unmet, naming each by number and state. --note leaves a handoff note for whoever picks the work up next: inline, @file or -, at most ${TASK_HANDOFF_MAX} characters.`,
  check: "Report the checks you ran for this move, each with its exit code: Junto never runs one. task rules lists them with their side, command and status; --outgoing reports this node's, --incoming the next node's, or --results carries them as JSON with each output's tail.",
  cancel: "Cancel a task that is not done.",
  archive: "Archive a done or canceled task.",
  depend: "Make a task wait on another: it cannot finish until --on is done, or archived after it was done. A dependency that would close a cycle is refused.",
  undepend: "Drop a dependency.",
  "reviewer-add": "Name a reviewer: a seat in the node's reach, operator, or this seat.",
  "reviewer-remove": "Drop a reviewer.",
  "stamp-policy": "Set how many approvals finishing needs.",
  stamp: "Stamp a task in review: approve, or changes with what to change in --text; changes without --text is refused before it is sent.",
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
    reviewer: Flag.string("reviewer").pipe(
      Flag.optional,
      Flag.withDescription("Only reviews this seat, or me, owes: in review, naming it, with no stamp from it at the current epoch, longest waiting first"),
    ),
    limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription(`At most this many (1 to ${TASK_LIST_LIMIT_MAX}, default 50)`)),
    timeout: timeoutFlag,
  },
  ({ node, state, assignee, reviewer, limit, timeout }) =>
    run("list", "task.list", {
      ...present({ node, assignee, reviewer, limit }),
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

const repeated = (name: string, description: string) => Flag.string(name).pipe(Flag.atLeast(0), Flag.withDescription(description));

/** `<left><sep><right>`, both sides non-empty, split at `at` (the first or last separator). */
const pairOf = (flag: string, shape: string, value: string, at: number): Effect.Effect<readonly [string, string], InputError> =>
  at > 0 && at < value.length - 1
    ? Effect.succeed([value.slice(0, at).trim(), value.slice(at + 1).trim()] as const)
    : Effect.fail(new InputError({ message: `--${flag} takes ${shape}, got ${JSON.stringify(value)}`, path: flag }));

/** The evidence flags as CompletionEvidence, or nothing when none was given. */
const evidenceOf = (flags: {
  readonly artifact: ReadonlyArray<string>;
  readonly commit: ReadonlyArray<string>;
  readonly claim: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    // An artifact id holds no slash, so the last one ends the node.
    const artifacts = yield* Effect.forEach(flags.artifact, (value) =>
      Effect.map(pairOf("artifact", "<node id>/<artifactId>", value, value.lastIndexOf("/")), ([nodeId, artifactId]) => ({ nodeId, artifactId })));
    const claims = yield* Effect.forEach(flags.claim, (value) =>
      Effect.map(pairOf("claim", "<ruleId>=<text>", value, value.indexOf("=")), ([ruleId, text]) => ({ ruleId, text })));
    if (artifacts.length + flags.commit.length + claims.length === 0) return {};
    return {
      evidence: {
        artifacts,
        ...(flags.commit.length === 0 ? {} : { git: { commits: [...flags.commit] } }),
        ...(claims.length === 0 ? {} : { claims }),
      },
    };
  });

const finishCommand = Command.make(
  "finish",
  {
    task: taskArg,
    next: Flag.string("next").pipe(Flag.optional, Flag.withDescription("The downstream task node to send it on to, when there are several")),
    artifact: repeated("artifact", "An artifact this work produced, as <node id>/<artifactId>; repeat for several"),
    commit: repeated("commit", "A commit this work landed; repeat for several"),
    claim: repeated("claim", "Answer a rule in force: <ruleId>=<how this work meets it>; repeat for several"),
    note: Flag.string("note").pipe(
      Flag.optional,
      Flag.withDescription(`A handoff note for whoever picks the work up next: inline, @file or -, at most ${TASK_HANDOFF_MAX} characters`),
    ),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, next, artifact, commit, claim, note, opId, timeout }) =>
    executeJsonCommand(
      "task finish",
      Effect.gen(function* () {
        const evidence = yield* evidenceOf({ artifact, commit, claim });
        const handoff = Option.isSome(note) ? { handoff: yield* handoffOf(note.value) } : {};
        return yield* call("task.finish", { opId: yield* opIdOf(opId), task, ...present({ next }), ...evidence, ...handoff }, timeout);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTIONS.finish));

/**
 * The note --note names, inline, from @file or from - (stdin), checked here so
 * a note main would refuse never crosses the socket. A file's or stdin's last
 * newline is the file's, not the note's.
 */
export const handoffOf = (raw: string) =>
  Effect.gen(function* () {
    const source = sourceOf(raw);
    const read = yield* readSource(source);
    const note = source.kind === "inline" ? read : read.replace(/\r?\n$/, "");
    if (note.trim().length === 0) return yield* Effect.fail(new InputError({ message: "--note is empty", path: "note" }));
    if (note.length > TASK_HANDOFF_MAX) {
      return yield* Effect.fail(new InputError({ message: `--note holds at most ${TASK_HANDOFF_MAX} characters, got ${note.length}`, path: "note" }));
    }
    return note;
  });

type CheckSide = "outgoing" | "incoming";

/** `<checkId>=<exitCode>` as one result on `side`; the flags carry no output. */
const flaggedResult = (side: CheckSide, value: string) =>
  Effect.flatMap(pairOf(side, "<checkId>=<exitCode>", value, value.lastIndexOf("=")), ([checkId, code]) =>
    /^-?\d+$/.test(code)
      ? Effect.succeed({ checkId, side, exitCode: Number(code), outputTail: "" })
      : Effect.fail(new InputError({ message: `--${side} takes <checkId>=<exitCode>, got ${JSON.stringify(value)}`, path: side })));

/** The results the flags name, or the JSON --results carries; one way or the other. Each tail keeps its last CHECK_OUTPUT_TAIL_MAX characters (UTF-16 code units), as main counts them. */
export const checkResultsOf = (flags: {
  readonly outgoing: ReadonlyArray<string>;
  readonly incoming: ReadonlyArray<string>;
  readonly results: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const flagged = yield* Effect.forEach(
      [...flags.outgoing.map((value) => ["outgoing", value] as const), ...flags.incoming.map((value) => ["incoming", value] as const)],
      ([side, value]) => flaggedResult(side, value),
    );
    if (Option.isSome(flags.results) === (flagged.length > 0)) {
      return yield* Effect.fail(new InputError({ message: "report results with --outgoing and --incoming, or with --results, not both", path: "results" }));
    }
    const results = Option.isSome(flags.results) ? yield* loadJsonInput(TaskCheckArgs.fields.results, flags.results.value) : flagged;
    return results.map((result) => ({ ...result, outputTail: result.outputTail.slice(-CHECK_OUTPUT_TAIL_MAX) }));
  });

const checkCommand = Command.make(
  "check",
  {
    task: taskArg,
    outgoing: repeated("outgoing", "A check of this node you ran: <checkId>=<exitCode>; repeat for several"),
    incoming: repeated("incoming", "A check of the next node you ran: <checkId>=<exitCode>; repeat for several"),
    results: Flag.string("results").pipe(
      Flag.optional,
      Flag.withDescription(`Instead of the flags: [{checkId, side, exitCode, outputTail}] as JSON, @file or -; each tail keeps its last ${CHECK_OUTPUT_TAIL_MAX} characters`),
    ),
    next: Flag.string("next").pipe(Flag.optional, Flag.withDescription("The node whose incoming checks these answer, when there are several")),
    opId: opIdFlag,
    timeout: timeoutFlag,
  },
  ({ task, outgoing, incoming, results, next, opId, timeout }) =>
    executeJsonCommand(
      "task check",
      Effect.gen(function* () {
        const reported = yield* checkResultsOf({ outgoing, incoming, results });
        return yield* call("task.check", { opId: yield* opIdOf(opId), task, ...present({ next }), results: reported }, timeout);
      }),
    ),
).pipe(Command.withDescription(DESCRIPTIONS.check));

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
    verdict: Argument.choice("verdict", ["approve", "changes"] as const).pipe(
      Argument.withDescription("approve, or changes (with --text saying what to change)"),
    ),
    text: Flag.string("text").pipe(Flag.optional, Flag.withDescription("What to change, with changes; a note with approve")),
    subjectHash: Flag.string("subject-hash").pipe(Flag.optional, Flag.withDescription("Optional: the hash of what you reviewed, a commit sha say, kept on the stamp")),
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
    checkCommand,
    oneCommand("cancel"),
    oneCommand("archive"),
    dependCommand("depend"),
    dependCommand("undepend"),
    reviewerCommand,
    stampPolicyCommand,
    stampCommand,
    commentCommand,
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

const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";
const ID = "01M5ESMQ2ZT55QZ073EWPH10SG";

/** The args as sent: a write carries the opId the CLI minted, and create the task's id too. */
const example = (verb: Verb, name: string, description: string, args: ReadonlyArray<string>, input: object): CommandExample => ({
  command_id: opOf(verb),
  command: commandOf(verb),
  name,
  description,
  input: isTaskWriteOp(opOf(verb)) ? { opId: OP, ...(verb === "create" ? { taskId: ID } : {}), ...input } : input,
  args: [...commandOf(verb).split(" "), ...args],
});

export const taskExamples: ReadonlyArray<CommandExample> = [
  example("list", "my open tasks", "Every task node in reach, assigned to this seat.", ["--assignee", "me"], { assignee: "me" }),
  example("list", "reviews I owe", "In review, naming this seat, with no stamp from it at the current epoch; longest waiting first.", ["--reviewer", "me"], {
    reviewer: "me",
  }),
  example("create", "add a task", "Lands in backlog on the one task node in reach.", ["Ship the task CLI", "--stamps", "1"], {
    title: "Ship the task CLI",
    stamps: 1,
  }),
  example("assign", "hand a task to a seat", "The seat is mailed in the task's thread.", ["#42", "@cli-identity"], { task: "#42", seat: "@cli-identity" }),
  example("start", "start my task", "assigned becomes working.", ["#42"], { task: "#42" }),
  example("finish", "finish and send on", "--next names the downstream node when there are several.", ["#42", "--next", "Review"], { task: "#42", next: "Review" }),
  example("finish", "finish with evidence", "--claim answers a rule in force; --commit cites the work.", ["#42", "--commit", "2e219a5ca", "--claim", "tests=work-cli passes under all-on"], {
    task: "#42",
    evidence: { artifacts: [], git: { commits: ["2e219a5ca"] }, claims: [{ ruleId: "tests", text: "work-cli passes under all-on" }] },
  }),
  example("finish", "finish with a handoff note", "--note leaves a note on the layer for whoever picks the work up next; @file or - reads it.", ["#42", "--next", "Review", "--note", "@handoff.md"], {
    task: "#42",
    next: "Review",
    handoff: "The replay path is covered; the e2e still flakes on a cold start.",
  }),
  example("check", "report checks", "Each check you ran, with its exit code; a red one blocks the finish.", ["#42", "--outgoing", "tests=0", "--outgoing", "lint=1"], {
    task: "#42",
    results: [
      { checkId: "tests", side: "outgoing", exitCode: 0, outputTail: "" },
      { checkId: "lint", side: "outgoing", exitCode: 1, outputTail: "" },
    ],
  }),
  example("check", "report checks with output", "--results carries each output's tail; @file or - reads it.", ["#42", "--next", "Review", "--results", "@checks.json"], {
    task: "#42",
    next: "Review",
    results: [{ checkId: "e2e", side: "incoming", exitCode: 1, outputTail: "1 failed: replay keeps the opId" }],
  }),
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
