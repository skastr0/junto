/**
 * junto automation as a plain seat. Owner: pty-contract. The operator puts an
 * Automations node in the region and one automation on it, through the
 * pane's write path; the seat reaches it through the region and reads it,
 * and writes none: the overseer gate refuses its write before any ruler sees
 * it.
 */
import { Schema } from "effect";
import { automationIpcHandlers } from "../../src/main/junto/automation/ipc";
import { ModelService } from "../../src/main/junto/model/service";
import { overseerAutomationExamples } from "../../src/cli/commands/overseer-automation";
import { Command } from "../../src/shared/model";
import { mintItemId } from "../../src/shared/resource-command";
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, fail, pending } = casesFor("automation");

const NODE = "automations";
const NAME = "standup reminder";
const CREATE = overseerAutomationExamples.find((entry) => entry.command === "overseer automation create")!.input;

export const automationArea: AcceptanceArea = {
  name: "automation",
  owner: "pty-contract",
  run: async ({ canvas, cli, log, nodes, runtime }) => {
    const inApp = runtime as unknown as { readonly runPromise: <A>(effect: unknown) => Promise<A> };
    const model = await inApp.runPromise<ModelService["Service"]>(ModelService);
    await inApp.runPromise(model.command(Schema.decodeUnknownSync(Command)({
      _tag: "Add",
      canvas,
      nodes: [{ kind: "automations", id: NODE, label: "Automations", x: 40, y: 110, width: 140, height: 70, z: 11 }],
      wires: [],
    }), "operator"));
    const automationId = mintItemId();
    const created = await automationIpcHandlers((effect) => inApp.runPromise(effect), () => undefined).apply(canvas, {
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
        paged.code === 1 && badBefore?.ok === false && badBefore.error?.type === "InputError" && badBefore.error?.details?.path === "before",
        paged,
      ),
      // A seat with no overseer flag is refused before the overseer grant is read (control.ts, op "overseer").
      check(
        "a seat's write is refused at the overseer gate",
        written.code === 1 && write?.ok === false && write.error?.type === "ScopeError" &&
          write.error?.details?.caller === "agent" && write.error?.details?.retryable === false,
        written,
      ),
      pending("the refusal's next step names junto automation show", "cli-external"),
      pending("an overseer's write past the gate is ruled", "remote"),
    ];
  },
};
