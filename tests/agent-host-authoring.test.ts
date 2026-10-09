import { describe, expect, it } from "vitest";
import {
  actorHostChoicesFromEnrollment,
  type AgentHostChoice,
} from "../src/renderer/components/node-palette/agent-launch-model";
import { newSeat } from "../src/renderer/lib/model-factories";

const configured: AgentHostChoice = {
  id: "studio",
  agentHost: "studio",
  label: "studio",
};

describe("agent host authoring", () => {
  it("offers only machines that run terminals, this machine first, and carries the Hermes routing key", () => {
    const choices = actorHostChoicesFromEnrollment(
      [
        {
          id: "box-1",
          label: "Build box",
          isThisMachine: false,
          capabilities: ["terminal", "hermes"],
          hermesId: "hermes-box",
        },
        {
          id: "browser-only",
          label: "Browser only",
          isThisMachine: false,
          capabilities: ["browser"],
        },
        {
          id: "studio",
          label: "Studio",
          isThisMachine: true,
          capabilities: ["terminal"],
        },
      ],
      configured,
    );

    expect(choices).toEqual([
      { id: "studio", agentHost: "studio", label: "Studio" },
      { id: "box-1", agentHost: "hermes-box", label: "Build box" },
    ]);
  });

  it("orders by what a row says, never by what a machine is called", () => {
    const choices = actorHostChoicesFromEnrollment(
      [
        { id: "alpha", label: "Alpha", isThisMachine: false, capabilities: ["terminal"] },
        { id: "zulu", label: "Zulu", isThisMachine: true, capabilities: ["terminal"] },
      ],
      { id: "zulu", agentHost: "zulu", label: "zulu" },
    );

    expect(choices.map((choice) => choice.id)).toEqual(["zulu", "alpha"]);
  });

  it("keeps this machine offered when the list is unavailable", () => {
    expect(actorHostChoicesFromEnrollment([], configured)).toEqual([
      configured,
    ]);
  });

  it("stamps the selected machine's folder into the stable actor node", () => {
    const node = newSeat({ x: 10, y: 20, z: 0 }, {
      harness: "grok",
      host: "build-box",
      agentHost: "hermes-build-box",
      cwd: "/srv/work/junto",
    });

    expect(node.host).toBe("build-box");
    expect(node.launch?.cwd).toBe("/srv/work/junto");
    expect(node.agentKey).toBe("hermes-build-box:grok");
  });
});
