import { describe, expect, it } from "vitest";
import {
  actorHostChoicesFromEnrollment,
  type AgentHostChoice,
} from "../src/renderer/components/node-palette/agent-launch-model";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";

const configured: AgentHostChoice = {
  id: "local",
  agentHost: "local",
  label: "local (unavailable)",
};

describe("agent host authoring", () => {
  it("offers only enrolled terminal hosts and carries the Hermes routing key", () => {
    const choices = actorHostChoicesFromEnrollment(
      [
        {
          id: "box-1",
          label: "Build box",
          kind: "remote",
          capabilities: ["terminal", "hermes"],
          hermesId: "hermes-box",
        },
        {
          id: "browser-only",
          label: "Browser only",
          kind: "remote",
          capabilities: ["browser"],
        },
        {
          id: "local",
          label: "This machine",
          kind: "local",
          capabilities: ["terminal"],
        },
      ],
      configured,
    );

    expect(choices).toEqual([
      { id: "local", agentHost: "local", label: "This machine" },
      {
        id: "box-1",
        agentHost: "hermes-box",
        label: "Build box (remote)",
      },
    ]);
  });

  it("keeps the configured installation visible when enrollment is unavailable", () => {
    expect(actorHostChoicesFromEnrollment([], configured)).toEqual([
      configured,
    ]);
  });

  it("stamps the selected host-local path into the stable actor node", () => {
    const node = makeManagedAgentNode(10, 20, {
      harness: "grok",
      host: "build-box",
      agentHost: "hermes-build-box",
      cwd: "/srv/work/junto",
    });

    expect(node.ether?.host).toBe("build-box");
    expect(node.ether?.terminal?.launch?.cwd).toBe("/srv/work/junto");
    expect(node.ether?.entity?.name).toBe("hermes-build-box:grok");
  });
});
