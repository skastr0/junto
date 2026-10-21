import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_HOME_ENV,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_TOKEN_HEADER,
  controlDir,
  controlSocketPath,
  controlTokenPath,
  isValidControlRequestId,
} from "../src/shared/browser-control";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Server[] = [];

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

const newRoot = async (): Promise<string> => {
  // Unix-domain socket paths are capped at 104 bytes on macOS. Keep the
  // fixture prefix short now that the canonical home directory is longer.
  const root = await mkdtemp(join(tmpdir(), "vcb-"));
  roots.push(root);
  await mkdir(controlDir(root), { recursive: true });
  await writeFile(controlTokenPath(root), "transport-token\n", { mode: 0o600 });
  return root;
};

const startRogueControl = async (
  root: string,
  seen: SeenRequest[],
): Promise<void> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const encoded = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: encoded.length === 0 ? undefined : JSON.parse(encoded),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: req.url === "/doctor" ? { status: "ok" } : [] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(controlSocketPath(root), resolveListen);
  });
};

const leaveStaleControlSocket = async (root: string): Promise<void> => {
  const stage = join(controlDir(root), "stage.sock");
  const target = controlSocketPath(root);
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(stage, resolveListen);
  });
  await rename(stage, target);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  expect((await lstat(target)).isSocket()).toBe(true);
};

const runCli = (
  args: ReadonlyArray<string>,
  options: {
    readonly home: string;
    readonly controlHome?: string;
  },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      // This suite exercises the browser-on contract. Source-run CLIs
      // otherwise follow the same default-off policy as packaged controls.
      JUNTO_BROWSER: "1",
      [CONTROL_HOME_ENV]: options.controlHome,
    };
    const child = spawn("bun", [join(repoRoot, "src/cli/main.ts"), "browser", ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("browser CLI test timed out"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const envelope = (text: string): unknown => JSON.parse(text.trim()) as unknown;

// Each case spawns the CLI one or more times; a loaded machine needs the room.
describe("junto browser on the standard envelope", { timeout: 30_000 }, () => {
  it("answers doctor in the success envelope over the control socket", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const first = await runCli(["doctor"], { home: root });
    const second = await runCli(["doctor"], { home: root });

    for (const result of [first, second]) {
      expect(result.code, result.stderr).toBe(0);
      expect(envelope(result.stdout)).toEqual({ ok: true, command: "browser doctor", data: { status: "ok" } });
    }
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.url).toBe("/doctor");
      expect(request.headers[CONTROL_TOKEN_HEADER]).toBe("transport-token");
      expect(isValidControlRequestId(String(request.headers[CONTROL_REQUEST_ID_HEADER]))).toBe(true);
    }
    expect(seen[0]?.headers[CONTROL_REQUEST_ID_HEADER]).not.toBe(
      seen[1]?.headers[CONTROL_REQUEST_ID_HEADER],
    );
  });

  it("honors an isolated control home without a client authority credential", async () => {
    const root = await newRoot();
    const decoyHome = await mkdtemp(join(tmpdir(), "vcb-home-"));
    roots.push(decoyHome);
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const result = await runCli(["profiles"], {
      home: decoyHome,
      controlHome: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(envelope(result.stdout)).toEqual({ ok: true, command: "browser profiles", data: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/profiles");
    expect(seen[0]?.headers[CONTROL_TOKEN_HEADER]).toBe("transport-token");
  });

  it("sends protected commands without a capability secret (process-bind path)", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const result = await runCli(["pages"], {
      home: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/pages");
    expect(seen[0]?.headers[CONTROL_TOKEN_HEADER]).toBe("transport-token");
  });

  it("names a tab with --tab, and sends none when it is absent", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const named = await runCli(["shot", "session-1", "--tab", "tab-2"], { home: root });
    const active = await runCli(["goto", "session-1", "https://example.com/"], { home: root });

    expect(named.code, named.stderr).toBe(0);
    expect(active.code, active.stderr).toBe(0);
    expect(seen.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: "/screenshot", body: { sessionId: "session-1", tab: "tab-2" } },
      { url: "/goto", body: { sessionId: "session-1", url: "https://example.com/" } },
    ]);
  });

  it("refuses bad input as InputError before transport", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    for (const [args, command] of [
      [["goto", "bad id", "https://example.com/"], "browser goto"],
      [["eval", "session-1", "1", "--tab", ""], "browser eval"],
    ] as const) {
      const result = await runCli([...args], { home: root });
      expect(result.code).toBe(1);
      expect(envelope(result.stderr)).toMatchObject({ ok: false, command, error: { type: "InputError" } });
    }
    expect(seen).toHaveLength(0);
  });

  it("exposes protected Stop Page without exposing profile wipe on the agent CLI", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const stop = await runCli(["stop", "session-1"], {
      home: root,
    });
    const wipe = await runCli(["wipe-profile", "personal"], { home: root });

    expect(stop.code, stop.stderr).toBe(0);
    expect(wipe.code).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/stop",
      body: { sessionId: "session-1" },
    });
  });

  it("has no --host, station or station-trust, and never reaches transport for them", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    for (const argv of [
      ["--host", "remote-a", "doctor"],
      ["doctor", "--host", "remote-a"],
      ["station"],
      ["station-trust"],
      ["shot", "session-1", "--path", "/tmp/x.png"],
    ] as const) {
      const result = await runCli([...argv], { home: root });
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.stdout).not.toContain('"ok":true');
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects a non-absolute control home before transport", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const invalidHome = await runCli(["doctor"], {
      home: root,
      controlHome: "relative/home",
    });
    expect(invalidHome.code).toBe(1);
    expect(envelope(invalidHome.stderr)).toMatchObject({
      ok: false,
      command: "browser doctor",
      error: { type: "InputError", details: { reason: "bad_request" } },
    });
    expect(seen).toHaveLength(0);
  });

  it("does not echo the control-home token path when the app is down", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcb-down-"));
    roots.push(root);
    const result = await runCli(["doctor"], { home: root });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(controlTokenPath(root));
    expect(envelope(result.stderr)).toMatchObject({
      ok: false,
      error: { type: "RuntimeDown", details: { reason: "runtime_down", retryable: true } },
    });
  });

  it("reports RuntimeDown when a retained token outlives the removed socket", async () => {
    const root = await newRoot();
    const result = await runCli(["doctor"], { home: root });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(controlSocketPath(root));
    expect(envelope(result.stderr)).toEqual({
      ok: false,
      command: "browser doctor",
      error: {
        type: "RuntimeDown",
        message: "Junto app is not running",
        details: { reason: "runtime_down", retryable: true, next_step: "start the Junto app on this machine" },
      },
    });
  });

  it("reports RuntimeDown when a crashed runtime leaves a stale socket inode", async () => {
    const root = await newRoot();
    await leaveStaleControlSocket(root);
    const result = await runCli(["doctor"], { home: root });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(controlSocketPath(root));
    expect(envelope(result.stderr)).toMatchObject({
      ok: false,
      command: "browser doctor",
      error: { type: "RuntimeDown", message: "Junto app is not running" },
    });
  });
});

describe("browser CLI packaging contract", () => {
  it("packages one CLI and installs only the Junto", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      readonly build: {
        readonly files: ReadonlyArray<string>;
        readonly extraResources: ReadonlyArray<{ readonly from: string; readonly to: string }>;
      };
    };
    const buildScript = await readFile(join(repoRoot, "scripts/build-app.sh"), "utf8");
    const cliBuildScript = await readFile(join(repoRoot, "scripts/build-standalone-cli.ts"), "utf8");
    const installScript = await readFile(join(repoRoot, "scripts/install-app.sh"), "utf8");
    const browserCli = await readFile(join(repoRoot, "src/cli/core/browser-control-client.ts"), "utf8");

    expect(pkg.build.extraResources).toEqual([
      { from: "dist/junto", to: "bin/junto" },
      { from: "dist/machines", to: "machines" },
    ]);
    expect(pkg.build.files).not.toContain("scripts/**");
    expect(cliBuildScript).toContain("--no-compile-autoload-dotenv");
    expect(cliBuildScript).toContain("--no-compile-autoload-bunfig");
    const cliBuildPosition = buildScript.indexOf('"$SCRIPT_DIR/build-standalone-cli.ts" junto');
    expect(cliBuildPosition).toBeGreaterThanOrEqual(0);
    expect(cliBuildPosition).toBeLessThan(
      buildScript.indexOf('if [[ "$COMPILE_ONLY" -eq 1 ]]'),
    );
    expect(buildScript).not.toContain("junto-browser");
    expect(buildScript).not.toContain("junto-station");
    expect(buildScript).not.toContain("junto-content");
    expect(installScript).toContain('install_cli_link "junto"');
    expect(installScript).not.toContain('install_cli_link "junto-browser"');
    expect(installScript).not.toContain('install_cli_link "junto-station"');
    expect(installScript).not.toContain('install_cli_link "junto-content"');
    expect(installScript).toContain('local work_helper="$APP_DST/Contents/Resources/bin/junto"');
    expect(installScript).toContain('ln -s "$helper" "$target"');
    expect(installScript).toContain('CLI link changed identity during creation');
    expect(installScript).not.toContain('mv -f "$stage" "$target"');
    expect(installScript).toContain("refusing to replace non-symlink command");
    expect(installScript).toContain('[[ "$existing" != "$helper" ]]');
    expect(browserCli).not.toMatch(
      /CONTROL_CAPABILITY|JUNTO_BROWSER_CAPABILITY|x-junto-capability/u,
    );
  });
});
