// A real PTY stand-in. Run with the bundle's bin/node from a codex wrapper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.0.0-junto-exercise');
  process.exit(0);
}
const home = fs.realpathSync(process.env.JUNTO_HOME);
const root = path.dirname(home);
assert.equal(path.basename(home), 'home');
assert.ok(fs.lstatSync(path.join(root, 'exercise-owner')).isFile());
function inside(file) {
  const real = fs.realpathSync(file);
  const relative = path.relative(root, real);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return real;
}
const cli = inside(process.env.JUNTO_EXERCISE_CLI);
assert.ok(fs.statSync(inside(process.env.CODEX_HOME)).isDirectory());
assert.ok(process.env.JUNTO_WORK_TOKEN && process.stdin.isTTY);
const receipts = path.join(root, `harness-${process.pid}.jsonl`);
const log = fs.openSync(receipts, 'wx', 0o600);
let composer = [], escape = [], pasting = false;
function emit(event) {
  const line = JSON.stringify(event);
  fs.writeSync(log, line + '\n');
  process.stdout.write('\r\n' + line + '\r\n');
}
function paint(working = false) {
  process.stdout.write(`\x1b]0;${working ? '⠋ Codex' : ''}\x07\r\x1b[2K${working ? 'Working' : '› ' + Buffer.from(composer).toString('utf8')}`);
}
function close() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?2004l\x1b]0;\x07\r\n');
  fs.closeSync(log);
}
function submit() {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(composer)).trim();
  composer = [];
  if (!text) return true;
  paint(true);
  let instruction;
  try { instruction = JSON.parse(text); }
  catch { emit({ kind: 'notice', text }); return true; }
  try {
    const op = instruction.op;
    if (op === 'exit') { emit({ kind: 'exit', ok: true }); return false; }
    const args = op === 'onboard' ? ['onboard'] : op === 'mail' ? ['msg', 'list']
      : op === 'send' ? ['msg', 'send', JSON.stringify({ target: instruction.target, text: instruction.text })]
      : op === 'signal' ? ['feedback', instruction.text]
      : op === 'operator-denial' ? ['machine', 'status', '{}'] : undefined;
    assert.ok(args, 'expected onboard, send, mail, signal, operator-denial, or exit');
    const result = spawnSync(cli, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (op === 'operator-denial') {
      emit({ kind: op, ok: result.status === 1 && result.stderr.trim() === 'Owner and machine commands are unavailable from a Junto seat.', exit: result.status, response: result.stderr.trim() });
    } else emit({ kind: 'command', op, exit: result.status, response: JSON.parse(result.status === 0 ? result.stdout : result.stderr) });
  } catch (error) { emit({ kind: 'error', error: String(error) }); }
  return true;
}
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h');
emit({ kind: 'ready', receipts });
paint();
process.stdin.on('data', chunk => {
  for (const byte of chunk) {
    if (escape.length || byte === 27) {
      escape.push(byte);
      const sequence = Buffer.from(escape).toString();
      if (sequence === '\x1b[200~' || sequence === '\x1b[201~') { pasting = sequence === '\x1b[200~'; escape = []; }
      else if (!['\x1b[200~', '\x1b[201~'].some(value => value.startsWith(sequence))) escape = [];
      continue;
    }
    if (byte === 3 || byte === 4) { close(); return; }
    if ((byte === 10 || byte === 13) && !pasting) { if (!submit()) { close(); return; } }
    else if (byte === 8 || byte === 127) composer.pop();
    else if (byte >= 32 || (pasting && (byte === 10 || byte === 13))) composer.push(byte);
    if (composer.length > 65536) { composer = []; emit({ kind: 'error', error: 'instruction exceeds 64 KiB' }); }
  }
  paint();
});
process.stdin.once('end', close);
