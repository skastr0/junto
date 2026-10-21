import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Result, Schema } from "effect";
import type { ControlRouteName } from "../../shared/browser-control";
import { InputError } from "../core/errors";
import { executeJsonCommand } from "../core/output";
import { callBrowserControl } from "../core/browser-control-client";
import { BROWSER_COMMANDS, type BrowserCommandName } from "./browser-contract";

/**
 * `junto browser`: drive a page this seat's navigates edge grants. Every
 * command answers in the standard envelope; transport is the browser control
 * socket, which admits the calling process through its edge grant.
 */

const ROUTE = {
  doctor: "doctor",
  profiles: "profiles",
  pages: "pages",
  sessions: "sessions",
  open: "open",
  goto: "goto",
  eval: "eval",
  shot: "screenshot",
  comment: "comment",
  close: "close",
  stop: "stop",
} as const satisfies Record<BrowserCommandName, ControlRouteName>;

const sessionArg = Argument.string("sessionId").pipe(
  Argument.withDescription("Session id, as junto browser open or sessions prints it"),
);

const tabFlag = Flag.string("tab").pipe(
  Flag.optional,
  Flag.withDescription("Tab to act on; without it, the page's active tab"),
);

/** The request body for a command, checked against its schema before transport. */
export const browserRequestBody = (
  name: BrowserCommandName,
  fields: Readonly<Record<string, unknown>>,
): Result.Result<Record<string, unknown> | undefined, InputError> => {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body[key] = value;
  // An empty Struct takes any field, so the field list is checked here too.
  const unknown = Object.keys(body).find((key) => !(key in BROWSER_COMMANDS[name].schema.fields));
  if (unknown !== undefined) {
    return Result.fail(
      new InputError({
        message: `browser ${name} takes no ${unknown}`,
        path: unknown,
        next_step: `junto schema show browser.${name}`,
      }),
    );
  }
  const decoded = Schema.decodeUnknownResult(BROWSER_COMMANDS[name].schema as never, {
    onExcessProperty: "error",
  })(body);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new InputError({
        message: String(decoded.failure.message).slice(0, 400),
        next_step: `junto schema show browser.${name}`,
      }),
    );
  }
  return Result.succeed(Object.keys(body).length === 0 ? undefined : body);
};

/** `--box x,y,w,h` as the rect the comment route takes: four finite numbers. */
export const parseBox = (box: string): Result.Result<{ x: number; y: number; w: number; h: number }, InputError> => {
  const parts = box.split(",").map((part) => part.trim());
  const numbers = parts.map(Number);
  if (parts.length !== 4 || parts.some((part) => part === "") || !numbers.every(Number.isFinite)) {
    return Result.fail(
      new InputError({
        message: `--box takes four numbers x,y,w,h, not ${JSON.stringify(box.slice(0, 80))}`,
        path: "box",
        next_step: "junto schema show browser.comment",
      }),
    );
  }
  const [x, y, w, h] = numbers as [number, number, number, number];
  return Result.succeed({ x, y, w, h });
};

const run = (
  name: BrowserCommandName,
  fields: Readonly<Record<string, unknown>> | Result.Result<Readonly<Record<string, unknown>>, InputError> = {},
) =>
  executeJsonCommand(
    `browser ${name}`,
    Effect.gen(function* () {
      const checked = Result.isResult(fields) ? yield* Effect.fromResult(fields) : fields;
      const body = yield* Effect.fromResult(browserRequestBody(name, checked));
      return yield* callBrowserControl(ROUTE[name], body);
    }),
  );

const tabOf = (tab: Option.Option<string>) => Option.getOrUndefined(tab);

const describe = (name: BrowserCommandName) => Command.withDescription(BROWSER_COMMANDS[name].description);

const noInput = (name: "doctor" | "profiles" | "pages" | "sessions") =>
  Command.make(name, {}, () => run(name)).pipe(describe(name));

const openCommand = Command.make(
  "open",
  {
    ref: Argument.string("node-ref").pipe(Argument.withDescription("The page node, as junto browser pages prints it")),
    tab: tabFlag,
  },
  ({ ref, tab }) => run("open", { ref, tab: tabOf(tab) }),
).pipe(describe("open"));

const gotoCommand = Command.make(
  "goto",
  { sessionId: sessionArg, url: Argument.string("url"), tab: tabFlag },
  ({ sessionId, url, tab }) => run("goto", { sessionId, url, tab: tabOf(tab) }),
).pipe(describe("goto"));

const evalCommand = Command.make(
  "eval",
  { sessionId: sessionArg, code: Argument.string("code"), tab: tabFlag },
  ({ sessionId, code, tab }) => run("eval", { sessionId, code, tab: tabOf(tab) }),
).pipe(describe("eval"));

const shotCommand = Command.make(
  "shot",
  { sessionId: sessionArg, tab: tabFlag },
  ({ sessionId, tab }) => run("shot", { sessionId, tab: tabOf(tab) }),
).pipe(describe("shot"));

const commentCommand = Command.make(
  "comment",
  {
    sessionId: sessionArg,
    box: Flag.string("box").pipe(Flag.withDescription("The box to comment on, as x,y,w,h in page pixels")),
    text: Flag.string("text").pipe(Flag.withDescription("The comment")),
    tab: tabFlag,
  },
  ({ sessionId, box, text, tab }) =>
    run("comment", Result.map(parseBox(box), (rect) => ({ sessionId, tab: tabOf(tab), rect, text }))),
).pipe(describe("comment"));

const closeCommand = Command.make("close", { sessionId: sessionArg }, ({ sessionId }) =>
  run("close", { sessionId }),
).pipe(describe("close"));

const stopCommand = Command.make("stop", { sessionId: sessionArg }, ({ sessionId }) =>
  run("stop", { sessionId }),
).pipe(describe("stop"));

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Drive a page this seat's navigates edge grants"),
  Command.withSubcommands([
    noInput("doctor"),
    noInput("profiles"),
    noInput("pages"),
    noInput("sessions"),
    openCommand,
    gotoCommand,
    evalCommand,
    shotCommand,
    commentCommand,
    closeCommand,
    stopCommand,
  ]),
);
