import { seatMayBeBlocked } from "../src/shared/physics/phase-membership";
import { describe, expect, it } from "vitest";
import { newPage } from "../src/renderer/lib/model-factories";

describe("browser page model", () => {
  it("sink seats (incl. page registry kind) are not phase-blockable", () => {
    expect(seatMayBeBlocked({ isGroup: false, kind: "page" })).toBe(false);
    expect(seatMayBeBlocked({ isGroup: false, kind: "agent" })).toBe(true);
  });

  it("newPage stamps kind page, profile, and kill-session", () => {
    const node = newPage({ x: 12.4, y: 8.9, z: 0 }, "https://example.com/a");
    expect(node.kind).toBe("page");
    expect(node.url).toBe("https://example.com/a");
    expect(node.x).toBe(12);
    expect(node.y).toBe(9);
    expect(node.profile).toBe("personal");
    expect(node.onRemove).toBe("kill-session");
    expect(node.host).toBe("local");
  });

  it("newPage accepts profile and onRemove override", () => {
    const node = newPage({ x: 0, y: 0, z: 0 }, "https://example.com", {
      profile: "work",
      onRemove: "detach",
      host: "studio",
    });
    expect(node.profile).toBe("work");
    expect(node.onRemove).toBe("detach");
    expect(node.host).toBe("studio");
  });
});
