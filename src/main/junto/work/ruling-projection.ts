/**
 * The replica fold (docs/plans/0.10/02-universal-resources.md, "Facts
 * replicate to every machine"). A machine that does not edit a canvas takes
 * each `ruling.applied` the editing machine wrote and folds its facts into its
 * own resource tables through the same projection the ruler wrote them with,
 * at the ruling's time, so every machine holds the full resource state and
 * reads it locally. The caller owns the transaction: the fold commits with the
 * ruling row it came in, or neither does.
 *
 * Replication is not access: holding a resource here grants no seat anything.
 * Each core checks reach (01) on its own reads.
 */
import { Effect, Result, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { ArtifactFact } from "@shared/artifact-domain";
import type { RulingAppliedResult } from "@shared/command-row";
import type { ResourceKind } from "@shared/resource-command";
import { decodeTaskFacts } from "@shared/task-fact-wire";
import { projectArtifactFacts } from "./artifact-repository";
import { projectTaskFact } from "./task-repository";

/** An applied ruling whose facts this build cannot fold: the link that carried it closes. */
export class RulingFoldRefused extends Schema.TaggedError<RulingFoldRefused>()("RulingFoldRefused", {
  message: Schema.String,
}) {}

type Fold = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  ruling: RulingAppliedResult,
  at: number,
) => Effect.Effect<void, SqlError.SqlError | RulingFoldRefused>;

const decodeArtifactFacts = Schema.decodeUnknownResult(Schema.Array(ArtifactFact), { onExcessProperty: "error" });

/** A domain whose rulings no editing machine of this build writes yet. */
const notYetRuled = (kind: ResourceKind): Fold => () =>
  Effect.fail(new RulingFoldRefused({ message: `no ${kind} ruling is written by this build` }));

/**
 * One projection per resource kind. Total, so a domain whose ruler starts
 * recording rulings fails tsc until its replica fold is named here.
 */
const FOLDS: { readonly [K in ResourceKind]: Fold } = {
  task: (sql, canvasName, ruling, at) => {
    const facts = decodeTaskFacts(ruling.facts);
    return facts === undefined
      ? Effect.fail(new RulingFoldRefused({ message: "a task ruling carries facts this build does not know" }))
      : Effect.forEach(facts, (fact) => projectTaskFact(sql, canvasName, fact, at), { discard: true });
  },
  artifact: (sql, canvasName, ruling) => {
    const facts = decodeArtifactFacts(ruling.facts);
    return Result.isFailure(facts)
      ? Effect.fail(new RulingFoldRefused({ message: "an artifact ruling carries facts this build does not know" }))
      // A body that rode by ref is written pending; a read fetches its bytes by ref (v29).
      : projectArtifactFacts(sql, canvasName, ruling.opId, facts.success, () => undefined);
  },
  thread: notYetRuled("thread"),
  // Automations stay on the editing machine (machines.md Rule 2): a copy keeps the
  // ruling itself, which op show reads, and has no automation tables to fold into.
  automation: () => Effect.void,
};

/** Fold one applied ruling from the editing machine into this machine's resource tables. */
export const foldRuling = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  ruling: RulingAppliedResult,
  at: number,
): Effect.Effect<void, SqlError.SqlError | RulingFoldRefused> => FOLDS[ruling.kind](sql, canvasName, ruling, at);
