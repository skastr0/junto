/**
 * Which overseer operations a build exposes. The catalog is what the CLI
 * lists, documents and sends, and what main dispatches, so a family that a
 * build gates off must leave all of them together. Pinned for the ship
 * profile, which the other overseer suites never run under.
 */
import { describe, expect, it } from "vitest";
import { BUILD_FEATURES, overseerOperationEnabled } from "../src/shared/features";
import { OVERSEER_CATALOG, OVERSEER_OPERATION_NAMES } from "../src/shared/overseer-control";
import { overseerCapabilities, overseerExamples, overseerSchemas } from "../src/cli/commands/overseer";

// The build under test says which it is: these seven surfaces are all off in
// a ship build and all on with every feature on.
const SURFACES = ["tasks", "requests", "artifacts", "board", "pad", "sheet", "browser"] as const;
const profile = SURFACES.every((key) => BUILD_FEATURES[key] === false)
  ? "ship"
  : SURFACES.every((key) => BUILD_FEATURES[key] === true)
    ? "all-on"
    : "mixed";

/** Families a ship build does not have: their surfaces are off in the ship catalog. */
const SHIP_GATED_FAMILIES = ["tasks", "content", "request", "artifact", "board", "pad", "sheet", "page"];

const SHIP_OPERATIONS = [
  "status",
  "canvas.list", "canvas.read", "canvas.create", "canvas.batch", "canvas.delete", "canvas.digest", "canvas.render", "canvas.screenshot",
  "node.list", "node.get", "node.create", "node.configure", "node.move", "node.resize", "node.recolor", "node.delete",
  "wire.list", "wire.get", "wire.verbs", "wire.connect", "wire.configure", "wire.disconnect",
  "msg.list", "msg.send", "msg.read", "msg.reply", "msg.react",
  "agent.list", "agent.get", "agent.reseat", "agent.start", "agent.wake", "agent.prompt", "agent.output", "agent.interrupt", "agent.stop",
  "terminal.list", "terminal.get", "terminal.start", "terminal.input", "terminal.output", "terminal.resize", "terminal.interrupt", "terminal.stop",
  "scheduler.fire", "scheduler.status", "scheduler.configure",
  "git.status", "git.log", "git.show",
  "env.show", "env.source-add", "env.source-edit", "env.source-remove", "env.source-reorder", "env.seal", "env.folders", "env.doctor",
  "secret.put", "secret.delete", "secret.list",
  "agent.offboard", "agent.offboard-status", "agent.offboard-rules", "agent.offboard-configure",
  "references.list", "references.read", "references.write", "references.delete",
  "briefing.read", "briefing.write",
];

const familyOf = (operation: string): string => operation.split(".", 1)[0] ?? operation;
const operationOf = (commandId: string): string => commandId.replace(/^overseer\./u, "");

describe("overseer operations a build exposes", () => {
  it("runs under a profile it knows", () => {
    expect(["ship", "all-on"]).toContain(profile);
  });

  it("names the ship list as the whole vocabulary without the gated families", () => {
    expect(SHIP_OPERATIONS).toEqual(
      OVERSEER_OPERATION_NAMES.filter((operation) => !SHIP_GATED_FAMILIES.includes(familyOf(operation))),
    );
  });

  it.runIf(profile === "ship")("exposes exactly the ship list in a ship build", () => {
    expect(OVERSEER_CATALOG.map(({ operation }) => operation)).toEqual(SHIP_OPERATIONS);
    for (const family of SHIP_GATED_FAMILIES) {
      expect(overseerOperationEnabled(`${family}.list`)).toBe(false);
    }
  });

  it.runIf(profile === "all-on")("exposes every operation with every feature on", () => {
    expect(OVERSEER_CATALOG.map(({ operation }) => operation)).toEqual([...OVERSEER_OPERATION_NAMES]);
  });

  it("gives the CLI a schema for each exposed operation and nothing for a gated one", () => {
    const exposed = OVERSEER_CATALOG.map(({ operation }) => operation);
    expect(overseerSchemas.map((schema) => operationOf(schema.command_id))).toEqual(exposed);
    for (const example of overseerExamples) {
      expect(exposed).toContain(operationOf(example.command_id));
    }
    const offline = ["skill", "schema", "examples", "capabilities"];
    for (const capability of overseerCapabilities) {
      const operation = operationOf(capability.command_id);
      if (!offline.includes(operation)) expect(exposed).toContain(operation);
    }
  });
});
