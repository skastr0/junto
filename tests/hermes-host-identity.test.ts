import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isLocalHermesHost,
  parseAgentKey,
} from "../src/main/junto/hermes/domain";

const machine = {
  hostId: "studio",
  agentHostId: "fleet-studio",
};

describe("canonical Hermes machine identity", () => {
  it("recognizes only the exact configured Hermes prefix", () => {
    const parsed = parseAgentKey("fleet-studio:default");
    expect(parsed && isLocalHermesHost(parsed.host, machine)).toBe(true);
    expect(isLocalHermesHost("local", machine)).toBe(false);
  });

  it("keeps other machines on their exact agent-key prefix", () => {
    const parsed = parseAgentKey("fleet-render:default");
    expect(parsed && isLocalHermesHost(parsed.host, machine)).toBe(false);
  });

  it("has no source-level local alias or canonical-to-local rewrite seam", () => {
    const domain = readFileSync(
      join(process.cwd(), "src/main/junto/hermes/domain.ts"),
      "utf8",
    );
    const plane = readFileSync(
      join(process.cwd(), "src/main/junto/hermes/plane.ts"),
      "utf8",
    );
    const chat = readFileSync(
      join(process.cwd(), "src/main/junto/chat/service.ts"),
      "utf8",
    );

    expect(domain).not.toContain("localAdapterAgentKey");
    expect(plane).not.toContain("localAdapterAgentKey");
    expect(chat).not.toContain("defaultHermesHostLocality");
    expect(domain).not.toMatch(
      /host\s*===\s*["']local["']\s*\|\|\s*host\s*===\s*station\.agentHostId/u,
    );
  });
});
