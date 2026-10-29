/**
 * An automation's `signal` step (0.11/07 N2, 0.11/09): a seat's kind of
 * signal, or a notice, in the operator's needs-you feed, raised from the
 * Automations node, never a seat. One signal per firing, never merged.
 *
 * The step was ruled in reach when the firing was admitted (`targetNodeIds`
 * names its shown artifacts and its form's Artifacts node), so its form is
 * settled by the seat raise's own rule against those targets: an
 * overseer-authored automation reaches what its author reaches. Its id is the
 * firing's, so a retried firing raises it once. Its ruling keeps the firing's
 * values, which `raised.<name>` says when the answer comes back.
 */
import { Effect, Result } from "effect";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import {
  type Action,
  type ActionRuling,
  AUTOMATION_CODE_VALUE_MAX_CHARS,
  AUTOMATION_RAISED_VALUES_MAX,
  type Automation,
  signalTakesForm,
  targetNodeIds,
} from "@shared/automation";
import type { Canvas } from "@shared/model";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  normalizeSignalText,
  type AgentSignalArtifactAttachment,
  type SignalFormRequest,
} from "@shared/agent-signals";
import { resolveSignalForm } from "../signals/form-rule";
import type { AgentSignalRepository } from "../signals/repository";

export type SignalAction = Extract<Action, { readonly kind: "signal" }>;

export type SignalActionInput = {
  readonly canvas: Canvas | undefined;
  readonly canvasName: string;
  /** The machine this firing runs on, by its short name: a secret form's value is for it. */
  readonly machine: string | undefined;
  readonly automation: Automation;
  readonly action: SignalAction;
  readonly index: number;
  /** The firing's values as its signal step says them, kept on the ruling. */
  readonly values: Readonly<Record<string, string>>;
  /** The action's text with its values said. */
  readonly resolve: (text: string) => Effect.Effect<string>;
  /** The firing performing the step, named on the signal's source so the feed opens that run. */
  readonly firingId: string;
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

/** The values a ruling keeps: each cut to a value's length, at most AUTOMATION_RAISED_VALUES_MAX. */
const keptValues = (values: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values)
      .slice(0, AUTOMATION_RAISED_VALUES_MAX)
      .map(([name, value]) => [name, [...value].slice(0, AUTOMATION_CODE_VALUE_MAX_CHARS).join("")]),
  );

/** Raise the step's signal. Never fails: a refusal is a ruling. */
export const performSignalAction = (
  signals: AgentSignalRepository["Service"],
  input: SignalActionInput,
): Effect.Effect<ActionRuling> =>
  Effect.gen(function* () {
    const { action, automation, index } = input;
    const raisedRuling: ActionRuling = {
      index,
      ruling: "raised",
      signalId: input.signalId,
      ...(action.id === undefined ? {} : { step: action.id }),
      values: keptValues(input.values),
    };
    // Raised once: a retried firing finds its signal and is done.
    const existing = yield* signals.get(input.signalId).pipe(Effect.option);
    if (existing._tag === "Some") return raisedRuling;

    const text = clip(normalizeSignalText(yield* input.resolve(action.title)), AGENT_SIGNAL_MAX_TEXT_LENGTH);
    if (text === "") return invalid(index);
    const detail = action.detail === undefined ? "" : clip(yield* input.resolve(action.detail), AGENT_SIGNAL_MAX_DETAIL_LENGTH);
    // A notice or feedback takes no form (`actionRefusal`): a stored one with a form is wrong, and says so.
    if (action.form !== undefined && !signalTakesForm(action.signal)) return invalid(index);
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
    const attachments = (action.show ?? []).flatMap((shown): ReadonlyArray<AgentSignalArtifactAttachment> =>
      shown.kind === "artifact" ? [{ kind: "artifact", nodeId: shown.nodeId, artifactId: shown.artifactId }] : []);

    const raised = yield* signals.raise({
      canvasName: input.canvasName,
      nodeId: automation.nodeId,
      signalId: input.signalId,
      kind: action.signal,
      text,
      ...(detail === "" ? {} : { detail }),
      source: { kind: "automation", automationId: automation.automationId, nodeId: automation.nodeId, firingId: input.firingId },
      ...(form === undefined ? {} : { form }),
      ...(attachments.length === 0 ? {} : { attachments }),
    }).pipe(Effect.result);
    return raised._tag === "Success" ? raisedRuling : notAvailable(index);
  });
