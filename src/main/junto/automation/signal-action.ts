/**
 * An automation's `signal` step (0.11/07 N2): a notice or a work signal in the
 * operator's needs-you feed, raised from the Automations node, never a seat.
 *
 * The step was ruled in reach when the firing was admitted (`targetNodeIds`
 * names its shown artifacts and its form's Artifacts node), so its form is
 * settled by the seat raise's own rule against those targets: an
 * overseer-authored automation reaches what its author reaches. Its id is the
 * firing's, so a retried firing raises it once.
 */
import { Effect, Result } from "effect";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { type Action, type ActionRuling, type Automation, targetNodeIds } from "@shared/automation";
import type { Canvas } from "@shared/model";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  normalizeSignalText,
  type AgentSignalArtifactAttachment,
  type SignalFormRequest,
  type WorkTiming,
} from "@shared/agent-signals";
import { resolveSignalForm } from "../signals/form-rule";
import type { AgentSignalRepository } from "../signals/repository";
import type { Fired } from "./values";

export type SignalAction = Extract<Action, { readonly kind: "signal" }>;

export type SignalActionInput = {
  readonly canvas: Canvas | undefined;
  readonly canvasName: string;
  /** The machine this firing runs on, by its short name: a secret form's value is for it. */
  readonly machine: string | undefined;
  readonly automation: Automation;
  readonly action: SignalAction;
  readonly index: number;
  readonly fired: Fired;
  /** The action's text with its values said. */
  readonly resolve: (text: string) => Effect.Effect<string>;
  /** The signal's id: stable for this firing's step. */
  readonly signalId: string;
};

const notAvailable = (index: number): ActionRuling => ({ index, ruling: "refused", reason: "not_available" });
const invalid = (index: number): ActionRuling => ({ index, ruling: "refused", reason: "invalid_input" });

/** Text its values made longer than its place allows is cut to fit, as a task title is. */
const clip = (text: string, max: number): string => [...text].slice(0, max).join("").trim();

/** The step's form as a raise asks for it: its title's values said, and cut to a document title's length. */
const formRequestOf = (
  form: NonNullable<SignalAction["form"]>,
  resolve: (text: string) => Effect.Effect<string>,
): Effect.Effect<SignalFormRequest> =>
  Effect.gen(function* () {
    if (form.kind !== "artifact") return form;
    const title = form.title === undefined ? "" : clip(normalizeSignalText(yield* resolve(form.title)), ARTIFACT_MAX_TITLE_LENGTH);
    return {
      kind: "artifact",
      node: form.node,
      ...(title === "" ? {} : { title }),
      ...(form.labels === undefined ? {} : { labels: form.labels }),
      ...(form.minWords === undefined ? {} : { minWords: form.minWords }),
    };
  });

/** Work's timing from the firing: due this long after it fired, and urgent as marked. */
const timingOf = (action: SignalAction, fired: Fired): WorkTiming | undefined => {
  if (action.signal !== "work" || action.work === undefined) return undefined;
  const { dueInMs, urgent } = action.work;
  if (dueInMs === undefined && urgent === undefined) return undefined;
  return {
    ...(dueInMs === undefined ? {} : { dueAt: fired.at + dueInMs }),
    ...(urgent === undefined ? {} : { urgent }),
  };
};

/** Raise the step's signal. Never fails: a refusal is a ruling. */
export const performSignalAction = (
  signals: AgentSignalRepository["Service"],
  input: SignalActionInput,
): Effect.Effect<ActionRuling> =>
  Effect.gen(function* () {
    const { action, automation, index } = input;
    // Raised once: a retried firing finds its signal and is done.
    const existing = yield* signals.get(input.signalId).pipe(Effect.option);
    if (existing._tag === "Some") return { index, ruling: "applied" } as const;

    const text = clip(normalizeSignalText(yield* input.resolve(action.title)), AGENT_SIGNAL_MAX_TEXT_LENGTH);
    if (text === "") return invalid(index);
    const detail = action.detail === undefined ? "" : clip(yield* input.resolve(action.detail), AGENT_SIGNAL_MAX_DETAIL_LENGTH);
    // A notice is read and cleared (`actionRefusal`): a stored one with a form is wrong, and says so.
    if (action.signal === "notice" && action.form !== undefined) return invalid(index);
    let form;
    if (action.form !== undefined) {
      if (input.canvas === undefined) return notAvailable(index);
      const settled = resolveSignalForm({
        board: input.canvas,
        reaches: targetNodeIds({ ...automation, then: [action] }),
        text,
        request: yield* formRequestOf(action.form, input.resolve),
        raiser: automation.nodeId,
        ...(input.machine === undefined ? {} : { machine: input.machine }),
      });
      if (Result.isFailure(settled)) {
        // The secret form waits for the vault (N5); a shelf gone or labels unfit are the step's own.
        const type = settled.failure.type;
        return type === "InvalidTransition" ? notAvailable(index) : type === "UnknownTarget" ? { index, ruling: "refused", reason: "unknown_target" } as const : invalid(index);
      }
      form = settled.success;
    }
    const work = timingOf(action, input.fired);
    const attachments = (action.show ?? []).flatMap((shown): ReadonlyArray<AgentSignalArtifactAttachment> =>
      shown.kind === "artifact" ? [{ kind: "artifact", nodeId: shown.nodeId, artifactId: shown.artifactId }] : []);

    const raised = yield* signals.raise({
      canvasName: input.canvasName,
      nodeId: automation.nodeId,
      signalId: input.signalId,
      kind: action.signal,
      text,
      ...(detail === "" ? {} : { detail }),
      source: { kind: "automation", automationId: automation.automationId, nodeId: automation.nodeId },
      ...(work === undefined ? {} : { work }),
      ...(form === undefined ? {} : { form }),
      ...(attachments.length === 0 ? {} : { attachments }),
    }).pipe(Effect.result);
    return raised._tag === "Success" ? ({ index, ruling: "applied" } as const) : notAvailable(index);
  });
