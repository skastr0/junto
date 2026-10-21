/**
 * The one insert into `resource_rulings` (plan 02). remote-work's ruler
 * service becomes its only caller; until then each domain's submit calls it
 * inside its own transaction, so a ruling and its facts commit together.
 */
import type { SqlClient } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";
import type { ResourceActor, ResourceCommand } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";

/**
 * What a ruling stores: an applied one, the domain's record of what it made
 * (a task's id, an artifact's id and version); a refused one, its error and
 * the opId whose refusal refused it. `kind` is also the row's kind column.
 */
export type RulingRecord =
  | ({ readonly kind: "applied" } & Readonly<Record<string, unknown>>)
  | { readonly kind: "refused"; readonly error: WorkErrorBody; readonly root: OpId };

/** Whose command it was, as the row's actor columns hold it. */
export const rulingActorOf = (
  actor: ResourceActor,
): { readonly actorKind: ResourceActor["kind"]; readonly actorNodeId: string | null } => {
  switch (actor.kind) {
    case "seat":
      return { actorKind: "seat", actorNodeId: actor.nodeId };
    case "operator":
    case "automation":
      return { actorKind: actor.kind, actorNodeId: null };
  }
};

export const writeRuling = (
  sql: SqlClient.SqlClient,
  ruling: {
    readonly canvas: string;
    readonly writer: InstallationId;
    readonly command: Pick<ResourceCommand<unknown>, "opId" | "actor">;
    readonly record: RulingRecord;
  },
) => {
  const { actorKind, actorNodeId } = rulingActorOf(ruling.command.actor);
  return sql`
    INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json, actor_kind, actor_node_id)
    VALUES (${ruling.canvas}, ${ruling.writer}, ${ruling.command.opId}, ${ruling.record.kind},
      ${JSON.stringify(ruling.record)}, ${actorKind}, ${actorNodeId})`;
};
