import { Result } from "effect";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { foldArtifactLabels } from "@shared/artifact-labels";
import { VAULT_ENABLED } from "@shared/features";
import { isThisMachine } from "@shared/machine-identity";
import type { Canvas, Region } from "@shared/model";
import { regionStack, titleOf } from "@shared/model";
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
 * `minWords` words.
 *
 * The `secret` form is the vault's (0.12, N5), behind VAULT_ENABLED: the raise
 * records the name, the machine the value is for and the region that declares
 * it, and the operator's value goes into the vault from the window, never
 * through Junto's rows. Off that flag, it is refused plainly, as before.
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
  /** Who is asking: the seat's node, or the Automations node. The regions around it are the secret's. */
  readonly raiser?: NodeId;
  /**
   * The machine that will read the value: a seat's own machine, or the machine
   * a firing ran on. Absent on an automation means the firing has no machine.
   */
  readonly machine?: string;
}): Result.Result<SignalForm, WorkErrorBody> => {
  const request = input.request;
  switch (request.kind) {
    case "text":
      return Result.succeed({ kind: "text" });
    case "proof":
      return Result.succeed({ kind: "proof" });
    case "secret":
      return secretForm(input, request);
    case "artifact":
      return artifactForm(input, request);
  }
};

/**
 * Where a secret lives, from the same plan a seat's environment is built
 * from: the regions around the asking node, innermost outward, the first that
 * declares the name for that machine. A sealed region cuts everything outside
 * it. Two regions at one depth that both declare the name are ambiguous, and
 * say so rather than guessing: the value would land where the seat might not
 * read it.
 */
export const secretSourceOf = (
  board: Canvas,
  raiser: NodeId,
  machine: string,
  name: string,
): { readonly region: Region; readonly sourceId: string } | "ambiguous" | undefined => {
  const stack = regionStack(board, raiser);
  let scope = stack;
  // A sealed region cuts everything outside it, the innermost seal winning.
  stack.forEach((region, index) => {
    if (region.environment?.sealed === true) scope = stack.slice(index);
  });
  const declaring = [...scope].reverse().flatMap((region) => {
    const sources = (region.environment?.sources ?? []).filter(
      (source) =>
        (source.kind === "onepassword" || source.kind === "secret") &&
        source.name === name &&
        (source.host === undefined || isThisMachine(source.host, machine)),
    );
    // Within one region a later source wins, as the environment's own plan says.
    const source = sources.at(-1);
    return source === undefined ? [] : [{ region, source }];
  });
  const first = declaring[0];
  if (first === undefined) return undefined;
  // Same depth reads as the same area on one canvas: identical frames, one level.
  const level = declaring.filter((entry) => entry.region.width * entry.region.height === first.region.width * first.region.height);
  return level.length > 1 ? "ambiguous" : { region: first.region, sourceId: first.source.id };
};

const secretForm = (
  input: { readonly board: Canvas; readonly raiser?: NodeId; readonly machine?: string },
  request: Extract<SignalFormRequest, { readonly kind: "secret" }>,
): Result.Result<SignalForm, WorkErrorBody> => {
  if (!VAULT_ENABLED) {
    return Result.fail({
      type: "InvalidTransition",
      message: "the secret form arrives with the vault (0.12, N5): a value never crosses machines through Junto",
      details: {
        path: "args.form",
        retryable: false,
        reason: "not_available",
        next_step: `ask for ${request.name} in words for now and write it on the machine that reads it`,
      },
    });
  }
  const raiser = input.raiser;
  const asked = raiser === undefined ? undefined : input.board.nodes.get(raiser);
  // A seat's machine is its own node's; a firing's is the machine it ran on, which only the caller knows.
  const machine = input.machine ?? (asked?.kind === "agent" ? asked.host : undefined);
  if (raiser === undefined || machine === undefined) {
    return Result.fail({
      type: "InvalidTransition",
      message: `the machine that reads ${request.name} could not be told, so the secret was not asked for`,
      details: { path: "args.form", retryable: true, reason: "not_declared", next_step: "raise it from a seat, or from an automation run on a machine" },
    });
  }
  const declared = secretSourceOf(input.board, raiser, machine, request.name);
  if (declared === undefined) {
    return Result.fail({
      type: "InputError",
      message: `no region around this asker declares ${request.name} for ${machine}`,
      details: { path: "args.form", retryable: false, reason: "not_declared", next_step: `declare ${request.name} as a region source for ${machine}, then ask again` },
    });
  }
  if (declared === "ambiguous") {
    return Result.fail({
      type: "InputError",
      message: `more than one region around this asker declares ${request.name} for ${machine}; the value would land where the seat may not read it`,
      details: { path: "args.form", retryable: false, reason: "ambiguous", next_step: "leave one region declaring it at that depth, then ask again" },
    });
  }
  return Result.succeed({ kind: "secret", name: request.name, regionId: declared.region.id, machine });
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
