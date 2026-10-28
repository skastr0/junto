/**
 * An automation's artifact writes (plan 0.11/05, B1): a new document, text at
 * the end of a document, labels added or removed. Each is an artifact
 * command as the automation, ruled with its author's reach, on the machine
 * that rules the canvas; elsewhere it is not available until artifact
 * commands queue as task commands do. An append names the head it read as
 * its base, as every edit does, and reads again when another write beat it.
 */
import { Effect, Schema } from "effect";
import { ARTIFACT_MAX_DOCUMENT_LENGTH, ARTIFACT_MAX_TITLE_LENGTH, type ArtifactOp } from "@shared/artifact";
import { artifactLabelsOf } from "@shared/artifact-labels";
import type { Action, ActionRuling, Automation, ArtifactTarget } from "@shared/automation";
import type { InstallationId } from "@shared/installation-id";
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { RefusalReason as RefusalReasonSchema, type RefusalReason } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import type { WorkErrorBody } from "@shared/work-control";
import { ItemId, OpId } from "@shared/work-ids";
import type { ArtifactRepository } from "../work/artifact-repository";
import { noteResourceChanged } from "../work/resource-changes";
import type { Fired } from "./values";

export type ArtifactAction = Extract<Action, { readonly kind: "create-artifact" | "append-artifact" | "label-artifact" }>;

export const isArtifactAction = (action: Action): action is ArtifactAction =>
  action.kind === "create-artifact" || action.kind === "append-artifact" || action.kind === "label-artifact";

/** What an artifact action needs: the artifact store and this machine as the writer. */
export type ArtifactPort = {
  readonly repository: ArtifactRepository["Service"];
  readonly writer: Effect.Effect<InstallationId, unknown>;
};

/** An append re-reads the head and writes again at most this many times after a newer head beat it. */
export const APPEND_RETRIES = 2;

export type ArtifactActionInput = {
  readonly canvas: Canvas | undefined;
  readonly canvasName: string;
  readonly automation: Automation;
  readonly action: ArtifactAction;
  readonly index: number;
  readonly fired: Fired;
  /** The action's text with its values said. */
  readonly resolve: (text: string) => Effect.Effect<string>;
  /** A stable id for one write of this firing's step, by part, so a retried firing writes nothing twice. */
  readonly idOf: (part: string) => string;
  /** Whether this machine rules the canvas. */
  readonly rules: boolean;
};

const notAvailable = (index: number): ActionRuling => ({ index, ruling: "refused", reason: "not_available" });
const refused = (index: number, reason: RefusalReason): ActionRuling => ({ index, ruling: "refused", reason });

const reasonOf = (error: WorkErrorBody): RefusalReason => {
  const reason = (error.details as { readonly reason?: unknown } | undefined)?.reason;
  if (Schema.is(RefusalReasonSchema)(reason)) return reason;
  return error.type === "UnknownTarget" ? "unknown_target" : "invalid_input";
};

/** The artifact a write names: the one it names, or the one whose change fired it. */
const targetOf = (to: ArtifactTarget, fired: Fired): { readonly nodeId: NodeId; readonly artifactId: ItemId } | undefined => {
  if (!("fired" in to)) return to.kind === "artifact" ? { nodeId: to.nodeId, artifactId: to.artifactId } : undefined;
  return fired.event?.kind === "artifact" ? { nodeId: fired.event.nodeId, artifactId: fired.event.artifactId } : undefined;
};

/** A document with text at its end, on a line of its own. */
export const appended = (markdown: string, text: string): string =>
  markdown.length === 0 || markdown.endsWith("\n") ? `${markdown}${text}` : `${markdown}\n${text}`;

/** One artifact action, performed as the automation. Never fails: a refusal is a ruling. */
export const performArtifactAction = (
  port: ArtifactPort | undefined,
  input: ArtifactActionInput,
): Effect.Effect<ActionRuling> => {
  const { canvas, canvasName, automation, action, index, fired } = input;
  if (port === undefined || canvas === undefined || !input.rules) return Effect.succeed(notAvailable(index));
  const context = rulingContextOf(canvas, (node) => (node === automation.nodeId ? automation.author : undefined));
  const actor = { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId } as const;
  const submit = (part: string, nodeId: NodeId, artifactId: ItemId, op: ArtifactOp) =>
    Effect.gen(function* () {
      const outcome = yield* port.repository.submit(
        yield* port.writer,
        {
          opId: OpId.make(input.idOf(part)),
          canvasName,
          actor,
          target: { kind: "artifact", nodeId, itemId: artifactId },
          basis: null,
          after: [],
          op,
        },
        context,
      );
      if (outcome.kind === "refused") return reasonOf(outcome.error);
      if (outcome.facts.length > 0) noteResourceChanged("artifact", canvasName);
      return undefined;
    });
  const ruled = (reason: RefusalReason | undefined): ActionRuling => (reason === undefined ? { index, ruling: "applied" } : refused(index, reason));

  return Effect.gen(function* () {
    switch (action.kind) {
      case "create-artifact": {
        if (canvas.nodes.get(action.node)?.kind !== "artifacts") return refused(index, "invalid_input");
        const title = [...(yield* input.resolve(action.title))].slice(0, ARTIFACT_MAX_TITLE_LENGTH).join("");
        const markdown = action.body === undefined ? "" : yield* input.resolve(action.body);
        if (markdown.length > ARTIFACT_MAX_DOCUMENT_LENGTH) return refused(index, "invalid_input");
        return ruled(yield* submit("create", action.node, ItemId.make(input.idOf("artifact")), {
          op: "create",
          title,
          body: { type: "document", markdown },
          ...(action.labels === undefined ? {} : { labels: [...action.labels] }),
        }));
      }
      case "append-artifact": {
        const target = targetOf(action.to, fired);
        if (target === undefined) return refused(index, "invalid_input");
        const text = yield* input.resolve(action.text);
        for (let attempt = 0; ; attempt += 1) {
          const head = yield* port.repository.head(canvasName, target.artifactId);
          if (head._tag === "None" || head.value.artifact.nodeId !== target.nodeId) return refused(index, "unknown_target");
          const body = head.value.body;
          if (body === null) return notAvailable(index);
          if (body.type !== "document") return refused(index, "invalid_input");
          const markdown = appended(body.markdown, text);
          if (markdown.length > ARTIFACT_MAX_DOCUMENT_LENGTH) return refused(index, "invalid_input");
          const reason = yield* submit(`append-${attempt}`, target.nodeId, target.artifactId, {
            op: "edit",
            edit: { kind: "replace", baseVersion: head.value.artifact.version, body: { type: "document", markdown } },
          });
          if (reason !== "stale" || attempt >= APPEND_RETRIES) return ruled(reason);
        }
      }
      case "label-artifact": {
        const target = targetOf(action.to, fired);
        if (target === undefined) return refused(index, "invalid_input");
        const head = yield* port.repository.head(canvasName, target.artifactId);
        if (head._tag === "None" || head.value.artifact.nodeId !== target.nodeId) return refused(index, "unknown_target");
        const held = head.value.artifact.labels;
        const remove = new Set<string>(action.remove ?? []);
        const labels = artifactLabelsOf([...held, ...(action.add ?? [])].filter((label) => !remove.has(label)));
        if (labels === undefined) return refused(index, "invalid_input");
        // Already so: nothing to write.
        if (labels.length === held.length && labels.every((label, i) => label === held[i])) return { index, ruling: "applied" } as const;
        return ruled(yield* submit("labels", target.nodeId, target.artifactId, { op: "labels", labels: [...labels] }));
      }
      default:
        return action satisfies never;
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(notAvailable(index))));
};
