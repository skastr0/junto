import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = process.argv[2];
if (!root)
    throw new Error("Usage: bun docs/research/cli-performance/analyze-samples.ts SAMPLE_DIR");
const groups: {
    name: string;
    re: RegExp;
}[] = [{ name: 'synchronous_spawn', re: /node::SyncProcessRunner::Spawn\(/ }, { name: 'filesystem_symbols', re: /node::fs::/ }, { name: 'synchronous_sqlite', re: /node::sqlite::StatementSync::/ }];
const outputs = [];
for (const file of (await readdir(root)).filter(n => n.endsWith('.sample.txt'))) {
    const body = await readFile(`${root}/${file}`, 'utf8');
    const lines = body.split('\n');
    const i = lines.findIndex(l => /Thread_.*(?:com.apple.main-thread|CrBrowserMain)/.test(l));
    if (i < 0)
        throw Error('no main thread');
    const total = Number(lines[i].trim().split(' ')[0]);
    let end = i + 1;
    while (end < lines.length && !/^\s*\d+ Thread_/.test(lines[end]) && !/^Total number in stack/.test(lines[end]))
        end++;
    const main = lines.slice(i + 1, end);
    const categories: Record<string, unknown> = {};
    for (const g of groups) {
        let activeDepth: number | undefined;
        let sum = 0;
        const frames = [];
        for (const l of main) {
            const m = /^([\s+!:|]*)(\d+)\s+(.*)$/.exec(l);
            if (!m)
                continue;
            const depth = m[1].length;
            if (activeDepth !== undefined && depth <= activeDepth)
                activeDepth = undefined;
            if (activeDepth !== undefined || !g.re.test(m[3]))
                continue;
            sum += Number(m[2]);
            activeDepth = depth;
            frames.push({ samples: Number(m[2]), symbol: m[3].replace(/\s+\[0x[0-9a-f]+\]$/, '') });
        }
        categories[g.name] = { samples: sum, share_pct: sum / total * 100, frames };
    }
    const mainSymbolCounts: Record<string, number> = {};
    for (const l of main) {
        const m = /^([\s+!:|]*)(\d+)\s+(.*)$/.exec(l);
        if (!m)
            continue;
        for (const symbol of ['node::fs::ReadDir', 'node::fs::Access', 'node::fs::Stat', 'node::fs::LStat', 'node::fs::Read', 'node::fs::Open', 'node::fs::RealPath', 'node::fs::FStat']) {
            if (m[3].startsWith(symbol + '('))
                mainSymbolCounts[symbol] = (mainSymbolCounts[symbol] ?? 0) + Number(m[2]);
        }
    }
    outputs.push({ file, sha256: createHash('sha256').update(body).digest('hex'), main_thread_samples: total, categories, filesystem_symbol_counts: mainSymbolCounts });
}
await writeFile(`${root}/sample-analysis.json`, JSON.stringify(outputs, null, 2) + '\n');
console.log(JSON.stringify(outputs.map(({ file, main_thread_samples, categories, filesystem_symbol_counts }) => ({ file, main_thread_samples, categories: Object.fromEntries(Object.entries(categories).map(([k, v]: [
        string,
        any
    ]) => [k, { samples: v.samples, share_pct: v.share_pct }])), filesystem_symbol_counts })), null, 2));
