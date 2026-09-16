/**
 * node-pty's spawn-helper must be executable. Bun (and some extract paths)
 * can drop +x on prebuilds, which surfaces as:
 *   [junto] failed to spawn: native PTY backend is unavailable
 * with cause posix_spawnp failed.
 *
 * Also drop a cross-platform build/Release that cannot load on this host
 * (e.g. Linux ELF left on macOS) so the loader does not trip over it first.
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform, arch } from "node:os";

const root = join(process.cwd(), "node_modules", "node-pty");
const prebuilds = join(root, "prebuilds");
const buildRelease = join(root, "build", "Release", "pty.node");

const isExecutable = (mode: number): boolean => (mode & 0o111) !== 0;

const walkSpawnHelpers = (dir: string, out: string[]): void => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkSpawnHelpers(path, out);
    else if (name === "spawn-helper") out.push(path);
  }
};

const helpers: string[] = [];
walkSpawnHelpers(prebuilds, helpers);
// Built-from-source helper when present (packaging / electron-rebuild).
const builtHelper = join(root, "build", "Release", "spawn-helper");
if (existsSync(builtHelper)) helpers.push(builtHelper);

let fixed = 0;
for (const helper of helpers) {
  const mode = statSync(helper).mode;
  if (!isExecutable(mode)) {
    chmodSync(helper, mode | 0o755);
    fixed += 1;
  }
}

// If build/Release/pty.node exists but is the wrong OS format, remove the
// whole build tree so node-pty falls through cleanly to host prebuilds.
if (existsSync(buildRelease)) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(buildRelease);
  } catch {
    rmSync(join(root, "build"), { recursive: true, force: true });
    console.log(
      `[ensure-node-pty-perms] removed unloadable node-pty build/ for ${platform()}-${arch()}`,
    );
  }
}

if (fixed > 0) {
  console.log(`[ensure-node-pty-perms] restored +x on ${fixed} spawn-helper(s)`);
}
