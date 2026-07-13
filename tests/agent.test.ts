import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentAvatar, getAgentIdentity } from "../src/renderer/lib/agent";

const runtimeWindow = { vellum: undefined as unknown };
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

describe("agent avatar/identity cache", () => {
  afterEach(() => {
    runtimeWindow.vellum = undefined;
  });

  it("dedupes concurrent avatar fetches for the same key behind one promise", async () => {
    const agentAvatar = vi.fn(async (key: string) => `data:image/png;base64,${key}`);
    runtimeWindow.vellum = { agentAvatar };

    const [a, b] = await Promise.all([getAgentAvatar("remote-a:profile-13"), getAgentAvatar("remote-a:profile-13")]);
    expect(a).toBe(b);
    expect(agentAvatar).toHaveBeenCalledTimes(1);
  });

  it("caches settled null results too — a miss is not retried", async () => {
    const agentAvatar = vi.fn(async () => null);
    runtimeWindow.vellum = { agentAvatar };

    await getAgentAvatar("remote-a:no-avatar");
    await getAgentAvatar("remote-a:no-avatar");
    expect(agentAvatar).toHaveBeenCalledTimes(1);
  });

  it("resolves to null instead of throwing when the bridge method is absent", async () => {
    runtimeWindow.vellum = {};
    await expect(getAgentAvatar("remote-a:no-bridge")).resolves.toBeNull();
    await expect(getAgentIdentity("remote-a:no-bridge")).resolves.toBeNull();
  });

  it("resolves to null instead of throwing when the bridge call rejects", async () => {
    runtimeWindow.vellum = { agentIdentity: async () => { throw new Error("matrix down"); } };
    await expect(getAgentIdentity("remote-a:rejects")).resolves.toBeNull();
  });

  it("caches identity by key independently of the avatar cache", async () => {
    const agentIdentity = vi.fn(async (key: string) => ({ key, hasAvatar: false }));
    runtimeWindow.vellum = { agentIdentity };

    await getAgentIdentity("remote-a:identity-a");
    await getAgentIdentity("remote-a:identity-a");
    await getAgentIdentity("remote-a:identity-b");
    expect(agentIdentity).toHaveBeenCalledTimes(2);
  });
});
