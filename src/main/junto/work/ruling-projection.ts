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
import { Effect, Option, Result, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { decodeArtifactBody, decodeArtifactOp, type ArtifactBody, type ArtifactOp } from "@shared/artifact";
import { ArtifactFact, bodyAfter } from "@shared/artifact-domain";
import { CommandQueuedResult, type RulingAppliedResult } from "@shared/command-row";
import type { ContentRef } from "@shared/wire/content-ref";
import type { ResourceKind } from "@shared/resource-command";
import { decodeTaskFacts } from "@shared/task-fact-wire";
import { artifactBodyRef, projectArtifactFacts } from "./artifact-repository";
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
const decodeCommandRow = Schema.decodeUnknownOption(Schema.fromJsonString(CommandQueuedResult));

/** The op of this machine's own artifact command the ruling answers: its edit or body came from here. */
const ownArtifactOp = (sql: SqlClient.SqlClient, canvasName: string, ruling: RulingAppliedResult) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ result_json: string }>(
      `
        SELECT fact.result_json
        FROM installation
        JOIN work_events AS event ON event.event_home = installation.installation_id AND event.entity_home = installation.installation_id
        JOIN work_facts AS fact USING (event_home, entity_home, seq)
        WHERE installation.singleton = 1
          AND installation.installation_id = ?
          AND event.item_canvas_name = ?
          AND event.item_kind = 'command'
          AND event.item_id = ?
          AND event.operation = 'command.queued'
        LIMIT 1
      `,
      [ruling.writer, canvasName, ruling.opId],
    );
    const held = rows[0] === undefined ? undefined : Option.getOrUndefined(decodeCommandRow(rows[0].result_json));
    if (held === undefined || held.command.target.kind !== "artifact") return undefined;
    const op = decodeArtifactOp(held.command.op);
    return Result.isSuccess(op) ? op.success : undefined;
  });

/** A version's body as this machine holds it in its row, or null. */
const heldBody = (sql: SqlClient.SqlClient, canvasName: string, artifactId: string, version: number) =>
  Effect.map(
    sql.unsafe<{ inline_body_json: string | null }>(
      "SELECT inline_body_json FROM artifact_versions WHERE canvas_name = ? AND artifact_id = ? AND version = ?",
      [canvasName, artifactId, version],
    ),
    (rows): ArtifactBody | null => {
      const json = rows[0]?.inline_body_json;
      if (json === undefined || json === null) return null;
      const body = decodeArtifactBody(JSON.parse(json));
      return Result.isSuccess(body) ? body.success : null;
    },
  );

/**
 * The bodies an applied ruling's facts name by ref, as far as this machine
 * can make them without the bytes travelling: a created body from this
 * machine's own command, an edited one as the edit applied to the version
 * before it (the fact's edit, or this machine's own). Each is kept only when
 * its digest is the ref the editing machine ruled; any other stays pending.
 */
const bodiesKnownHere = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  ruling: RulingAppliedResult,
  facts: ReadonlyArray<ArtifactFact>,
) =>
  Effect.gen(function* () {
    const own: ArtifactOp | undefined = yield* ownArtifactOp(sql, canvasName, ruling);
    const bodies = new Map<string, ArtifactBody>();
    const latest = new Map<string, ArtifactBody | null>();
    const keep = (ref: ContentRef, body: ArtifactBody | null | undefined): ArtifactBody | null => {
      if (body === null || body === undefined) return null;
      const made = artifactBodyRef(body);
      if (made.sha256 !== ref.sha256 || made.byteLength !== ref.byteLength) return null;
      bodies.set(ref.sha256, body);
      return body;
    };
    for (const fact of facts) {
      if (fact.fact === "artifact.created") {
        latest.set(fact.artifact.artifactId, keep(fact.bodyRef, fact.body ?? (own?.op === "create" ? own.body : undefined)));
      } else if (fact.fact === "artifact.edited") {
        const before = latest.has(fact.artifactId)
          ? latest.get(fact.artifactId)!
          : yield* heldBody(sql, canvasName, fact.artifactId, fact.version - 1);
        const edit = fact.edit ?? (own?.op === "edit" ? own.edit : undefined);
        latest.set(fact.artifactId, keep(fact.bodyRef, bodyAfter(before, edit)));
      }
    }
    return bodies;
  });

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
    if (Result.isFailure(facts)) {
      return Effect.fail(new RulingFoldRefused({ message: "an artifact ruling carries facts this build does not know" }));
    }
    // A body this machine can make is written with its version, so it reads with no link;
    // any other rode by ref and is written pending, and a read fetches its bytes by ref (v29).
    return Effect.flatMap(bodiesKnownHere(sql, canvasName, ruling, facts.success), (bodies) =>
      projectArtifactFacts(sql, canvasName, ruling.opId, facts.success, (ref) => bodies.get(ref.sha256)));
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
