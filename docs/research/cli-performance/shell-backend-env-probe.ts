/**
 * Run an installed Pi-family TypeScript shell backend with a synthetic token.
 * No model, daemon, REPL kernel, operator config, or Junto socket is used.
 * This qualifies the backend only, not every harness mode or extension hook.
 *
 * Run: bun docs/research/cli-performance/shell-backend-env-probe.ts PACKAGE_ROOT
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("Provide the installed Pi or Prime package root");
const root = await mkdtemp(join(tmpdir(), "junto-shell-env-"));
const modulePath = resolve(packageRoot, "dist/core/tools/bash.js");
const packageInfo = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const source = await readFile(modulePath);
const shellCommand = `
  present=false; matches=false
  if [ -n "\${JUNTO_WORK_TOKEN-}" ]; then present=true; fi
  if [ "\${JUNTO_WORK_TOKEN-}" = "junto-seat-${"A".repeat(43)}" ]; then matches=true; fi
  printf '{"token_present":%s,"synthetic_marker_matches":%s}\\n' "$present" "$matches"
`;
const script = `
  const {createLocalBashOperations} = await import(process.argv[1]);
  const chunks = [];
  const result = await createLocalBashOperations().exec(
    ${JSON.stringify(shellCommand)},
    process.cwd(), {onData: (data) => chunks.push(Buffer.from(data)), timeout: 5}
  );
  const found = JSON.parse(Buffer.concat(chunks).toString());
  console.log(JSON.stringify({success:result.exitCode === 0, token_present:found.token_present === true, synthetic_marker_matches:found.synthetic_marker_matches === true}));
`;
try {
  const child = Bun.spawn(["node", "--input-type=module", "-e", script, modulePath], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      JUNTO_WORK_TOKEN: "junto-seat-" + "A".repeat(43),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error("Installed shell backend probe failed");
  console.log(JSON.stringify({
    package: packageInfo.name,
    version: packageInfo.version,
    backend_sha256: createHash("sha256").update(source).digest("hex"),
    ...JSON.parse(stdout),
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
