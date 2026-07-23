import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINUX_SYSTEMD_USER_UNIT_PATH,
  parseSystemdExecStart,
  validateSystemdUserUnit,
} from "../scripts/audit-linux-package";

const asset = (name: string) =>
  readFile(new URL(`../build/linux/${name}`, import.meta.url), "utf8");
const execFileAsync = promisify(execFile);

const linuxLauncherSandbox = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-remote-launcher-"));
  const app = join(root, "app");
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  const socket = join(root, "display.sock");
  await Promise.all([mkdir(app), mkdir(runtime), mkdir(bin)]);
  const launcher = (await asset("vellum-remote-launch-v1"))
    .replace("APP_DIR='/opt/Vellum Command'", `APP_DIR='${app}'`)
    .replace("XVFB='/usr/bin/Xvfb'", `XVFB='${join(bin, "Xvfb")}'`)
    .replace("XAUTH='/usr/bin/xauth'", `XAUTH='${join(bin, "xauth")}'`)
    .replace('LOCK_FILE="/tmp/.X${DISPLAY_NUMBER}-lock"', `LOCK_FILE='${join(root, "lock")}'`)
    .replace('SOCKET_FILE="/tmp/.X11-unix/X${DISPLAY_NUMBER}"', `SOCKET_FILE='${socket}'`);
  const launcherPath = join(root, "launcher");
  await writeFile(launcherPath, launcher, { mode: 0o755 });
  await writeFile(join(bin, "xauth"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    root,
    app,
    runtime,
    bin,
    socket,
    launcher: launcherPath,
    env: {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      TEST_SOCKET: socket,
      TEST_VELLUM_PID: join(root, "vellum.pid"),
    },
  };
};

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
    expect(launcher).toContain('wait "$vellum_pid"');
    expect(launcher).toContain('vellum_status="$?"');
    expect(launcher).toContain('exit "$vellum_status"');
    expect(launcher).toContain('kill -TERM -- "-$vellum_pid"');
    expect(launcher).toContain('owned_child_alive "$xvfb_pid"');
    expect(launcher).toContain('[ ! -O "$LOCK_FILE" ]');
    expect(launcher).toContain("LC_ALL=C /usr/bin/sed 's/^[ \\t]*//; s/[ \\t]*$//'");
    expect(launcher).not.toMatch(/--no-sandbox|disable-setuid-sandbox|pkill|killall|sudo|loginctl enable-linger|-ac/u);
  });

  it("defines a bounded user unit without role or host mutation", async () => {
    const unit = await asset("vellum-remote.service");
    expect(unit).toContain("ExecStart=/opt/Vellum\\x20Command/resources/systemd/vellum-remote-launch-v1");
    expect(parseSystemdExecStart(unit)).toBe(
      "/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1",
    );
    expect(() => parseSystemdExecStart(unit.replace("ExecStart=/opt/Vellum\\x20", "ExecStart=/opt/Vellum "))).toThrow(/escaped/u);
    expect(() => validateSystemdUserUnit(unit)).not.toThrow();
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("StartLimitBurst=3");
    expect(unit).toContain("TimeoutStartSec=45s");
    expect(unit).toContain("TimeoutStopSec=20s");
    expect(unit).toContain("ConditionPathIsExecutable=/opt/Vellum\\x20Command/vellum");
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

  it("registers only the exact immutable unit without activating a user manager", async () => {
    const [beforeInstall, afterInstall, afterRemove] = await Promise.all([
      asset("before-install.sh"),
      asset("after-install.sh"),
      asset("after-remove.sh"),
    ]);
    for (const hook of [beforeInstall, afterInstall, afterRemove]) {
      expect(hook).toContain(LINUX_SYSTEMD_USER_UNIT_PATH);
      expect(hook).not.toMatch(/systemctl|enable-linger|loginctl/u);
    }
    expect(beforeInstall).toContain("refusing an existing administrator-owned systemd user unit");
    expect(afterInstall).toContain('ln -s "$UNIT_SOURCE" "$UNIT_TARGET"');
    expect(afterRemove).toContain('rm -f -- "$UNIT_TARGET"');
  });

  it("preserves a pre-existing Xauthority directory byte-for-byte", async () => {
    if (process.platform !== "linux") return;
    const sandbox = await linuxLauncherSandbox();
    const authorityDirectory = join(sandbox.runtime, "vellum-remote-x11");
    const authority = join(authorityDirectory, "authority");
    try {
      await mkdir(authorityDirectory, { mode: 0o700 });
      await writeFile(authority, "foreign-live-authority", { mode: 0o600 });
      await expect(execFileAsync(sandbox.launcher, [], { env: sandbox.env })).rejects.toMatchObject({
        code: 75,
      });
      await expect(readFile(authority, "utf8")).resolves.toBe("foreign-live-authority");
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });

  it("terminates the owned Vellum group and fails when Xvfb exits first", async () => {
    if (process.platform !== "linux") return;
    const sandbox = await linuxLauncherSandbox();
    try {
      await writeFile(join(sandbox.bin, "Xvfb"), `#!/bin/sh
python3 - "$TEST_SOCKET" <<'PY'
import socket, sys, time
sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
time.sleep(1)
PY
`, { mode: 0o755 });
      await writeFile(join(sandbox.app, "vellum"), `#!/bin/sh
echo "$$" > "$TEST_VELLUM_PID"
while :; do sleep 1; done
`, { mode: 0o755 });
      await expect(execFileAsync(sandbox.launcher, [], { env: sandbox.env })).rejects.toMatchObject({
        code: 70,
      });
      const pid = Number((await readFile(sandbox.env.TEST_VELLUM_PID, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  });
});
