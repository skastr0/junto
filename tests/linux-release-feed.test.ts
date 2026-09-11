import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ensureLinuxReleaseCache,
  linuxQualificationCandidateBundleRoot,
  linuxRemoteArtifactBundleRoot,
} from "../src/main/vellum-command/hosts/linux-release-feed";
import {
  makeProductionLinuxArtifactAuthority,
} from "../src/main/vellum-command/hosts/deploy-linux";

const homes = new Set<string>();

const temporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "vellum-linux-release-feed-"));
  homes.add(home);
  return home;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
  homes.clear();
});

describe("Linux release cache selection", () => {
  it("uses only the fixed seated cache when explicitly selected", async () => {
    const home = temporaryHome();
    const bundleRoot = linuxRemoteArtifactBundleRoot(home);
    mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({
        home,
        source: "verified-cache",
      }),
    ).resolves.toEqual({
      bundleRoot,
      source: "local",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without contacting the feed when the fixed cache is absent", async () => {
    const home = temporaryHome();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({
        home,
        source: "verified-cache",
      }),
    ).rejects.toThrow(
      "verified Linux release cache is absent from the fixed cache path",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the fixed non-publishable qualification candidate path", async () => {
    const home = temporaryHome();
    const bundleRoot = linuxQualificationCandidateBundleRoot(home);
    mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({
        home,
        source: "qualification-candidate",
      }),
    ).resolves.toEqual({
      bundleRoot,
      source: "local",
    });
    expect(bundleRoot).toBe(
      join(
        home,
        ".vellum-command",
        "releases",
        "linux-x64-glibc",
        "qualification",
        "current",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never substitutes the final cache for an absent qualification candidate", async () => {
    const home = temporaryHome();
    mkdirSync(linuxRemoteArtifactBundleRoot(home), {
      recursive: true,
      mode: 0o700,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({
        home,
        source: "qualification-candidate",
      }),
    ).rejects.toThrow(
      "Linux qualification candidate is absent from the fixed qualification path",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized runtime source before filesystem or network fallback", async () => {
    const home = temporaryHome();
    mkdirSync(linuxRemoteArtifactBundleRoot(home), {
      recursive: true,
      mode: 0o700,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({
        home,
        source: "caller-path" as "stable-feed",
      }),
    ).rejects.toThrow("Linux release cache source is unrecognized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never substitutes an existing cache when the stable feed fails", async () => {
    const home = temporaryHome();
    const bundleRoot = linuxRemoteArtifactBundleRoot(home);
    mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
    const feedFailure = new Error("feed unavailable");
    const fetchMock = vi.fn(async () => {
      throw feedFailure;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureLinuxReleaseCache({ home }),
    ).rejects.toThrow("feed unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-verifies an explicitly selected cache instead of trusting its contents", async () => {
    const home = temporaryHome();
    mkdirSync(linuxRemoteArtifactBundleRoot(home), {
      recursive: true,
      mode: 0o700,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const authority = makeProductionLinuxArtifactAuthority({
      home,
      source: "verified-cache",
    });

    await expect(authority.resolve()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
