/**
 * junto automation as a plain seat. Owner: pty-contract. The operator puts an
 * Automations node in the region and one automation on it, through the
 * pane's write path; the seat reaches it through the region and reads it,
 * and writes none: the overseer gate refuses its write before any ruler sees
 * it.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { coreOpBody } from "../../src/main/core-process/ops";
import "../../src/main/core-process/ops/ipc-automation";
import { ModelService } from "../../src/main/junto/model/service";
import { overseerAutomationExamples } from "../../src/cli/commands/overseer-automation";
import { Command } from "../../src/shared/model";
import type { AutomationApplyResponse } from "../../src/shared/automation";
import { mintItemId } from "../../src/shared/resource-command";
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, fail, pending } = casesFor("automation");

const NODE = "automations";
const NAME = "standup reminder";
const OVERSEEN = "wrap up";
/** A paired machine that edits the canvas while the off-editor case runs. */
const EDITOR = { machine: "atlas", installation: "inst-acceptance-atlas" } as const;
const CREATE = overseerAutomationExamples.find((entry) => entry.command === "overseer automation create")!.input;

export const automationArea: AcceptanceArea = {
  name: "automation",
  owner: "pty-contract",
  run: async ({ addSeat, canvas, cli, log, nodes, runtime }) => {
    const inApp = runtime as unknown as { readonly runPromise: <A>(effect: unknown) => Promise<A> };
    const model = await inApp.runPromise<ModelService["Service"]>(ModelService);
    await inApp.runPromise(model.command(Schema.decodeUnknownSync(Command)({
      _tag: "Add",
      canvas,
      nodes: [{ kind: "automations", id: NODE, label: "Automations", x: 40, y: 110, width: 140, height: 70, z: 11 }],
      wires: [],
    }), "operator"));
    const automationId = mintItemId();
    // The pane's write, as main makes it: the core operation of that name.
    const operatorApply = (canvasName: string, input: unknown): Promise<AutomationApplyResponse> => {
      const body = coreOpBody("ipc.automation.apply");
      if (body === undefined) throw new Error("no core operation named ipc.automation.apply");
      return inApp.runPromise(body({ canvasName, input } as never) as never);
    };
    const created = await operatorApply(canvas, {
      nodeId: NODE,
      automationId,
      op: {
        kind: "create",
        automationId,
        enabled: false,
        definition: {
          name: NAME,
          trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
          then: [{ kind: "create-task", node: nodes.tasks, title: "Plan the day" }],
          limits: { minIntervalMs: 60_000, maxPerHour: 12 },
        },
      },
    });
    log("operator automation create", JSON.stringify(created));
    if (created.kind !== "applied") return [fail("the operator seeds an automation", JSON.stringify(created))];

    const listed = await cli(["automation", "list"]);
    log("automation list", listed.stdout || listed.stderr);
    const list = envelopeOf(listed);

    const shown = await cli(["automation", "show", JSON.stringify({ target: NODE, automation: NAME })]);
    log("automation show", shown.stdout || shown.stderr);
    const show = envelopeOf(shown);

    const history = await cli(["automation", "history", JSON.stringify({ target: NODE })]);
    log("automation history", history.stdout || history.stderr);
    const read = envelopeOf(history);

    const paged = await cli(["automation", "history", JSON.stringify({ target: NODE, before: "not-a-firing" })]);
    log("automation history bad before", paged.stdout || paged.stderr);
    const badBefore = envelopeOf(paged);

    const written = await cli(["overseer", "automation", "create", JSON.stringify(CREATE)]);
    log("overseer automation create as a seat", written.stdout || written.stderr);
    const write = envelopeOf(written);

    // An overseer seat on this machine, which edits the canvas, writes and is ruled here.
    const overseer = await addSeat("overseer", { x: 240, y: 130 }, { overseer: true });
    const ruledInput = {
      target: NODE,
      name: OVERSEEN,
      trigger: { kind: "schedule", cron: "0 17 * * 1-5", timezone: "UTC" },
      then: [{ kind: "mail", to: `@${nodes.agent}`, text: "Wrap up for the day" }],
    };
    const ruled = await cli(["overseer", "automation", "create", JSON.stringify(ruledInput)], overseer);
    log("overseer automation create as an overseer", ruled.stdout || ruled.stderr);
    const rule = envelopeOf(ruled);
    const seen = await cli(["automation", "show", JSON.stringify({ target: NODE, automation: OVERSEEN })]);
    log("automation show of the overseer's", seen.stdout || seen.stderr);
    const seenBody = envelopeOf(seen);

    // Off the editing machine: this core holds the canvas as a copy while atlas edits it, then edits it again.
    const sql = (statement: string) =>
      inApp.runPromise<ReadonlyArray<Record<string, unknown>>>(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)));
    const [own] = await sql(`SELECT editor_installation_id AS editor FROM canvases WHERE canvas_name = '${canvas}'`);
    const restore = own?.editor == null ? "NULL" : `'${String(own.editor)}'`;
    // Work event sequences naming atlas: the refusal writes nothing, so there are none.
    const naming = `FROM work_event_sequences WHERE event_home = '${EDITOR.installation}' OR entity_home = '${EDITOR.installation}'`;
    let offEditor: Awaited<ReturnType<typeof cli>>;
    let leftover = -1;
    try {
      await sql(`INSERT INTO known_installations(installation_id,registered_at) VALUES ('${EDITOR.installation}','2026-10-21T00:00:00Z')`);
      await sql(`INSERT INTO machine_peers(machine_name,installation_id,bound_at) VALUES ('${EDITOR.machine}','${EDITOR.installation}','2026-10-21T00:00:00Z')`);
      await sql(`UPDATE canvases SET editor_installation_id = '${EDITOR.installation}' WHERE canvas_name = '${canvas}'`);
      offEditor = await cli(["overseer", "automation", "create", JSON.stringify({ ...ruledInput, name: "off the editor" })], overseer);
      leftover = Number((await sql(`SELECT count(*) AS n ${naming}`))[0]?.n);
    } finally {
      // Later areas see the canvas, and this core's atlas, as they were.
      await sql(`UPDATE canvases SET editor_installation_id = ${restore} WHERE canvas_name = '${canvas}'`);
      await sql(`DELETE FROM machine_peers WHERE machine_name = '${EDITOR.machine}'`);
      // A sequence naming atlas holds its installation by a RESTRICT key; the case below fails on it.
      if (leftover === 0) await sql(`DELETE FROM known_installations WHERE installation_id = '${EDITOR.installation}'`);
    }
    log("overseer automation create off the editing machine", offEditor.stdout || offEditor.stderr);
    const off = envelopeOf(offEditor);

    return [
      check(
        "list reads as a seat",
        listed.code === 0 && list?.ok === true &&
          Array.isArray(list.data?.automations) && list.data.automations.some((entry: { automationId?: unknown }) => entry.automationId === automationId),
        listed,
      ),
      check(
        "show reads one automation",
        shown.code === 0 && show?.ok === true && show.data?.automation?.automationId === automationId && show.data.automation.name === NAME,
        shown,
      ),
      // Node-wide, newest first; this automation is off and never fired.
      check("history reads its firings", history.code === 0 && read?.ok === true && Array.isArray(read.data?.firings), history),
      check(
        "history refuses a before that is no firing id",
        paged.code === 1 && badBefore?.ok === false && badBefore.error?.type === "InputError" && badBefore.error?.details?.path === "before" &&
          badBefore.error?.details?.retryable === false,
        paged,
      ),
      // A seat with no overseer flag is refused before the overseer grant is read (control.ts, op "overseer").
      check(
        "a seat's write is refused not_permitted at the overseer gate",
        written.code === 1 && write?.ok === false && write.error?.type === "ScopeError" &&
          write.error?.details?.reason === "not_permitted" && write.error?.details?.caller === "agent" &&
          write.error?.details?.retryable === false,
        written,
      ),
      check(
        "the refusal's next step names junto automation show",
        String(write?.error?.details?.next_step ?? "").includes("junto automation show"),
        written,
      ),
      // Automations nodes and their store live only on the editing machine, so the write splits by machine.
      check(
        "an overseer on the editing machine writes an automation, ruled and applied",
        ruled.code === 0 && rule?.ok === true && rule.data?.disposition === "applied" && typeof rule.data?.version === "number" &&
          seen.code === 0 && seenBody?.data?.automation?.automationId === rule.data?.automationId,
        ruled.code === 0 ? seen : ruled,
      ),
      // Automation writes are not queued: a copy refuses them and names where to go. The overseer
      // surface types the core's InputError as InvalidArguments (overseer/dispatch.ts).
      check(
        "an overseer's write from another machine is refused not_available, naming the editing machine",
        offEditor.code === 1 && off?.ok === false && off.error?.type === "InvalidArguments" && off.error?.details?.reason === "not_available" &&
          String(off.error?.message).includes(EDITOR.machine) && String(off.error?.details?.next_step).includes(EDITOR.machine),
        offEditor,
      ),
      check("the refused write leaves no work event sequence naming the editing machine", leftover === 0, offEditor),
    ];
  },
};
