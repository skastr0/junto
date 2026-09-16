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
    readonly entry?: "browser" | "vellum-command";
  },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      // This suite exercises the browser-on compatibility contract. Source-run
      // CLIs otherwise follow the same default-off policy as packaged controls.
      JUNTO_BROWSER: "1",
      [CONTROL_HOME_ENV]: options.controlHome,
    };
    const entry =
      options.entry === "vellum-command"
        ? [join(repoRoot, "src/cli/main.ts"), "browser"]
        : [join(repoRoot, "scripts/browser-cli.ts")];
    const child = spawn("bun", [...entry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("browser CLI test timed out"));
    }, 5_000);
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

describe("packaged browser CLI contract", () => {
  it("supports the canonical vellum-command browser command and standalone compatibility helper", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const direct = await runCli(["doctor", "--json"], {
      home: root,
    });
    const dispatched = await runCli(["browser", "doctor", "--json"], {
      home: root,
    });
    const canonical = await runCli(["doctor", "--json"], {
      home: root,
      entry: "vellum-command",
    });

    expect(direct.code, direct.stderr).toBe(0);
    expect(dispatched.code, dispatched.stderr).toBe(0);
    expect(canonical.code, canonical.stderr).toBe(0);
    expect(seen).toHaveLength(3);
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

    const result = await runCli(["profiles", "--json"], {
      home: decoyHome,
      controlHome: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/profiles");
    expect(seen[0]?.headers[CONTROL_TOKEN_HEADER]).toBe("transport-token");
  });

  it("sends protected commands without a capability secret (process-bind path)", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const result = await runCli(["pages", "--json"], {
      home: root,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/pages");
    expect(seen[0]?.headers[CONTROL_TOKEN_HEADER]).toBe("transport-token");
  });

  it("exposes protected Stop Page without exposing profile wipe on the agent CLI", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const stop = await runCli(["stop", "session-1", "--json"], {
      home: root,
    });
    const wipe = await runCli(["wipe-profile", "personal", "--json"], { home: root });

    expect(stop.code, stop.stderr).toBe(0);
    expect(wipe.code).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/stop",
      body: { sessionId: "session-1" },
    });
  });

  it("rejects retired remote Station-browser flags before token/socket/network", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    for (const argv of [
      ["--host", "remote-a", "doctor", "--json"],
      ["doctor", "--host", "remote-a", "--json"],
      ["station"],
      ["station-trust"],
    ] as const) {
      const result = await runCli([...argv], { home: root });
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(2);
      expect(result.stderr).toMatch(/remote Station-browser is removed/i);
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects a non-absolute control home before transport", async () => {
    const root = await newRoot();
    const seen: SeenRequest[] = [];
    await startRogueControl(root, seen);

    const invalidHome = await runCli(["doctor", "--json"], {
      home: root,
      controlHome: "relative/home",
    });
    expect(invalidHome.code).toBe(1);
    expect(JSON.parse(invalidHome.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "bad_request" },
    });
    expect(seen).toHaveLength(0);
  });

  it("does not echo the control-home token path when the app is down", async () => {
    const root = await mkdtemp(join(tmpdir(), "vcb-down-"));
    roots.push(root);
    const result = await runCli(["doctor", "--json"], { home: root });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(controlTokenPath(root));
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "runtime_down" },
    });
  });

  it("reports runtime_down when a retained token outlives the removed socket", async () => {
    const root = await newRoot();
    const result = await runCli(["doctor", "--json"], { home: root });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(controlSocketPath(root));
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        _tag: "runtime_down",
        message: "Junto app is not running",
      },
    });
  });

  it("reports runtime_down when a crashed runtime leaves a stale socket inode", async () => {
    const root = await newRoot();
    await leaveStaleControlSocket(root);
    const result = await runCli(["doctor", "--json"], { home: root });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(controlSocketPath(root));
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        _tag: "runtime_down",
        message: "Junto app is not running",
      },
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
    const browserCli = await readFile(join(repoRoot, "scripts/browser-cli.ts"), "utf8");

    expect(pkg.build.extraResources).toEqual([
      { from: "dist/vellum-command", to: "bin/vellum-command" },
      { from: "scripts/unix-peer-pid.py", to: "bin/unix-peer-pid.py" },
    ]);
    expect(pkg.build.files).not.toContain("scripts/**");
    expect(cliBuildScript).toContain("--no-compile-autoload-dotenv");
    expect(cliBuildScript).toContain("--no-compile-autoload-bunfig");
    const cliBuildPosition = buildScript.indexOf('"$SCRIPT_DIR/build-standalone-cli.ts" vellum-command');
    expect(cliBuildPosition).toBeGreaterThanOrEqual(0);
    expect(cliBuildPosition).toBeLessThan(
      buildScript.indexOf('if [[ "$COMPILE_ONLY" -eq 1 ]]'),
    );
    expect(buildScript).not.toContain("vellum-command-browser");
    expect(buildScript).not.toContain("vellum-command-station");
    expect(buildScript).not.toContain("vellum-command-content");
    expect(installScript).toContain('install_cli_link "vellum-command"');
    expect(installScript).not.toContain('install_cli_link "vellum-command-browser"');
    expect(installScript).not.toContain('install_cli_link "vellum-command-station"');
    expect(installScript).not.toContain('install_cli_link "vellum-command-content"');
    expect(installScript).toContain('local work_helper="$APP_DST/Contents/Resources/bin/vellum-command"');
    expect(installScript).toContain('ln -s "$helper" "$target"');
    expect(installScript).toContain('CLI link changed identity during creation');
    expect(installScript).not.toContain('mv -f "$stage" "$target"');
    expect(installScript).toContain("refusing to replace non-symlink command");
    expect(installScript).toContain('[[ "$existing" != "$helper" ]]');
    expect(browserCli).not.toMatch(
      /CONTROL_CAPABILITY|JUNTO_BROWSER_CAPABILITY|x-vellum-command-capability/u,
    );
  });
});
