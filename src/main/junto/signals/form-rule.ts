import { Result } from "effect";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { foldArtifactLabels } from "@shared/artifact-labels";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { resolveTarget } from "@shared/target-resolution";
import type { TargetCandidate, WorkErrorBody } from "@shared/work-control";
import {
  SIGNAL_DEFAULT_MIN_WORDS,
  type AgentSignalKind,
  type SignalForm,
  type SignalFormRequest,
} from "@shared/wire/agent-signals";

/**
 * What a signal's raise asks the operator to produce, resolved into the form
 * the signal stores (0.11/07, N1). The raise names an Artifacts node; main
 * finds it in the seat's reach and stores its id, so a form can never point a
 * document at a shelf the asking seat cannot reach.
 *
 * One form per signal. `text` is today's reply and needs nothing, `proof` is
 * text with links or files, and `artifact` writes a document of at least
 * `minWords` words. The `secret` form waits for the vault (N5): no typed
 * value crosses machines, so a raise that asks for one is refused here until
 * the vault lands, plainly.
 */
/**
 * Which kinds may ask for a form at all. A notice is read and cleared, and a
 * review asks the operator to look, not to produce: neither carries one.
 */
export const signalKindTakesForm = (kind: AgentSignalKind): boolean => kind !== "notice" && kind !== "feedback";

export const resolveSignalForm = (input: {
  readonly board: Canvas;
  /**
   * The nodes this raise may write into, already ruled: a seat's reach, or the
   * targets a firing ruled. Only an Artifacts node among them can hold a form.
   */
  readonly reaches: ReadonlyArray<NodeId>;
  readonly text: string;
  readonly request: SignalFormRequest;
}): Result.Result<SignalForm, WorkErrorBody> => {
  const request = input.request;
  switch (request.kind) {
    case "text":
      return Result.succeed({ kind: "text" });
    case "proof":
      return Result.succeed({ kind: "proof" });
    case "secret":
      return Result.fail({
        type: "InvalidTransition",
        message: `the secret form arrives with the vault (0.11, N5): a value never crosses machines through Junto`,
        details: {
          path: "args.form",
          retryable: false,
          next_step: `ask for ${request.name} in words for now and write it on the machine that reads it`,
        },
      });
    case "artifact":
      return artifactForm(input, request);
  }
};

const refusal = (input: {
  readonly type: WorkErrorBody["type"];
  readonly message: string;
  readonly path: string;
  readonly nextStep?: string;
  readonly candidates?: ReadonlyArray<TargetCandidate>;
}): Result.Result<never, WorkErrorBody> =>
  Result.fail({
    type: input.type,
    message: input.message,
    details: {
      path: input.path,
      retryable: false,
      ...(input.nextStep === undefined ? {} : { next_step: input.nextStep }),
      ...(input.candidates === undefined ? {} : { candidates: input.candidates }),
    },
  });

/** How a candidate reads in a refusal: its name and the id to send instead. */
const named = (candidate: TargetCandidate): string => `${candidate.name} [${candidate.nodeId}]`;

const artifactForm = (
  input: { readonly board: Canvas; readonly reaches: ReadonlyArray<NodeId>; readonly text: string },
  request: Extract<SignalFormRequest, { readonly kind: "artifact" }>,
): Result.Result<SignalForm, WorkErrorBody> => {
  const candidates: ReadonlyArray<TargetCandidate> = input.reaches.flatMap((nodeId) => {
    const node = input.board.nodes.get(nodeId);
    return node?.kind === "artifacts" ? [{ kind: "artifacts" as const, nodeId, name: titleOf(node) }] : [];
  });
  const resolved = resolveTarget({
    typed: request.node,
    candidates,
    kindOf: (nodeId) => input.board.nodes.get(nodeId as NodeId)?.kind,
  });
  if (!resolved.ok) {
    return refusal({
      type: resolved.reason === "malformed" ? "InputError" : "UnknownTarget",
      message:
        resolved.reason === "malformed"
          ? resolved.message
          : candidates.length === 0
            ? `nothing you reach is an Artifacts node called ${JSON.stringify(request.node.trim())}, and this seat reaches no Artifacts node`
            : `nothing you reach is an Artifacts node called ${JSON.stringify(request.node.trim())}; you can reach ${candidates.map(named).join("; ")}`,
      path: "args.form.node",
      nextStep:
        candidates.length === 0
          ? "a form writes into an Artifacts node in this seat's region; the operator places one there first"
          : `send the id of one of: ${candidates.map(named).join("; ")}`,
      candidates,
    });
  }
  const shelf = candidates.find((candidate) => candidate.nodeId === resolved.target.nodeId);
  if (shelf === undefined) {
    return refusal({
      type: "InputError",
      message: `${JSON.stringify(request.node.trim())} is not an Artifacts node you reach`,
      path: "args.form.node",
      nextStep: candidates.length === 0 ? "a form writes into an Artifacts node in this seat's region" : `send the id of one of: ${candidates.map(named).join("; ")}`,
      candidates,
    });
  }
  const labels = foldArtifactLabels(request.labels ?? []);
  if (!labels.ok) {
    return refusal({
      type: "InputError",
      message: labels.message,
      path: labels.index === undefined ? "args.form.labels" : `args.form.labels[${labels.index}]`,
    });
  }
  return Result.succeed({
    kind: "artifact",
    nodeId: shelf.nodeId,
    title: request.title ?? clipTitle(input.text),
    labels: labels.labels,
    minWords: request.minWords ?? SIGNAL_DEFAULT_MIN_WORDS,
  });
};

/** A document's title: the signal's own sentence, cut to the length a title has. */
const clipTitle = (text: string): string => text.trim().slice(0, ARTIFACT_MAX_TITLE_LENGTH).trim();
