/** Per-seat headless terminal memory: fill xterm grids to their scrollback cap and measure RSS delta. */
import { Terminal } from "@xterm/headless";

const write = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const mem = (): { rss: number; heap: number } => {
  (globalThis as any).Bun?.gc?.(true);
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed };
};
const stream = (cols: number, lines: number): string => {
  const body = "x".repeat(Math.max(10, cols - 8));
  let out = "";
  for (let i = 0; i < lines; i += 1) out += `\u001b[38;5;${String(32 + (i % 180))}m${String(i).padStart(6, "0")} ${body}\u001b[39m\r\n`;
  return out;
};
const measure = async (cols: number, rows: number, scrollback: number, count: number): Promise<void> => {
  const terms: Terminal[] = [];
  const before = mem();
  const data = stream(cols, scrollback + rows + 20);
  for (let i = 0; i < count; i += 1) {
    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
    for (let at = 0; at < data.length; at += 16_000) await write(term, data.slice(at, at + 16_000));
    terms.push(term);
  }
  const after = mem();
  const rssPer = (after.rss - before.rss) / count / 1048576;
  const heapPer = (after.heap - before.heap) / count / 1048576;
  console.log(`${cols}x${rows} scrollback=${scrollback} count=${count} rss_per_seat_mb=${rssPer} heap_per_seat_mb=${heapPer}`);
  for (const term of terms) term.dispose();
};
await measure(120, 32, 200, 2);
await measure(120, 32, 2_000, 20);
await measure(200, 50, 2_000, 20);
await measure(200, 50, 50_000, 4);
