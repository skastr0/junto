import { Effect } from 'effect';
import { writeFile } from 'node:fs/promises';
const groups = [];
const output = process.argv[2];
if (!output)
    throw new Error("Usage: bun docs/research/cli-performance/startup.ts OUTPUT_JSON, run from the repo root");
const variants = [
    ['bun_empty', 'process.stdout.write("ok\\n")'],
    ['effect_leaf_import', 'const t=performance.now();await import("effect/Effect");console.log(JSON.stringify({import_ms:performance.now()-t}))'],
    ['effect_root_import', 'const t=performance.now();await import("effect");console.log(JSON.stringify({import_ms:performance.now()-t}))'],
    ['work_socket_import', 'const t=performance.now();await import("./src/cli/core/socket.ts");console.log(JSON.stringify({import_ms:performance.now()-t}))'],
    ['full_cli_import', 'const t=performance.now();await import("./src/cli/main.ts");console.log(JSON.stringify({import_ms:performance.now()-t}))']
];
for (const [label, code] of variants) {
    const rows = await Effect.runPromise(Effect.forEach(Array.from({ length: 6 }), () => Effect.promise(async () => { const t = performance.now(); const p = Bun.spawn(['bun', '-e', code], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }); const [exit, out] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); const result = out.trim().startsWith('{') ? JSON.parse(out) : {}; return { ms: performance.now() - t, exit_code: exit, ...result }; }), { concurrency: 1 }));
    const ts = rows.map(r => r.ms).sort((a, b) => a - b);
    const g = { label, n: rows.length, median_ms: (ts[2] + ts[3]) / 2, min_ms: ts[0], max_ms: ts[5], rows };
    groups.push(g);
    const { rows: _, ...summary } = g;
    console.log(JSON.stringify(summary));
}
await writeFile(output, JSON.stringify({ captured_at: new Date().toISOString(), groups }, null, 2) + '\n');
