import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINUX_SYSTEMD_USER_UNIT_PATH,
  LINUX_SYSTEMD_UNSET_ENVIRONMENT,
  parseSystemdExecStart,
  validateSystemdUserUnit,
} from "../scripts/audit-linux-package";

const asset = (name: string) =>
  readFile(new URL(`../build/linux/${name}`, import.meta.url), "utf8");
const execFileAsync = promisify(execFile);
let launcherSequence = 0;

const waitForTextFile = async (file: string): Promise<string> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\"'\"'`)}'`;

const readyVellum = (
  vellumPid: string,
  environmentCapture: string,
): string => `#!/bin/sh
echo "$$" > ${shellQuote(vellumPid)}
/usr/bin/env | /usr/bin/sort > ${shellQuote(environmentCapture)}
work="$HOME/.vellum/work"
mkdir -p "$work"
printf 'test-token\\n' > "$work/token"
printf '%s' "$INVOCATION_ID" > "$XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID"
exec python3 - "$work/control.sock" <<'PY'
import os, socket, sys, time
path = sys.argv[1]
sock = socket.socket(socket.AF_UNIX)
sock.bind(path)
os.chmod(path, 0o600)
while True: time.sleep(1)
PY
`;

const linuxLauncherSandbox = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-remote-launcher-"));
  const app = join(root, "app");
  const runtime = join(root, "runtime");
  const serviceRuntime = join(runtime, "vellum-remote");
  const bin = join(root, "bin");
  const notifySocket = join(runtime, "systemd", "notify");
  const vellumPid = join(root, "vellum.pid");
  const xvfbPid = join(root, "xvfb.pid");
  const environmentCapture = join(root, "vellum.environment");
  const displayNumber = 10_000 + ((process.pid % 10_000) * 10) + (launcherSequence += 1);
  await Promise.all([mkdir(app), mkdir(runtime), mkdir(bin)]);
  await mkdir(serviceRuntime, { mode: 0o700 });
  const launcherPath = join(root, "launcher");
  const launcher = (await asset("vellum-remote-launch-v1"))
    .replace(
      "CLEAN_SELF='/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1'",
      `CLEAN_SELF=${shellQuote(launcherPath)}`,
    )
    .replace("APP_DIR='/opt/Vellum Command'", `APP_DIR='${app}'`)
    .replace("XVFB='/usr/bin/Xvfb'", `XVFB='${join(bin, "Xvfb")}'`)
    .replace("XAUTH='/usr/bin/xauth'", `XAUTH='${join(bin, "xauth")}'`)
    .replace("DISPLAY_FIRST=89", `DISPLAY_FIRST=${displayNumber}`)
    .replace("DISPLAY_LAST=96", `DISPLAY_LAST=${displayNumber}`)
    .replace("SYSTEMD_NOTIFY='/usr/bin/systemd-notify'", `SYSTEMD_NOTIFY='${join(bin, "systemd-notify")}'`);
  await writeFile(launcherPath, launcher, { mode: 0o755 });
  await writeFile(join(app, "vellum"), "#!/bin/sh\nexit 70\n", { mode: 0o755 });
  await writeFile(join(bin, "Xvfb"), "#!/bin/sh\nexit 70\n", { mode: 0o755 });
  await writeFile(join(bin, "xauth"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "systemd-notify"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    root,
    app,
    runtime,
    bin,
    launcher: launcherPath,
    display: `:${displayNumber}`,
    vellumPid,
    xvfbPid,
    environmentCapture,
    env: {
      HOME: root,
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: join(root, ".local", "state"),
      NOTIFY_SOCKET: notifySocket,
      INVOCATION_ID: "a".repeat(32),
      NODE_OPTIONS: "--require=/tmp/must-not-reach-vellum.js",
      VELLUM_E2E: "must-not-reach-vellum",
      EXTRA_AUTHORITY: "must-not-reach-vellum",
    },
  };
};

describe("Linux Remote systemd/Xvfb package assets", () => {
  it("ships a versioned, fixed-argument Xvfb launcher", async () => {
    const launcher = await asset("vellum-remote-launch-v1");
    expect((await stat(new URL("../build/linux/vellum-remote-launch-v1", import.meta.url))).mode & 0o777).toBe(0o755);
    expect(launcher).toContain(
      "CLEAN_SELF='/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1'",
    );
    expect(launcher.match(/exec \/usr\/bin\/env -i/gu)).toHaveLength(1);
    expect(launcher).toContain("PATH='/usr/bin:/bin' \\");
    expect(launcher).toContain('HOME="$CLEAN_HOME" \\');
    expect(launcher).toContain('PWD="$CLEAN_HOME" \\');
    expect(launcher).toContain('XDG_STATE_HOME="$CLEAN_STATE_HOME" \\');
    expect(launcher).toContain('XDG_RUNTIME_DIR="$CLEAN_RUNTIME_DIRECTORY" \\');
    expect(launcher).toContain('INVOCATION_ID="$CLEAN_GENERATION" \\');
    expect(launcher).toContain("ELECTRON_OZONE_PLATFORM_HINT='x11' \\");
    expect(launcher).toContain("OZONE_PLATFORM='x11' \\");
    expect(launcher).toContain("XDG_SESSION_TYPE='x11' \\");
    expect(launcher).toContain(
      '[ "$CLEAN_NOTIFY_SOCKET" != "$CLEAN_RUNTIME_DIRECTORY/systemd/notify" ]',
    );
    expect(launcher).not.toContain('NOTIFY_SOCKET="$CLEAN_NOTIFY_SOCKET" \\');
    expect(launcher).toContain('"$CLEAN_SELF" --clean');
    expect(launcher).toContain(
      `if [ "$#" -ne 1 ] || [ "$1" != '--clean' ]; then`,
    );
    expect(launcher).toContain("VELLUM=\"$APP_DIR/vellum\"");
    expect(launcher).toContain('"$VELLUM" --vellum-headless --ozone-platform=x11 &');
    expect(launcher).toContain('"$XVFB" "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp -auth "$XAUTHORITY" &');
    expect(launcher).toContain('"$XAUTH" -f "$XAUTHORITY" add "$DISPLAY" . "$(/usr/bin/mcookie)" >/dev/null 2>&1');
    expect(launcher).toContain("DISPLAY_FIRST=89");
    expect(launcher).toContain("DISPLAY_LAST=96");
    expect(launcher).not.toContain('rm -f -- "$LOCK_FILE"');
    expect(launcher).toContain('no managed display is available');
    expect(launcher).not.toContain('--pid=parent');
    expect(launcher).toContain(
      'SYSTEMD_NOTIFY_SOCKET="$RUNTIME_DIRECTORY/systemd/notify"',
    );
    expect(launcher).toContain('NOTIFY_SOCKET="$SYSTEMD_NOTIFY_SOCKET" "$SYSTEMD_NOTIFY" --ready');
    expect(launcher).toContain('is_owned_private_socket "$control_socket"');
    expect(launcher).toContain('is_owned_private_file "$control_token"');
    expect(launcher).toContain('candidate_socket="/tmp/.X11-unix/X${candidate}"');
    expect(launcher).toContain("kill -TERM \"$xvfb_pid\"");
    expect(launcher).toContain("umask 077");
    expect(launcher).toContain('wait "$vellum_pid"');
    expect(launcher).toContain('vellum_status="$?"');
    expect(launcher).toContain('exit "$vellum_status"');
    expect(launcher).toContain('signal_owned_group TERM "$vellum_pid"');
    expect(launcher).toContain('owned_child_alive "$xvfb_pid"');
    expect(launcher).toContain('ensure_owned_directory()');
    expect(launcher).toContain('refusing managed directory symlink');
    expect(launcher).not.toContain('chmod 0600 "$XAUTHORITY"');
    expect(launcher).toContain('signal_owned_group KILL "$vellum_pid"');
    expect(launcher).toContain('is_positive_pid "$group_leader"');
    expect(launcher).toContain('/bin/kill "-$signal" -- "-$group_leader"');
    expect(launcher).toContain('while [ "$attempts" -lt 3 ]');
    expect(launcher).not.toContain('kill -TERM --');
    expect(launcher).not.toContain('kill -KILL --');
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
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("NotifyAccess=all");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("StartLimitBurst=3");
    expect(unit).toContain("TimeoutStartSec=45s");
    expect(unit).toContain("TimeoutStopSec=20s");
    expect(unit).toContain("ConditionFileIsExecutable=/opt/Vellum Command/vellum");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WorkingDirectory=%h");
    expect(unit).toContain("RuntimeDirectory=vellum-remote");
    expect(unit).toContain("RuntimeDirectoryMode=0700");
    expect(unit).toContain("RuntimeDirectoryPreserve=no");
    expect(unit).toContain("Environment=ELECTRON_OZONE_PLATFORM_HINT=x11");
    expect(unit).toContain(
      `UnsetEnvironment=${LINUX_SYSTEMD_UNSET_ENVIRONMENT.join(" ")}`,
    );
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
    const authorityDirectory = join(sandbox.runtime, "vellum-remote", `x11-${sandbox.env.INVOCATION_ID}`);
    const authority = join(authorityDirectory, "authority");
    try {
      await mkdir(authorityDirectory, { mode: 0o700 });
      await writeFile(authority, "foreign-live-authority", { mode: 0o600 });
      await expect(execFileAsync(sandbox.launcher, [], {
        cwd: sandbox.root,
        env: sandbox.env,
      })).rejects.toMatchObject({
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
python3 - "$1" <<'PY'
import socket, sys, time
display = sys.argv[1].removeprefix(':')
sock = socket.socket(socket.AF_UNIX)
sock.bind('/tmp/.X11-unix/X' + display)
time.sleep(3)
PY
`, { mode: 0o755 });
      await writeFile(
        join(sandbox.app, "vellum"),
        readyVellum(sandbox.vellumPid, sandbox.environmentCapture),
        { mode: 0o755 },
      );
      await expect(execFileAsync(sandbox.launcher, [], {
        cwd: sandbox.root,
        env: sandbox.env,
      })).rejects.toMatchObject({
        code: 70,
      });
      const pid = Number((await readFile(sandbox.vellumPid, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
      const environment = await readFile(sandbox.environmentCapture, "utf8");
      expect(environment.trimEnd().split("\n")).toEqual([
        `DISPLAY=${sandbox.display}`,
        "ELECTRON_OZONE_PLATFORM_HINT=x11",
        `HOME=${sandbox.root}`,
        `INVOCATION_ID=${sandbox.env.INVOCATION_ID}`,
        "OZONE_PLATFORM=x11",
        "PATH=/usr/bin:/bin",
        `PWD=${sandbox.root}`,
        `XAUTHORITY=${join(
          sandbox.runtime,
          "vellum-remote",
          `x11-${sandbox.env.INVOCATION_ID}`,
          "authority",
        )}`,
        `XDG_RUNTIME_DIR=${sandbox.runtime}`,
        "XDG_SESSION_TYPE=x11",
        `XDG_STATE_HOME=${join(sandbox.root, ".local", "state")}`,
      ]);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }, 12_000);

  it("returns the Xvfb failure while systemd owns authority-directory removal", async () => {
    if (process.platform !== "linux") return;
    const sandbox = await linuxLauncherSandbox();
    const authorityDirectory = join(sandbox.runtime, "vellum-remote", `x11-${sandbox.env.INVOCATION_ID}`);
    try {
      await writeFile(join(sandbox.bin, "xauth"), `#!/bin/sh
authority="$2"
replacement="${'$'}{authority}.replacement"
printf 'replacement-authority\\n' > "${'$'}replacement"
mv "${'$'}replacement" "${'$'}authority"
`, { mode: 0o755 });
      await writeFile(join(sandbox.bin, "Xvfb"), `#!/bin/sh
python3 - "$1" <<'PY'
import socket, sys, time
display = sys.argv[1].removeprefix(':')
sock = socket.socket(socket.AF_UNIX)
sock.bind('/tmp/.X11-unix/X' + display)
time.sleep(3)
PY
`, { mode: 0o755 });
      await writeFile(
        join(sandbox.app, "vellum"),
        readyVellum(sandbox.vellumPid, sandbox.environmentCapture),
        { mode: 0o755 },
      );
      await expect(execFileAsync(sandbox.launcher, [], {
        cwd: sandbox.root,
        env: sandbox.env,
      })).rejects.toMatchObject({
        code: 70,
      });
      expect((await stat(authorityDirectory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }, 12_000);

  it("cleans both owned child groups when the wrapper receives TERM", async () => {
    if (process.platform !== "linux") return;
    const sandbox = await linuxLauncherSandbox();
    try {
      await writeFile(join(sandbox.bin, "Xvfb"), `#!/bin/sh
echo "$$" > ${shellQuote(sandbox.xvfbPid)}
exec python3 - "$1" <<'PY'
import socket, sys, time
display = sys.argv[1].removeprefix(':')
sock = socket.socket(socket.AF_UNIX)
sock.bind('/tmp/.X11-unix/X' + display)
while True: time.sleep(1)
PY
`, { mode: 0o755 });
      await writeFile(
        join(sandbox.app, "vellum"),
        readyVellum(sandbox.vellumPid, sandbox.environmentCapture),
        { mode: 0o755 },
      );
      const wrapper = spawn(sandbox.launcher, [], {
        cwd: sandbox.root,
        env: sandbox.env,
        stdio: "ignore",
      });
      const [vellumPid, xvfbPid] = await Promise.all([
        waitForTextFile(sandbox.vellumPid),
        waitForTextFile(sandbox.xvfbPid),
      ]);
      const wrapperPid = wrapper.pid;
      if (wrapperPid === undefined) {
        throw new Error("launcher process did not expose a pid");
      }
      const [wrapperEnvironment, wrapperArguments] = await Promise.all([
        readFile(`/proc/${wrapperPid}/environ`, "utf8"),
        readFile(`/proc/${wrapperPid}/cmdline`, "utf8"),
      ]);
      expect(
        wrapperEnvironment.split("\0").filter(Boolean).sort(),
      ).toEqual([
        "ELECTRON_OZONE_PLATFORM_HINT=x11",
        `HOME=${sandbox.root}`,
        `INVOCATION_ID=${sandbox.env.INVOCATION_ID}`,
        "OZONE_PLATFORM=x11",
        "PATH=/usr/bin:/bin",
        `PWD=${sandbox.root}`,
        `XDG_RUNTIME_DIR=${sandbox.runtime}`,
        "XDG_SESSION_TYPE=x11",
        `XDG_STATE_HOME=${join(sandbox.root, ".local", "state")}`,
      ]);
      const argv = wrapperArguments.split("\0").filter(Boolean);
      expect(["/bin/sh", "/bin/dash", "/usr/bin/dash"]).toContain(argv[0]);
      expect(argv.slice(1)).toEqual([sandbox.launcher, "--clean"]);
      wrapper.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        wrapper.once("error", reject);
        wrapper.once("close", () => resolve());
      });
      for (const pid of [vellumPid, xvfbPid].map((value) => Number(value.trim()))) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }, 12_000);
});
