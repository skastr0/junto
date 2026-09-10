import { describe, expect, it, vi } from "vitest";
import { UpdateError } from "../src/main/vellum/update/errors";
import {
  assertCurrentLinuxDesktopTarget,
  assertLinuxDesktopUpdateTarget,
  type LinuxDesktopTargetObservation,
} from "../src/main/vellum/update/linux-target";

const qualified: LinuxDesktopTargetObservation = {
  platform: "linux",
  architecture: "x64",
  osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n',
  glibcVersion: "2.39",
  uid: 501,
  euid: 501,
};

describe("Linux desktop target admission", () => {
  it.each(["2.39", "2.39.1", "2.40", "3.0"])("admits the qualified ordinary-user target with glibc %s", (glibcVersion) => {
    expect(() => assertLinuxDesktopUpdateTarget({ ...qualified, glibcVersion })).not.toThrow();
  });

  it.each<Partial<LinuxDesktopTargetObservation>>([
    { platform: "darwin" },
    { platform: "win32" },
    { architecture: "arm64" },
    { architecture: "ia32" },
    { osRelease: 'ID=debian\nVERSION_ID="24.04"' },
    { osRelease: 'ID=ubuntu\nVERSION_ID="22.04"' },
    { osRelease: 'ID=ubuntu\nVERSION_ID="26.04"' },
    { osRelease: 'ID_LIKE=ubuntu\nVERSION_ID="24.04"' },
    { osRelease: "" },
    { glibcVersion: "2.38" },
    { glibcVersion: "1.99" },
    { glibcVersion: undefined },
    { glibcVersion: "" },
    { glibcVersion: "unknown" },
    { glibcVersion: "2.39-ubuntu" },
    { glibcVersion: "2.39\n" },
    { glibcVersion: "9007199254740992.39" },
  ])("refuses an unqualified platform observation %j", (patch) => {
    expect(() => assertLinuxDesktopUpdateTarget({ ...qualified, ...patch }))
      .toThrow(expect.objectContaining({ code: "platform-unsupported" }));
  });

  it.each<Partial<LinuxDesktopTargetObservation>>([
    { uid: 0 },
    { euid: 0 },
    { uid: 0, euid: 0 },
    { uid: undefined },
    { euid: undefined },
    { uid: -1 },
    { euid: -1 },
    { uid: Number.NaN },
    { euid: Number.POSITIVE_INFINITY },
    { uid: 1.5 },
    { euid: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses root or unknown process authority %j", (patch) => {
    expect(() => assertLinuxDesktopUpdateTarget({ ...qualified, ...patch }))
      .toThrow(/ordinary user with non-root real and effective user IDs/u);
  });

  it("reads and admits the current observation through the shared first-install gate", async () => {
    const observe = vi.fn(async () => qualified);
    await expect(assertCurrentLinuxDesktopTarget(observe)).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledOnce();
  });

  it("fails closed when the current process has effective root authority", async () => {
    const observe = vi.fn(async () => ({ ...qualified, euid: 0 }));
    await expect(assertCurrentLinuxDesktopTarget(observe)).rejects.toBeInstanceOf(UpdateError);
  });

  it("does not replace an unreadable native observation with an assumed target", async () => {
    const failure = new Error("target observation unavailable");
    await expect(assertCurrentLinuxDesktopTarget(async () => { throw failure; }))
      .rejects.toBe(failure);
  });
});
