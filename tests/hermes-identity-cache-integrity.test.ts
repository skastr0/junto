import { existsSync, readdirSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { mockHome, mockFs } = vi.hoisted(() => ({
  mockHome: `/tmp/vellum-hermes-identity-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  mockFs: { failRmSync: false },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (mockFs.failRmSync) throw new Error("forced avatar cache removal failure");
      return actual.rmSync(...args);
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});

import type { CliResult } from "../src/main/vellum/adapters/exec";
import {
  fetchAgentAvatar,
  fetchAgentIdentity,
  invalidateHermesIdentityHost,
  type HermesIdentityOperations,
} from "../src/main/vellum/adapters/hermes-identity";
import {
  setHostsSnapshot,
  sshEndpointForHermesId,
} from "../src/main/vellum/hosts/snapshot";
import {
  defaultRemoteHostsDocument,
  type RemoteHost,
} from "../src/shared/remote-hosts";

const host = (
  endpoint: string,
  options: { readonly id?: string; readonly hermesId?: string } = {},
): RemoteHost => ({
  id: options.id ?? "studio-product",
  label: "Studio",
  kind: "remote",
  endpoint,
  capabilities: ["hermes"],
  hermesId: options.hermesId ?? "studio-canonical",
});

const snapshotWith = (remote: RemoteHost): ReadonlyArray<RemoteHost> => [
  ...defaultRemoteHostsDocument().hosts,
  remote,
];

const ok = (stdout: string): CliResult => ({ ok: true, stdout });

const identityOutput = (displayName: string): string =>
  `agent\t${displayName}\t@agent:example.test\troom\ttrue`;

const avatarResult = (content: string): CliResult =>
  ok(Buffer.from(content, "utf8").toString("base64"));

const avatarUri = (content: string): string =>
  `data:image/png;base64,${Buffer.from(content, "utf8").toString("base64")}`;

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  mockFs.failRmSync = false;
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  invalidateHermesIdentityHost("studio-canonical");
  invalidateHermesIdentityHost("local");
});

afterAll(async () => {
  await rm(mockHome, { recursive: true, force: true });
});

describe("Hermes identity cache authority", () => {
  it("keeps local filesystem identity independent from remote-host membership", async () => {
    setHostsSnapshot([]);
    const operations: HermesIdentityOperations = {
      identityBatch: vi.fn(),
      avatar: vi.fn(),
    };

    await expect(fetchAgentIdentity(operations, "local:default")).resolves.toEqual({
      key: "local:default",
      displayName: undefined,
      matrixUserId: undefined,
      homeRoomName: undefined,
      hasAvatar: false,
    });
    await expect(fetchAgentAvatar(operations, "local:default")).resolves.toBeNull();
    expect(operations.identityBatch).not.toHaveBeenCalled();
    expect(operations.avatar).not.toHaveBeenCalled();
  });

  it("accepts only the exact canonical Hermes key from the current host snapshot", async () => {
    setHostsSnapshot(snapshotWith(host("studio-a")));
    const operations: HermesIdentityOperations = {
      identityBatch: vi.fn(async () => ok(identityOutput("CURRENT"))),
      avatar: vi.fn(async () => avatarResult("current-avatar")),
    };

    await expect(fetchAgentIdentity(operations, "studio-product:agent")).resolves.toBeNull();
    await expect(fetchAgentAvatar(operations, "studio-product:agent")).resolves.toBeNull();
    expect(operations.identityBatch).not.toHaveBeenCalled();
    expect(operations.avatar).not.toHaveBeenCalled();

    await expect(fetchAgentIdentity(operations, "studio-canonical:agent")).resolves.toMatchObject({
      key: "studio-canonical:agent",
      displayName: "CURRENT",
    });
    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("current-avatar"),
    );
  });

  it("invalidates memory and disk avatar data when a canonical route is edited or removed", async () => {
    setHostsSnapshot(snapshotWith(host("studio-a")));
    const identityBatch = vi.fn(async (hostId: string) => {
      const endpoint = sshEndpointForHermesId(hostId);
      return ok(identityOutput(endpoint === "studio-a" ? "OLD" : "NEW"));
    });
    const avatar = vi.fn(async (hostId: string) => {
      const endpoint = sshEndpointForHermesId(hostId);
      return avatarResult(endpoint === "studio-a" ? "old-avatar" : "new-avatar");
    });
    const operations: HermesIdentityOperations = { identityBatch, avatar };

    expect((await fetchAgentIdentity(operations, "studio-canonical:agent"))?.displayName).toBe("OLD");
    expect(await fetchAgentAvatar(operations, "studio-canonical:agent")).toBe(
      avatarUri("old-avatar"),
    );
    expect(identityBatch).toHaveBeenCalledTimes(1);
    expect(avatar).toHaveBeenCalledTimes(1);

    const hostCacheDir = join(
      mockHome,
      ".vellum",
      "cache",
      "avatars",
      Buffer.from("studio-canonical", "utf8").toString("base64url"),
    );
    expect(existsSync(hostCacheDir)).toBe(true);

    setHostsSnapshot(snapshotWith(host("studio-b")));
    expect(existsSync(hostCacheDir)).toBe(false);
    expect((await fetchAgentIdentity(operations, "studio-canonical:agent"))?.displayName).toBe("NEW");
    expect(await fetchAgentAvatar(operations, "studio-canonical:agent")).toBe(
      avatarUri("new-avatar"),
    );
    expect(identityBatch).toHaveBeenCalledTimes(2);
    expect(avatar).toHaveBeenCalledTimes(2);

    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    expect(existsSync(hostCacheDir)).toBe(false);
    await expect(fetchAgentIdentity(operations, "studio-canonical:agent")).resolves.toBeNull();
    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBeNull();
    expect(identityBatch).toHaveBeenCalledTimes(2);
    expect(avatar).toHaveBeenCalledTimes(2);

    // Re-adding the same authority must fetch again instead of reviving the
    // pre-removal disk entry.
    setHostsSnapshot(snapshotWith(host("studio-b")));
    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("new-avatar"),
    );
    expect(avatar).toHaveBeenCalledTimes(3);
  });

  it("uses the host generation as a logical disk revocation when physical deletion fails", async () => {
    setHostsSnapshot(snapshotWith(host("studio-a")));
    const avatar = vi.fn(async (hostId: string) =>
      avatarResult(
        sshEndpointForHermesId(hostId) === "studio-a"
          ? "old-avatar"
          : "new-avatar",
      ),
    );
    const operations: HermesIdentityOperations = {
      identityBatch: vi.fn(),
      avatar,
    };

    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("old-avatar"),
    );
    const hostCacheDir = join(
      mockHome,
      ".vellum",
      "cache",
      "avatars",
      Buffer.from("studio-canonical", "utf8").toString("base64url"),
    );
    expect(existsSync(hostCacheDir)).toBe(true);

    mockFs.failRmSync = true;
    setHostsSnapshot(snapshotWith(host("studio-b")));
    mockFs.failRmSync = false;
    expect(existsSync(hostCacheDir)).toBe(true);

    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("new-avatar"),
    );
    expect(avatar).toHaveBeenCalledTimes(2);
  });

  it("refetches a persistent avatar cache entry after the identity-cache TTL", async () => {
    setHostsSnapshot(snapshotWith(host("studio-a")));
    const avatar = vi
      .fn<() => Promise<CliResult>>()
      .mockResolvedValueOnce(avatarResult("old-avatar"))
      .mockResolvedValueOnce(avatarResult("new-avatar"));
    const operations: HermesIdentityOperations = {
      identityBatch: vi.fn(),
      avatar,
    };

    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("old-avatar"),
    );
    const hostCacheDir = join(
      mockHome,
      ".vellum",
      "cache",
      "avatars",
      Buffer.from("studio-canonical", "utf8").toString("base64url"),
    );
    const [cachedFile] = readdirSync(hostCacheDir);
    expect(cachedFile).toBeDefined();
    const expired = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(join(hostCacheDir, cachedFile!), expired, expired);

    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("new-avatar"),
    );
    expect(avatar).toHaveBeenCalledTimes(2);
  });

  it("discards late identity and avatar results from an invalidated endpoint without disturbing fresh in-flight work", async () => {
    setHostsSnapshot(snapshotWith(host("studio-a")));
    const oldIdentity = deferred<CliResult>();
    const newIdentity = deferred<CliResult>();
    const oldAvatar = deferred<CliResult>();
    const newAvatar = deferred<CliResult>();
    const identityBatch = vi.fn((hostId: string) =>
      sshEndpointForHermesId(hostId) === "studio-a"
        ? oldIdentity.promise
        : newIdentity.promise,
    );
    const avatar = vi.fn((hostId: string) =>
      sshEndpointForHermesId(hostId) === "studio-a"
        ? oldAvatar.promise
        : newAvatar.promise,
    );
    const operations: HermesIdentityOperations = { identityBatch, avatar };

    const staleIdentityRead = fetchAgentIdentity(operations, "studio-canonical:agent");
    const staleAvatarRead = fetchAgentAvatar(operations, "studio-canonical:agent");
    expect(identityBatch).toHaveBeenCalledTimes(1);
    expect(avatar).toHaveBeenCalledTimes(1);

    setHostsSnapshot(snapshotWith(host("studio-b")));
    const freshIdentityRead = fetchAgentIdentity(operations, "studio-canonical:agent");
    const freshAvatarRead = fetchAgentAvatar(operations, "studio-canonical:agent");
    expect(identityBatch).toHaveBeenCalledTimes(2);
    expect(avatar).toHaveBeenCalledTimes(2);

    newIdentity.resolve(ok(identityOutput("NEW")));
    newAvatar.resolve(avatarResult("new-avatar"));
    await expect(freshIdentityRead).resolves.toMatchObject({ displayName: "NEW" });
    await expect(freshAvatarRead).resolves.toBe(avatarUri("new-avatar"));

    oldIdentity.resolve(ok(identityOutput("OLD")));
    oldAvatar.resolve(avatarResult("old-avatar"));
    await expect(staleIdentityRead).resolves.toBeNull();
    await expect(staleAvatarRead).resolves.toBeNull();

    // The late old completion must neither overwrite the fresh cache nor
    // delete the newer in-flight/cache entry in its finally handler.
    await expect(fetchAgentIdentity(operations, "studio-canonical:agent")).resolves.toMatchObject({
      displayName: "NEW",
    });
    await expect(fetchAgentAvatar(operations, "studio-canonical:agent")).resolves.toBe(
      avatarUri("new-avatar"),
    );
    expect(identityBatch).toHaveBeenCalledTimes(2);
    expect(avatar).toHaveBeenCalledTimes(2);
  });
});
