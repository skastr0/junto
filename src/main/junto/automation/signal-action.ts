/**
 * An automation's `signal` step (0.11/07 N2): a notice or a work signal in the
 * operator's needs-you feed, raised from the Automations node, never a seat.
 *
 * The step was ruled in reach when the firing was admitted (`targetNodeIds`
 * names its shown artifacts and its form's Artifacts node), so the form is
 * settled here as a seat raise settles it, without a second reach check: an
 * overseer-authored automation reaches what its author reaches, which the
 * seat-side rule does not see. Its id is the firing's, so a retried firing
 * raises it once.
 */
import { Effect } from "effect";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { foldArtifactLabels } from "@shared/artifact-labels";
import type { Action, ActionRuling, Automation } from "@shared/automation";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  normalizeSignalText,
  SIGNAL_DEFAULT_MIN_WORDS,
  type AgentSignalArtifactAttachment,
  type SignalForm,
  type WorkTiming,
} from "@shared/agent-signals";
import type { AgentSignalRepository } from "../signals/repository";
import type { Fired } from "./values";

export type SignalAction = Extract<Action, { readonly kind: "signal" }>;

export type SignalActionInput = {
  readonly canvasName: string;
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

/** The stored form, settled as a seat raise settles it; undefined when this version cannot ask for it. */
const settledForm = (
  form: NonNullable<SignalAction["form"]>,
  text: string,
  resolve: (text: string) => Effect.Effect<string>,
): Effect.Effect<SignalForm | "secret" | "labels"> =>
  Effect.gen(function* () {
    switch (form.kind) {
      case "text":
      case "proof":
        return form;
      // The secret form waits for the vault (N5); the raise refuses it, so the step does too.
      case "secret":
        return "secret";
      case "artifact": {
        const labels = foldArtifactLabels(form.labels ?? []);
        if (!labels.ok) return "labels";
        const named = form.title === undefined ? "" : clip(normalizeSignalText(yield* resolve(form.title)), ARTIFACT_MAX_TITLE_LENGTH);
        return {
          kind: "artifact",
          nodeId: form.node,
          title: named === "" ? clip(text, ARTIFACT_MAX_TITLE_LENGTH) : named,
          labels: labels.labels,
          minWords: form.minWords ?? SIGNAL_DEFAULT_MIN_WORDS,
        };
      }
    }
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
    // A notice is read and cleared: it carries no form and falls due never (`actionRefusal`).
    const form = action.form === undefined || action.signal !== "work" ? undefined : yield* settledForm(action.form, text, input.resolve);
    if (form === "secret") return notAvailable(index);
    if (form === "labels") return invalid(index);
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
