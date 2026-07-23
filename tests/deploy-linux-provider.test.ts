import { describe, expect, it } from "vitest";
import {
  buildLinuxRemoteDeployScript,
  decodeLinuxRemoteReceipt,
} from "../src/main/vellum/hosts/deploy-linux";

describe("Linux Remote deployment program", () => {
  it("accepts only one bounded readiness receipt", () => {
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=1.2.3\n")).toBe("1.2.3");
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=1\nextra\n")).toBeUndefined();
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=$(id)\n")).toBeUndefined();
  });

  it("uses a private unique stage and fixed package commands", () => {
    const script = buildLinuxRemoteDeployScript();
    expect(script).toContain('umask 077');
    expect(script).toContain('mktemp -d "$BASE/incoming.XXXXXX"');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
    expect(script).toContain('dpkg-deb --info "$DEB"');
    expect(script).not.toMatch(/sudo|apt-get|curl|wget|systemctl|loginctl|pkill|killall|--no-sandbox/u);
  });
});
