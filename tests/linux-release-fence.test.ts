import { describe, expect, it } from "vitest";
import {
  LINUX_RELEASE_FENCE_DIRECTORY,
  LINUX_RELEASE_FENCE_PATH,
} from "../src/shared/linux-release-fence";
import { linuxReleaseFenceActive } from "../src/main/vellum/term/release-fence";

describe("Linux release fence contract", () => {
  it("uses one fixed persistent root namespace", () => {
    expect(LINUX_RELEASE_FENCE_DIRECTORY).toBe(
      "/var/lib/vellum-release-fence",
    );
    expect(LINUX_RELEASE_FENCE_PATH).toBe(
      "/var/lib/vellum-release-fence/active",
    );
    expect(LINUX_RELEASE_FENCE_PATH.startsWith("/run/")).toBe(false);
    expect(LINUX_RELEASE_FENCE_PATH.includes(".vellum")).toBe(false);
  });

  it("is inactive off Linux without touching host state", () => {
    const observe = (): never => {
      throw new Error("must not observe");
    };
    expect(linuxReleaseFenceActive("darwin", observe)).toBe(false);
    expect(linuxReleaseFenceActive("win32", observe)).toBe(false);
  });

  it("closes on every occupied or unreadable Linux path", () => {
    expect(
      linuxReleaseFenceActive("linux", (path) => {
        expect(path).toBe(LINUX_RELEASE_FENCE_PATH);
        return {};
      }),
    ).toBe(true);
    expect(
      linuxReleaseFenceActive("linux", () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      }),
    ).toBe(true);
  });

  it("opens only when the fixed Linux path is absent", () => {
    expect(
      linuxReleaseFenceActive("linux", () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toBe(false);
  });
});
