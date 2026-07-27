import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";

const runCliMock = vi.fn();
const operations = {
  identityBatch: (_host?: string) => runCliMock(),
  avatar: vi.fn(),
  message: vi.fn(),
};

// fetchAgentIdentity holds its own module-scope hostCache/hostFetchInFlight,
// so every test needs a fresh module instance — otherwise state from one
// test (a cached remote-a entry, a failure sentinel) leaks into the next.
const loadAdapter = async () => {
  vi.resetModules();
  const { setHostsSnapshot } = await import("../src/main/vellum/hosts/snapshot");
  setHostsSnapshot([
    ...defaultRemoteHostsDocument().hosts,
    {
      id: "remote-a",
      label: "remote-a",
      kind: "remote",
      sshEndpoint: "remote-a",
      capabilities: ["hermes"],
    },
  ]);
  return import("../src/main/vellum/adapters/hermes-identity");
};

const ok = (stdout: string) => ({ ok: true, stdout });
const fail = (error = "ssh: connect to host remote-a port 22: Operation timed out") => ({
  ok: false,
  stdout: "",
  error,
});

// Matches hermes identity-batch compiler tab-separated output shape.
const scriptOutput = (rows: ReadonlyArray<[string, string, string, string, string]>) =>
  rows.map((cols) => cols.join("\t")).join("\n");

beforeEach(() => {
  runCliMock.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchAgentIdentity — remote-a negative-cache regression", () => {
  it("does not poison the cache: a transient ssh failure with no prior data self-heals on retry, never caching an empty Map as truth", async () => {
    const { fetchAgentIdentity } = await loadAdapter();

    vi.useFakeTimers();
    vi.setSystemTime(0);

    // First call ever for this host: ssh fails outright (no previous entry
    // to fall back on).
    runCliMock.mockResolvedValueOnce(fail());
    const first = await fetchAgentIdentity(operations, "remote-a:profile-13", "local");
    expect(first).toBeNull();
    expect(runCliMock).toHaveBeenCalledTimes(1);

    // A call moments later (well inside the short failure-retry window)
    // must NOT re-hit ssh — the old bug's mirror-image failure would be
    // hammering ssh on every call while down.
    vi.setSystemTime(5_000);
    runCliMock.mockResolvedValueOnce(ok(scriptOutput([["profile-13", "PROFILE-13", "@profile-13:remote-a.ts.net", "room", "true"]])));
    const second = await fetchAgentIdentity(operations, "remote-a:profile-13", "local");
    expect(second).toBeNull();
    expect(runCliMock).toHaveBeenCalledTimes(1); // still not retried yet

    // Past the short failure-retry window, the next call retries — and
    // recovers immediately once ssh succeeds again. This is the "retry
    // recovers" behavior: no 10-minute wait for a transient blip.
    vi.setSystemTime(31_000);
    const third = await fetchAgentIdentity(operations, "remote-a:profile-13", "local");
    expect(runCliMock).toHaveBeenCalledTimes(2);
    expect(third).toEqual({
      key: "remote-a:profile-13",
      displayName: "PROFILE-13",
      matrixUserId: "@profile-13:remote-a.ts.net",
      homeRoomName: "room",
      hasAvatar: true,
    });
  });

  it("serves stale data (not null) when a fresh ssh call fails after a prior success, and recovers on the next successful retry", async () => {
    const { fetchAgentIdentity } = await loadAdapter();

    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Populate the cache with a real, successful batch fetch.
    runCliMock.mockResolvedValueOnce(
      ok(scriptOutput([["profile-13", "PROFILE-13", "@profile-13:remote-a.ts.net", "room-a", "true"]])),
    );
    const initial = await fetchAgentIdentity(operations, "remote-a:profile-13", "local");
    expect(initial?.displayName).toBe("PROFILE-13");
    expect(runCliMock).toHaveBeenCalledTimes(1);

    // Advance past the real 10-minute TTL so the next read attempts a
    // refetch, and this time ssh fails (remote-a blipped off the tailnet).
    vi.setSystemTime(11 * 60 * 1000);
    runCliMock.mockResolvedValueOnce(fail());
    const duringOutage = await fetchAgentIdentity(
      operations,
      "remote-a:profile-13",
      "local",
    );
    expect(runCliMock).toHaveBeenCalledTimes(2);
    // Old bug: this would be null (empty Map cached as truth). Fixed: the
    // previous successful batch is still served.
    expect(duringOutage).toEqual({
      key: "remote-a:profile-13",
      displayName: "PROFILE-13",
      matrixUserId: "@profile-13:remote-a.ts.net",
      homeRoomName: "room-a",
      hasAvatar: true,
    });

    // Because the stale entry was left untouched (not re-timestamped), the
    // very next call still treats it as expired and retries — and this
    // time ssh has recovered with fresh data.
    runCliMock.mockResolvedValueOnce(
      ok(scriptOutput([["profile-13", "PROFILE-13", "@profile-13:remote-a.ts.net", "room-b", "true"]])),
    );
    const recovered = await fetchAgentIdentity(
      operations,
      "remote-a:profile-13",
      "local",
    );
    expect(runCliMock).toHaveBeenCalledTimes(3);
    expect(recovered?.homeRoomName).toBe("room-b");
  });

  it("a legitimate empty host (ssh succeeds, zero profiles) is still cached and served as empty — only fetch FAILURE skips the cache write", async () => {
    const { fetchAgentIdentity } = await loadAdapter();

    vi.useFakeTimers();
    vi.setSystemTime(0);

    runCliMock.mockResolvedValueOnce(ok(""));
    const first = await fetchAgentIdentity(operations, "remote-a:ghost", "local");
    expect(first).toBeNull();
    expect(runCliMock).toHaveBeenCalledTimes(1);

    // Still within the real 10-minute TTL: served from cache, no second call.
    vi.setSystemTime(60_000);
    const second = await fetchAgentIdentity(operations, "remote-a:ghost", "local");
    expect(second).toBeNull();
    expect(runCliMock).toHaveBeenCalledTimes(1);
  });
});
