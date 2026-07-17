/**
 * Stage clipboard/dropped image bytes on the herdr host, then paste the path
 * via stock `terminal.input`. No herdr protocol extensions.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKnownHerdrHost, sshTargetForHost, UnknownHerdrHostError } from "./hosts";

/** Match common agent clipboard-image caps (16 MiB). */
export const VELLUM_CLIPBOARD_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export type StageImageResult =
  | { readonly ok: true; readonly path: string; readonly extension: string; readonly byteLength: number }
  | { readonly ok: false; readonly error: string };

export const normalizeImageExtension = (extension: string): string | undefined => {
  const ext = extension.trim().replace(/^\./, "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return undefined;
  return ext === "jpeg" ? "jpg" : ext;
};

export const decodeClipboardImageBase64 = (
  extension: string,
  dataBase64: string,
): { readonly ok: true; readonly extension: string; readonly bytes: Buffer } | { readonly ok: false; readonly error: string } => {
  const ext = normalizeImageExtension(extension);
  if (!ext) {
    return { ok: false, error: `clipboard image extension not allowed: ${extension.trim() || "(empty)"}` };
  }
  if (!dataBase64) return { ok: false, error: "clipboard image bytes required" };
  // Bound before decode so a hostile IPC caller cannot force huge peak alloc.
  const maxB64 = Math.ceil((VELLUM_CLIPBOARD_IMAGE_MAX_BYTES * 4) / 3) + 8;
  if (dataBase64.length > maxB64) {
    return {
      ok: false,
      error: `image too large (base64 length ${dataBase64.length}; max ~${maxB64})`,
    };
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength === 0) return { ok: false, error: "empty image" };
  if (bytes.byteLength > VELLUM_CLIPBOARD_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      error: `image too large (${bytes.byteLength} bytes; max ${VELLUM_CLIPBOARD_IMAGE_MAX_BYTES})`,
    };
  }
  return { ok: true, extension: ext, bytes };
};

/** Bracketed paste so pane apps that enable it receive the path atomically. */
export const pastePathPayload = (absolutePath: string): string =>
  `\x1b[200~${absolutePath}\x1b[201~`;

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const uniqueName = (extension: string): string =>
  `vellum-clip-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${extension}`;

export type RunSshResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Injectable ssh runner for remote staging (tests mock this; prod uses real spawn). */
export type RunSsh = (
  target: string,
  remoteCommand: string,
  stdin?: Buffer,
) => Promise<RunSshResult>;

export type StageImageDeps = {
  readonly runSsh?: RunSsh;
};

/** Default production ssh: BatchMode + keepalives, binary stdin for cat writes. */
export const defaultRunSsh: RunSsh = (target, remoteCommand, stdin) =>
  new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "ConnectTimeout=6",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        target,
        remoteCommand,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        error: (stderr.trim() || `ssh exited ${code ?? "null"}`).slice(0, 300),
      });
    });
    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

/**
 * Write image bytes onto the host that owns the herdr pane.
 * local: $TMPDIR/vellum-herdr-images-<uid>/file
 * remote: /tmp/vellum-herdr-images/file via ssh + cat (binary stdin)
 *
 * Pass `deps.runSsh` in tests to mock remote mkdir/write without real ssh.
 */
export const stageImageOnHost = async (
  hostId: string,
  extension: string,
  dataBase64: string,
  deps: StageImageDeps = {},
): Promise<StageImageResult> => {
  if (!isKnownHerdrHost(hostId) || hostId.startsWith("-")) {
    return { ok: false, error: new UnknownHerdrHostError(hostId).message };
  }

  const decoded = decodeClipboardImageBase64(extension, dataBase64);
  if (!decoded.ok) return decoded;

  const name = uniqueName(decoded.extension);

  if (hostId === "local") {
    const uid =
      typeof process.getuid === "function" ? String(process.getuid()) : String(process.pid);
    const dir = join(tmpdir(), `vellum-herdr-images-${uid}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, name);
      await writeFile(path, decoded.bytes, { mode: 0o600 });
      return {
        ok: true,
        path,
        extension: decoded.extension,
        byteLength: decoded.bytes.byteLength,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const sshTarget = sshTargetForHost(hostId);
  if (!sshTarget || sshTarget.startsWith("-")) {
    return { ok: false, error: new UnknownHerdrHostError(hostId).message };
  }

  const runSsh = deps.runSsh ?? defaultRunSsh;

  // Fixed remote dir under /tmp - path is fully controlled (no user input).
  const remoteDir = "/tmp/vellum-herdr-images";
  const remotePath = `${remoteDir}/${name}`;
  const mkdirRes = await runSsh(
    sshTarget,
    `mkdir -p ${shellSingleQuote(remoteDir)} && chmod 700 ${shellSingleQuote(remoteDir)}`,
  );
  if (!mkdirRes.ok) {
    return { ok: false, error: `remote mkdir failed: ${mkdirRes.error}` };
  }
  const writeRes = await runSsh(
    sshTarget,
    `cat > ${shellSingleQuote(remotePath)} && chmod 600 ${shellSingleQuote(remotePath)}`,
    decoded.bytes,
  );
  if (!writeRes.ok) {
    return { ok: false, error: `remote write failed: ${writeRes.error}` };
  }
  return {
    ok: true,
    path: remotePath,
    extension: decoded.extension,
    byteLength: decoded.bytes.byteLength,
  };
};
