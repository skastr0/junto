/**
 * junto op show and op list: what became of this seat's writes, by the
 * opId each write returned. This machine edits the canvas, so a write is
 * applied or refused, never left queued. Owner: pty-mail.
 */
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check } = casesFor("op");

/** A well-formed ULID no write returned. */
const UNKNOWN_OP = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export const opArea: AcceptanceArea = {
  name: "op",
  owner: "pty-mail",
  run: async ({ cli, log }) => {
    const worker = { nodeId: "worker", agentKey: "local:worker" };
    const created = await cli(["task", "create", "acc op task"]);
    const made = envelopeOf(created)?.data;
    log("op: task create", created.stdout || created.stderr);
    // Starting a task in backlog is the ruler's refusal, recorded under its opId.
    const start = await cli(["task", "start", `#${String(made?.number)}`], worker);
    log("op: refused start", start.stdout || start.stderr);
    const refusedOp: unknown = envelopeOf(start)?.error?.details?.opId;

    const applied = await cli(["op", "show", String(made?.opId)]);
    log("op show applied", applied.stdout || applied.stderr);
    const appliedView = envelopeOf(applied)?.data;
    const refused = await cli(["op", "show", String(refusedOp)], worker);
    log("op show refused", refused.stdout || refused.stderr);
    const refusedView = envelopeOf(refused)?.data;
    const unknown = await cli(["op", "show", UNKNOWN_OP]);
    log("op show unknown", unknown.stdout || unknown.stderr);
    const listed = await cli(["op", "list", "--state", "refused"], worker);
    log("op list refused", listed.stdout || listed.stderr);
    const ops: ReadonlyArray<{ readonly opId?: string; readonly state?: string }> = envelopeOf(listed)?.data?.ops ?? [];

    return [
      check("show applied", appliedView?.state === "applied" && appliedView?.opId === made?.opId, applied),
      check("refusal carries its opId", start.code !== 0 && typeof refusedOp === "string", start),
      check("show refused", refusedView?.state === "refused" && refusedView?.root === refusedOp && typeof refusedView?.error?.type === "string", refused),
      check("show unknown", envelopeOf(unknown)?.error?.type === "UnknownTarget", unknown),
      check("list refused", ops.some((op) => op.opId === refusedOp && op.state === "refused"), listed),
      // Another seat's write is not this seat's to read.
      check("show is this seat's own", envelopeOf(await cli(["op", "show", String(made?.opId)], worker))?.data?.state !== "applied"),
    ];
  },
};
