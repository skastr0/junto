import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_CANCELLED_ERROR } from "../src/main/junto/access-signal";
import {
  fetchHermesBundle,
  parseProfiles,
  parseVersion,
  type HermesFleetOperations,
} from "../src/main/junto/adapters/hermes";
import {
  defaultRemoteHostsDocument,
  type RemoteHost,
} from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/junto/hosts/snapshot";

const TABLE = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆default         gpt-5.5                      running      —            —
  profile-13      gpt-5.5                      running      profile-13   —
  profile-14      —                            stopped      —            —
`;

afterEach(() => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
});

describe("hermes profile parsing", () => {
  it("parses each profile row into name/model/gateway", () => {
    const rows = parseProfiles(TABLE);
    expect(rows).toEqual([
      { name: "default", model: "gpt-5.5", gateway: "running" },
      { name: "profile-13", model: "gpt-5.5", gateway: "running" },
      { name: "profile-14", model: "—", gateway: "stopped" },
    ]);
  });

  it("skips header and separator lines", () => {
    expect(parseProfiles(TABLE).some((r) => r.name.toLowerCase() === "profile")).toBe(false);
  });

  it("extracts the semver from the version banner", () => {
    expect(parseVersion("Hermes Agent v0.18.2 (2026.6.5) - upstream a72bb037")).toBe("v0.18.2");
    expect(parseVersion("no version here")).toBeUndefined();
  });
});

describe("hermes fleet host identity", () => {
  const remote: RemoteHost = {
    id: "render",
    hermesId: "fleet-render",
    label: "Render Display",
    kind: "remote",
    sshEndpoint: "render-ssh",
    capabilities: ["hermes"],
  };

  const operations = (
    profileResult: (host: string) => { ok: boolean; stdout: string; error?: string },
  ): HermesFleetOperations => ({
    profiles: async (host) => profileResult(host),
    version: async () => ({
      ok: true,
      stdout: "Hermes Agent v0.18.2",
    }),
  });

  it("publishes canonical self/fleet keys separately from physical ids and labels", async () => {
    setHostsSnapshot([...defaultRemoteHostsDocument().hosts, remote]);
    const seen: string[] = [];
    const bundle = await fetchHermesBundle(
      operations((host) => {
        seen.push(host);
        return { ok: true, stdout: TABLE };
      }),
      { hostId: "studio", agentHostId: "fleet-studio" },
    );

    expect(bundle.ok).toBe(true);
    expect(seen).toEqual(["local", "fleet-render"]);
    expect(bundle.entities.find((entity) => entity.key === "fleet-studio:default"))
      .toMatchObject({
        stats: {
          host: "local",
          hostId: "studio",
          gateway: "running",
          running: 1,
        },
      });
    expect(bundle.entities.find((entity) => entity.key === "fleet-render:profile-14"))
      .toMatchObject({
        stats: {
          host: "Render Display",
          hostId: "render",
          gateway: "stopped",
          running: 0,
        },
      });
  });

  it("retains current facts but marks a partial fleet attempt unhealthy", async () => {
    setHostsSnapshot([...defaultRemoteHostsDocument().hosts, remote]);
    const bundle = await fetchHermesBundle(
      operations((host) =>
        host === "local"
          ? { ok: true, stdout: TABLE }
          : { ok: false, stdout: "", error: "private endpoint detail" },
      ),
      { hostId: "studio", agentHostId: "fleet-studio" },
    );

    expect(bundle.ok).toBe(false);
    expect(bundle.entities.some((entity) => entity.key === "fleet-studio:default"))
      .toBe(true);
    expect(bundle.entities.some((entity) => entity.key.startsWith("fleet-render:")))
      .toBe(false);
    expect(bundle.error).toBe("hermes host refresh failed (fleet-render)");
    expect(bundle.error).not.toContain("private endpoint detail");
  });

  it("treats an answering host with zero profiles as healthy", async () => {
    const bundle = await fetchHermesBundle(
      operations(() => ({ ok: true, stdout: "Profile  Model  Gateway\n" })),
      { hostId: "studio", agentHostId: "fleet-studio" },
    );
    expect(bundle).toMatchObject({ ok: true, entities: [] });
  });

  it("does not spawn version after profiles is aborted", async () => {
    let releaseProfiles!: () => void;
    const profilesGate = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    const stages: string[] = [];
    const abort = new AbortController();
    const pending = fetchHermesBundle(
      {
        profiles: async (_host, signal) => {
          stages.push("profiles");
          await profilesGate;
          if (signal?.aborted) {
            stages.push("cancelled");
            throw new DOMException(ACCESS_CANCELLED_ERROR, "AbortError");
          }
          return { ok: true, stdout: TABLE };
        },
        version: async () => {
          stages.push("version");
          return { ok: true, stdout: "Hermes Agent v0.18.2" };
        },
      },
      { hostId: "studio", agentHostId: "fleet-studio" },
      abort.signal,
    );

    await vi.waitFor(() => expect(stages).toEqual(["profiles"]));
    abort.abort();
    releaseProfiles();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stages).toEqual(["profiles", "cancelled"]);
  });
});
