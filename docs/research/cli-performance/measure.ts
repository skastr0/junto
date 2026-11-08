import { Effect } from 'effect';
import { createConnection, type Socket } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const root = process.argv[2];
const mainPid = process.argv[3];
if (!root || !mainPid || !/^\d+$/.test(mainPid))
    throw new Error("Usage: bun docs/research/cli-performance/measure.ts OUTPUT_DIR MAIN_PID [CLI_PATH], run from a live Junto seat at the repo root");
await mkdir(root, { recursive: true });
const cli = process.argv[4] ?? `${homedir()}/.local/bin/junto`;
const workHome = process.env.JUNTO_WORK_HOME ?? `${homedir()}/.junto/work`;
const token = (await readFile(`${workHome}/token`, 'utf8')).trim();
const groups: unknown[] = [];
const timed = async (fn: () => Promise<Record<string, unknown>>) => { const started = performance.now(); return { ...await fn(), ms: performance.now() - started }; };
const runCli = (args: string[], source = false) => timed(async () => {
    const p = Bun.spawn(source ? ['bun', 'src/cli/main.ts', ...args] : [cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const ok = args[0] === 'ping' ? exit === 0 && JSON.parse(stdout).ok === true : exit === 0;
    return { ok, exit_code: exit };
});
const open = (): Promise<Socket> => new Promise((resolve, reject) => {
    const s = createConnection({ path: `${workHome}/control.sock` });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
});
const call = (s: Socket, op = 'ping', args?: unknown) => timed(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    let b = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('request timeout')), 30000);
    const cleanup = () => { clearTimeout(timer); s.off('data', data); s.off('error', error); s.off('close', close); };
    const finish = (e?: Error, value?: Record<string, unknown>) => { cleanup(); e ? reject(e) : resolve(value!); };
    const error = (e: Error) => finish(e);
    const close = () => finish(new Error('socket closed'));
    const data = (c: Buffer) => { b = Buffer.concat([b, c]); if (b.length > 8 * 1024 * 1024) {
        finish(new Error('oversized response'));
        return;
    } const nl = b.indexOf(10); if (nl < 0)
        return; try {
        const r = JSON.parse(b.subarray(0, nl).toString());
        finish(undefined, { ok: r.ok === true, response_bytes: b.length, error_type: r.error?.type ?? null });
    }
    catch (e) {
        finish(e as Error);
    } };
    s.on('data', data);
    s.once('error', error);
    s.once('close', close);
    s.write(JSON.stringify({ token, op, ...(args === undefined ? {} : { args }) }) + '\n');
}));
const fresh = (op = 'ping') => timed(async () => { const s = await open(); try {
    return await call(s, op);
}
finally {
    s.destroy();
} });
const summarize = (label: string, rows: Record<string, unknown>[], wall: number) => {
    const ts = rows.map(r => r.ms as number).sort((a, b) => a - b);
    const n = ts.length;
    const o = { label, n, wall_ms: wall, min_ms: ts[0], median_ms: (ts[Math.floor((n - 1) / 2)] + ts[Math.floor(n / 2)]) / 2, p95_ms: ts[Math.ceil(n * .95) - 1], max_ms: ts[n - 1], success_count: rows.filter(r => r.ok).length, rows };
    groups.push(o);
    const { rows: _, ...summary } = o;
    console.log(JSON.stringify(summary));
};
const group = (label: string, n: number, concurrency: number, fn: () => Promise<Record<string, unknown>>) => Effect.gen(function* () {
    const t = performance.now();
    const rows = yield* Effect.forEach(Array.from({ length: n }, (_, i) => i), i => Effect.tryPromise({ try: async () => ({ ...await fn(), index: i, completed_ms: performance.now() - t }), catch: e => e }), { concurrency });
    summarize(label, rows, performance.now() - t);
});
const program = Effect.gen(function* () {
    yield* group('ts_packaged_version_serial', 6, 1, () => runCli(['--version']));
    yield* group('ts_source_version_serial', 4, 1, () => runCli(['--version'], true));
    yield* group('ts_packaged_ping_serial', 6, 1, () => runCli(['ping']));
    yield* group('ts_direct_fresh_ping_serial', 6, 1, () => fresh());
    const s = yield* Effect.promise(open);
    try {
        yield* group('ts_direct_persistent_ping_serial', 6, 1, () => call(s));
    }
    finally {
        s.destroy();
    }
    yield* group('ts_direct_fresh_capabilities_serial', 4, 1, () => fresh('capabilities'));
    const idle = Bun.spawn(['/usr/bin/sample', mainPid, '3', '2', '-file', `${root}/ts.main.idle.sample.txt`], { stdout: 'ignore', stderr: 'ignore' });
    yield* Effect.promise(() => idle.exited);
    for (const [label, fn] of [['ts_packaged_ping_burst_24', () => runCli(['ping'])], ['ts_direct_fresh_ping_burst_24', () => fresh()]] as const) {
        const p = Bun.spawn(['/usr/bin/sample', mainPid, '4', '2', '-file', `${root}/${label}.sample.txt`], { stdout: 'ignore', stderr: 'ignore' });
        yield* Effect.sleep('200 millis');
        yield* group(label, 24, 24, fn);
        yield* Effect.promise(() => p.exited);
    }
    yield* group('ts_packaged_ping_serial_after', 4, 1, () => runCli(['ping']));
});
await Effect.runPromise(program);
await writeFile(`${root}/ts.measurements.json`, JSON.stringify({ captured_at: new Date().toISOString(), harness: 'TypeScript, Bun, Effect v4', platform: process.platform, arch: process.arch, cli_sha256: createHash('sha256').update(await readFile(cli)).digest('hex'), groups }, null, 2) + '\n');
