import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const asset = (name: string) =>
  readFile(new URL(`../build/linux/${name}`, import.meta.url), "utf8");

describe("Linux Remote systemd/Xvfb package assets", () => {
  it("ships a versioned, fixed-argument Xvfb launcher", async () => {
    const launcher = await asset("vellum-remote-launch-v1");
    expect((await stat(new URL("../build/linux/vellum-remote-launch-v1", import.meta.url))).mode & 0o777).toBe(0o755);
    expect(launcher).toContain("VELLUM=\"$APP_DIR/vellum\"");
    expect(launcher).toContain('"$VELLUM" --vellum-headless --ozone-platform=x11 &');
    expect(launcher).toContain('"$XVFB" "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp -auth "$XAUTHORITY" &');
    expect(launcher).toContain('"$XAUTH" -f "$XAUTHORITY" add "$DISPLAY" . "$(/usr/bin/mcookie)" >/dev/null 2>&1');
    expect(launcher).toContain("DISPLAY_NUMBER='89'");
    expect(launcher).toContain('rm -f -- "$LOCK_FILE"');
    expect(launcher).toContain('if [ -e "$SOCKET_FILE" ] || [ -L "$SOCKET_FILE" ]; then');
    expect(launcher).toContain("kill -TERM \"$xvfb_pid\"");
    expect(launcher).toContain("umask 077");
    expect(launcher).not.toMatch(/--no-sandbox|disable-setuid-sandbox|pkill|killall|sudo|loginctl enable-linger|-ac/u);
  });

  it("defines a bounded user unit without role or host mutation", async () => {
    const unit = await asset("vellum-remote.service");
    expect(unit).toContain("ExecStart=/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("StartLimitBurst=3");
    expect(unit).toContain("TimeoutStartSec=45s");
    expect(unit).toContain("TimeoutStopSec=20s");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("Environment=DISPLAY=:89");
    expect(unit).toContain("Environment=ELECTRON_OZONE_PLATFORM_HINT=x11");
    expect(unit).toContain("StandardOutput=null");
    expect(unit).toContain("StandardError=null");
    expect(unit).not.toMatch(/User=|role|hostId|linger|NoNewPrivileges|ProtectHome|PrivateUsers|CapabilityBoundingSet/u);
  });

  it("includes the unit and executable launcher in the Linux package resources", async () => {
    const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const afterPack = await readFile(new URL("../scripts/electron-builder-after-pack.mjs", import.meta.url), "utf8");
    expect(packageJson).toContain('"from": "build/linux/vellum-remote-launch-v1"');
    expect(packageJson).toContain('"to": "systemd/vellum-remote-launch-v1"');
    expect(packageJson).toContain('"from": "build/linux/vellum-remote.service"');
    expect(packageJson).toContain('"to": "systemd/vellum-remote.service"');
    expect(afterPack).toContain('"resources", "systemd", "vellum-remote-launch-v1"');
  });
});
