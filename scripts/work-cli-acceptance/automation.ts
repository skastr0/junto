/**
 * junto automation as a plain seat. Owner: pty-contract. A seat reads
 * automations and writes none: the overseer gate refuses its write before
 * any ruler sees it.
 *
 * The seat read ports are stubs on main (automation-control.ts
 * liveAutomationPorts) until canvas C5 adds the store and remote R2 the local
 * ruler, so list answers empty, and show and history wait on an automation
 * the store holds.
 */
import { overseerAutomationExamples } from "../../src/cli/commands/overseer-automation";
import { casesFor, type AcceptanceArea } from "./area";
import { envelopeOf } from "./envelope";

const { check, pending } = casesFor("automation");

const CREATE = overseerAutomationExamples.find((entry) => entry.command === "overseer automation create")!.input;

export const automationArea: AcceptanceArea = {
  name: "automation",
  owner: "pty-contract",
  run: async ({ cli, log }) => {
    const listed = await cli(["automation", "list"]);
    log("automation list", listed.stdout || listed.stderr);
    const list = envelopeOf(listed);

    const written = await cli(["overseer", "automation", "create", JSON.stringify(CREATE)]);
    log("overseer automation create as a seat", written.stdout || written.stderr);
    const write = envelopeOf(written);

    return [
      check("list reads as a seat", listed.code === 0 && list?.ok === true && Array.isArray(list.data?.automations), listed),
      pending("show reads one automation", "canvas-automation"),
      pending("history reads its firings", "canvas-automation"),
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
