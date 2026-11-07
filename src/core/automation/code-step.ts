/**
 * An automation's code step (plan 0.11/05, Code steps, track K1): what the
 * step hands the program and what its answer does to the firing. The
 * process itself, the SDK, the bounds and the scrub are K2's, behind
 * `AutomationCodeRunner` (code-runner.ts fills it). With no runner a code
 * step is refused `not_available`.
 *
 * The domain holds checks 1, 3 and 5 of the security doctrine before this
 * runs: the definition came as an applied ruling, its code's author is the
 * one stamped there (`codeAuthor`), and the automation names this machine.
 * The runner holds check 2: the digest of the bytes it runs.
 */
import { Context, Effect, Layer } from "effect";
import {
  AUTOMATION_CODE_MESSAGE_MAX_CHARS,
  AUTOMATION_CODE_OUTPUT_MAX_BYTES,
  AUTOMATION_CODE_TAIL_MAX_CHARS,
  AUTOMATION_CODE_TIMEOUT_DEFAULT_MS,
  type Action,
  type ActionRuling,
  type Automation,
  type FiringCause,
  type FiringId,
} from "@shared/automation";
import { ContentService } from "../content/service";
import { MachineRepository } from "../machines/repository";
import { contentSourceReader, makeCodeRunner, type CodeResult, type CodeRunError, type CodeRunRequest } from "./code-runner";

export type CodeStep = Extract<Action, { readonly kind: "code" }>;

/** K2's runner, as the automation runner reaches it. */
export class AutomationCodeRunner extends Context.Service<
  AutomationCodeRunner,
  { readonly runCode: (request: CodeRunRequest) => Effect.Effect<CodeResult, CodeRunError> }
>()("@junto/AutomationCodeRunner") {}

/** This machine's runner: sources from its content store, refusals named with its short name. */
export const AutomationCodeRunnerLive = Layer.effect(
  AutomationCodeRunner,
  Effect.gen(function* () {
    const content = yield* ContentService;
    const machine = yield* (yield* MachineRepository).machineName.pipe(Effect.orElseSucceed(() => "this machine"));
    return makeCodeRunner({ machine, readSource: contentSourceReader(content) });
  }),
);

type Tail = { readonly text: string };

const words = (text: string, max: number): string | undefined => {
  const kept = [...text.trim()].slice(0, max).join("");
  return kept.length === 0 ? undefined : kept;
};

/** The end of the log, which a failure keeps for the firing. */
const tailOf = (tail: Tail | undefined): string | undefined => {
  const text = tail?.text.trim() ?? "";
  return text.length === 0 ? undefined : [...text].slice(-AUTOMATION_CODE_TAIL_MAX_CHARS).join("");
};

const failed = (index: number, message: string, durationMs: number, tail: Tail | undefined, exitCode?: number): ActionRuling => {
  const logTail = tailOf(tail);
  return {
    index,
    ruling: "failed",
    message: words(message, AUTOMATION_CODE_MESSAGE_MAX_CHARS) ?? "The step failed",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(logTail === undefined ? {} : { logTail }),
    durationMs: Math.max(0, Math.round(durationMs)),
  };
};

/** One run's answer as the firing records it. */
export const codeRulingOf = (index: number, result: CodeResult): ActionRuling => {
  const durationMs = Math.max(0, Math.round(result.durationMs));
  switch (result.kind) {
    case "continue":
      return { index, ruling: "continued", output: result.output, durationMs };
    case "stop": {
      const reason = result.reason === undefined ? undefined : words(result.reason, AUTOMATION_CODE_MESSAGE_MAX_CHARS);
      return { index, ruling: "stopped", ...(reason === undefined ? {} : { reason }), durationMs };
    }
    case "fail":
      return failed(index, result.message, durationMs, result.logTail, result.exitCode);
    case "timeout":
      return failed(index, "timeout", durationMs, result.logTail);
    case "too_large":
      return failed(index, "too_large", durationMs, result.logTail);
    default:
      return result satisfies never;
  }
};

/** A run that never started, as the firing records it: a failed check is `not_permitted`. */
export const codeRefusalOf = (index: number, failure: CodeRunError): ActionRuling => {
  switch (failure._tag) {
    case "CodeNotPermitted":
      return { index, ruling: "refused", reason: "not_permitted" };
    case "CodeSourceUnavailable":
    case "CodeRuntimeMissing":
      return { index, ruling: "refused", reason: "not_available" };
    case "CodeSpawnFailed":
      return failed(index, failure.message, 0, undefined);
    default:
      return failure satisfies never;
  }
};

/** Where the step stands when it runs: what the domain and this machine supply. */
export type CodeStepContext = {
  readonly canvasName: string;
  readonly automation: Automation;
  readonly step: CodeStep;
  readonly index: number;
  readonly firingId: FiringId;
  readonly at: number;
  readonly cause: FiringCause["kind"];
  readonly event: unknown;
  readonly values: Readonly<Record<string, string>>;
  /** Under an artifact trigger, the artifact that fired it, its body included (B1): structured input, never text. */
  readonly artifact?: CodeArtifact;
  readonly env: Readonly<Record<string, string>>;
};

/** The artifact a code step reads when an artifact's change fired it. */
export type CodeArtifact = {
  readonly artifactId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly version: number;
  readonly labels: ReadonlyArray<string>;
  readonly body: unknown;
};

/**
 * Run one code step. Never fails: a refusal or a failure is its ruling. Its
 * author and ruling installation are the ones the ruler stamped on the code
 * (`codeRuling`), never the canvas's editor now or a later edit's actor;
 * code with none stamped is refused.
 */
export const runCodeStep = (
  runner: AutomationCodeRunner["Service"] | undefined,
  context: CodeStepContext,
): Effect.Effect<ActionRuling> => {
  const { automation, step, index } = context;
  if (runner === undefined) return Effect.succeed({ index, ruling: "refused", reason: "not_available" });
  const ruled = automation.codeRuling;
  if (ruled?.installation === undefined) return Effect.succeed({ index, ruling: "refused", reason: "not_permitted" });
  // The artifact rides beside the base input: the SDK reads the stdin JSON whole.
  const input = {
    automation: { automationId: automation.automationId, name: automation.name, nodeId: automation.nodeId },
    firing: { firingId: context.firingId, at: context.at, cause: context.cause },
    trigger: automation.trigger,
    event: context.event ?? null,
    values: context.values,
    ...(context.artifact === undefined ? {} : { artifact: context.artifact }),
  };
  return runner
    .runCode({
      canvasName: context.canvasName,
      source: step.source,
      language: step.language,
      input,
      timeoutMs: step.timeoutMs ?? AUTOMATION_CODE_TIMEOUT_DEFAULT_MS,
      maxOutputBytes: AUTOMATION_CODE_OUTPUT_MAX_BYTES,
      env: context.env,
    })
    .pipe(
      Effect.map((result) => codeRulingOf(index, result)),
      Effect.catch((failure) => Effect.succeed(codeRefusalOf(index, failure))),
      Effect.catchDefect(() => Effect.succeed(failed(index, "The step could not be run", 0, undefined))),
    );
};
