import { Schema } from "effect";
import {
  CloseRequest,
  CommentRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  StopRequest,
} from "../../shared/browser-control";
import type {
  CommandCapability,
  CommandCategory,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";

/**
 * Discovery for `junto browser`: one row per command, each with its input
 * schema. Inputs are positional, with `--tab` where a command can name a
 * tab; the schema names the same fields the control route receives.
 */
export type BrowserCommandName =
  | "doctor"
  | "profiles"
  | "pages"
  | "sessions"
  | "open"
  | "goto"
  | "eval"
  | "shot"
  | "comment"
  | "close"
  | "stop";

interface BrowserCommandSpec {
  readonly usage: string;
  readonly category: CommandCategory;
  readonly description: string;
  readonly schema: Schema.Struct<Schema.Struct.Fields>;
}

const TAB = " With --tab <tab> it acts on this seat's session of that tab, joined with open --tab; without, on the active tab.";

export const BROWSER_COMMANDS = {
  doctor: {
    usage: "doctor",
    category: "diagnostic",
    description: "Browser control plane health. Needs only the app running.",
    schema: Schema.Struct({}),
  },
  profiles: {
    usage: "profiles",
    category: "discovery",
    description: "List browser profiles.",
    schema: Schema.Struct({}),
  },
  pages: {
    usage: "pages",
    category: "discovery",
    description: "List the page nodes this seat's navigates edges grant.",
    schema: Schema.Struct({}),
  },
  sessions: {
    usage: "sessions",
    category: "discovery",
    description: "List this seat's live page sessions.",
    schema: Schema.Struct({}),
  },
  open: {
    usage: "open <node-ref> [--tab <tab>]",
    category: "workflow",
    description: "Open or reuse a session on a granted page. With --tab <tab> it joins that tab and returns its session; without, the active tab.",
    schema: OpenRequest,
  },
  goto: {
    usage: "goto <sessionId> <url> [--tab <tab>]",
    category: "workflow",
    description: `Navigate a page session.${TAB}`,
    schema: GotoRequest,
  },
  eval: {
    usage: "eval <sessionId> <code> [--tab <tab>]",
    category: "workflow",
    description: `Run JavaScript in the page and return its JSON result.${TAB}`,
    schema: EvalRequest,
  },
  shot: {
    usage: "shot <sessionId> [--tab <tab>]",
    category: "workflow",
    description: `Capture a screenshot to a PNG Junto owns, and return its path.${TAB}`,
    schema: ScreenshotRequest,
  },
  comment: {
    usage: "comment <sessionId> --box <x,y,w,h> --text <text> [--tab <tab>]",
    category: "workflow",
    description: `Comment on a box of the page as this seat, with a shot of the box, and return the message and thread ids. Only on the machine that edits the canvas; elsewhere control refuses it as forbidden.${TAB}`,
    schema: CommentRequest,
  },
  close: {
    usage: "close <sessionId>",
    category: "workflow",
    description: "Detach the page surface; the session stays warm.",
    schema: CloseRequest,
  },
  stop: {
    usage: "stop <sessionId>",
    category: "workflow",
    description: "Destroy the page runtime; the profile stays.",
    schema: StopRequest,
  },
} as const satisfies Record<BrowserCommandName, BrowserCommandSpec>;

export const BROWSER_COMMAND_NAMES = Object.keys(BROWSER_COMMANDS) as ReadonlyArray<BrowserCommandName>;

export const browserSchemas: ReadonlyArray<CommandSchemaContract> = BROWSER_COMMAND_NAMES.map((name) => ({
  command_id: `browser.${name}`,
  command: `browser ${BROWSER_COMMANDS[name].usage}`,
  schema_id: `browser.${name}.input/v1`,
  description: BROWSER_COMMANDS[name].description,
  schema: BROWSER_COMMANDS[name].schema,
  input_modes: ["positional"],
}));

const PAGE_REF = "junto://canvas/work?node=page-1";

export const browserExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "browser.pages",
    command: "browser pages",
    name: "list granted pages",
    args: ["browser", "pages"],
    input: {},
  },
  {
    command_id: "browser.open",
    command: "browser open <node-ref>",
    name: "open a granted page",
    args: ["browser", "open", PAGE_REF],
    input: { ref: PAGE_REF },
  },
  {
    command_id: "browser.shot",
    command: "browser shot <sessionId> --tab <tab>",
    name: "capture one tab",
    args: ["browser", "shot", "session-1", "--tab", "tab-2"],
    input: { sessionId: "session-1", tab: "tab-2" },
  },
  {
    command_id: "browser.comment",
    command: "browser comment <sessionId> --box <x,y,w,h> --text <text>",
    name: "comment on a box of the page",
    args: ["browser", "comment", "session-1", "--box", "40,120,320,80", "--text", "this button overlaps the title"],
    input: { sessionId: "session-1", rect: { x: 40, y: 120, w: 320, h: 80 }, text: "this button overlaps the title" },
  },
];

export const browserCapabilities: ReadonlyArray<CommandCapability> = BROWSER_COMMAND_NAMES.map((name, index) => ({
  command_id: `browser.${name}`,
  command: `browser ${name}`,
  category: BROWSER_COMMANDS[name].category,
  description: BROWSER_COMMANDS[name].description,
  schemas: [browserSchemas[index]!],
  examples: browserExamples.filter((example) => example.command_id === `browser.${name}`),
}));
