import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";
import {
  loadRemoteDeploymentProvider,
  makeRemoteDeploymentDispatcher,
} from "../src/main/vellum/hosts/deploy-remote";
import type { RemoteHost } from "../src/shared/remote-hosts";

/**
 * Unmocked production freeze: linux deploy path refuses with product copy and
 * never loads the linux provider body.
 */
const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const makeSsh = (stdout: string) => ({
  warm: vi.fn(() => Effect.void),
  run: vi.fn(() => Effect.succeed({ stdout, stderr: "" })),
});

describe("production Linux deploy freeze (unmocked RELEASE_CAPABILITIES)", () => {
  it("keeps linuxRemoteDeploy off in production defaults", () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.boxFleet).toBe(false);
  });

  it("loadRemoteDeploymentProvider(linux) rejects with stable product detail", async () => {
    await expect(loadRemoteDeploymentProvider("linux")).rejects.toThrow(
      /Linux Remote managed deployment is not available/i,
    );
  });

  it("prepare refuses Linux before provider evaluation", async () => {
    const loadProvider = vi.fn(async () => {
      throw new Error("provider body must not run");
    });
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      loadProvider,
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Linux\n") as never, host, {
        state: "managed-externally",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.detail).toMatch(/Linux Remote managed deployment is not available/i);
    expect(loadProvider).not.toHaveBeenCalled();
  });
});
