/**
 * junto task, the 0.10 lifecycle: create, assign from reach, a reviewer,
 * start, finish into review, a stamp to done, and a comment whose mention
 * reaches the mentioned seat. Reach is the region's: no seat has an edge.
 * Owner: pty-mail.
 */
import { casesFor, type AcceptanceArea, type AcceptanceSeat } from "./area";
import { envelopeOf } from "./envelope";
import type { WorkCliCommandResult } from "../work-cli-acceptance";

const { check, pass, pending } = casesFor("task");

/** One inbox row as msg list prints it: text in parts, the thread and notice kind in metadata. */
type InboxItem = {
  readonly parts?: ReadonlyArray<{ readonly kind?: string; readonly text?: string }>;
  readonly metadata?: { readonly threadId?: string; readonly subjectNotice?: string };
};

/** The seat's inbox, read without marking it, newest first. */
export const inboxOf = async (cli: (args: ReadonlyArray<string>, as?: AcceptanceSeat) => Promise<WorkCliCommandResult>, seat: AcceptanceSeat) => {
  const listed = await cli(["msg", "list", JSON.stringify({ peek: true })], seat);
  const items: ReadonlyArray<InboxItem> = envelopeOf(listed)?.data?.items ?? [];
  return { listed, items };
};

const textOf = (item: InboxItem): string => (item.parts ?? []).map((part) => part.text ?? "").join("");

export const taskArea: AcceptanceArea = {
  name: "task",
  owner: "pty-mail",
  run: async ({ cli, addSeat, canvas, log, nodes }) => {
    const worker = await addSeat("worker", { x: 300, y: 20 });
    const reviewer = await addSeat("reviewer", { x: 460, y: 20 });
    const peer = await addSeat("peer", { x: 620, y: 20 });
    // In a region on no line with the task node's (a seat in no region is at the root, and reaches it).
    const outsider = await addSeat("outsider", { x: 1_300, y: 40 });

    const created = await cli(["task", "create", "acc task", "--stamps", "1"]);
    log("task create", created.stdout || created.stderr);
    const made = envelopeOf(created)?.data;
    const ref = `#${String(made?.number)}`;
    const step = async (label: string, args: ReadonlyArray<string>, as?: AcceptanceSeat) => {
      const result = await cli(args, as);
      log(label, result.stdout || result.stderr);
      return { result, data: envelopeOf(result)?.data };
    };

    const assigned = await step("task assign", ["task", "assign", ref, "@worker"]);
    const reviewing = await step("task reviewer add", ["task", "reviewer", "add", ref, "@reviewer"]);
    const started = await step("task start", ["task", "start", ref], worker);
    const finished = await step("task finish", ["task", "finish", ref], worker);
    const stamped = await step("task stamp", ["task", "stamp", ref, "approve"], reviewer);

    // A mention is a seat link (mention.ts); `@name` in the text is the help's promise.
    const linked = await step("task comment link", ["task", "comment", ref, `[@peer](junto://canvas/${canvas}?node=peer) please look at the link`]);
    const atName = await step("task comment @name", ["task", "comment", ref, "@peer please look at the name"]);
    const outOfReach = await step("task comment out of reach", ["task", "comment", ref, `[@outsider](junto://canvas/${canvas}?node=outsider) look`]);

    const workerMail = await inboxOf(cli, worker);
    log("worker inbox", workerMail.listed.stdout || workerMail.listed.stderr);
    const reviewerMail = await inboxOf(cli, reviewer);
    log("reviewer inbox", reviewerMail.listed.stdout || reviewerMail.listed.stderr);
    const peerMail = await inboxOf(cli, peer);
    log("peer inbox", peerMail.listed.stdout || peerMail.listed.stderr);
    const inThread = (items: ReadonlyArray<InboxItem>, notice: string, words: string) =>
      items.some((item) => item.metadata?.threadId === made?.taskId && item.metadata?.subjectNotice === notice && textOf(item).includes(words));
    const outsiderShow = await step("task show out of reach", ["task", "show", ref], outsider);
    const refused = envelopeOf(outOfReach.result);

    return [
      check("create", created.code === 0 && made?.disposition === "applied" && made?.state === "backlog" && typeof made?.taskId === "string", created),
      check("assign from reach", assigned.data?.state === "assigned", assigned.result),
      check("assignment notice in the task thread", inThread(workerMail.items, "assignment", "assigned you"), workerMail.listed),
      check("reviewer add", reviewing.data?.disposition === "applied", reviewing.result),
      check("stamp request notice", inThread(reviewerMail.items, "stamp-request", "asks for your stamp"), reviewerMail.listed),
      check("start", started.data?.state === "working", started.result),
      check("finish into review", finished.data?.state === "in-review", finished.result),
      check("stamp to done", stamped.data?.state === "done", stamped.result),
      check("comment", linked.data?.disposition === "applied" && linked.data?.threadId !== undefined, linked.result),
      check("mention link reaches the seat", inThread(peerMail.items, "mention", "please look at the link"), peerMail.listed),
      // Main will rewrite @name to its mention link against the seats in reach; cli-protocol builds it.
      atName.data?.disposition === "applied" && inThread(peerMail.items, "mention", "please look at the name")
        ? pass("@name mention reaches the seat")
        : pending("@name mention reaches the seat", "cli-protocol"),
      check("mention out of reach refused", refused?.ok === false && refused.error?.type === "ScopeError" && refused.error?.details?.reason === "not_in_reach", outOfReach.result),
      // Out of reach, the task is not there to name (task-control.ts findTask).
      check(`task in ${nodes.region} is unknown from ${nodes.elsewhere}`, envelopeOf(outsiderShow.result)?.error?.type === "UnknownTarget", outsiderShow.result),
    ];
  },
};
