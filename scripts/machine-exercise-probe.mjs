// Bounded boot/status/shutdown using the copied bundle's own runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { track, stop, within } from './machine-exercise-process.mjs';

export function ownedRoot(config) {
  assert.equal(path.dirname(config.root), fs.realpathSync(os.homedir()));
  assert.ok(path.basename(config.root).startsWith('.junto-exercise-'));
  const directory = fs.lstatSync(config.root);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid());
  const marker = path.join(config.root, 'exercise-owner');
  const metadata = fs.lstatSync(marker);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid());
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), config.owner);
  return config.root;
}
function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  let buffer = '', pending, failure;
  const lines = [];
  function fail(error) { failure = error; pending?.reject(error); pending = undefined; }
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('control socket closed')));
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { socket.destroy(new Error('control response too large')); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (pending) { pending.resolve(line); pending = undefined; } else lines.push(line);
    }
  });
  return {
    socket,
    async exchange(frame) {
      if (failure) throw failure;
      socket.write(JSON.stringify(frame) + '\n');
      const line = lines.length ? lines.shift() : await within(new Promise((resolve, reject) => { pending = { resolve, reject }; }), 3000, 'control response timed out');
      return JSON.parse(line);
    },
  };
}
export async function probe(config) {
  const root = ownedRoot(config);
  if (config.remove === true) { fs.rmSync(root, { recursive: true }); return { ok: true, removed: true }; }
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const entry = path.join(root, 'install/core/junto.cjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JUNTO_') && !['INVOCATION_ID', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH'].includes(key)));
  env.JUNTO_HOME = home;
  const result = { root, home, steps: {}, platform: process.platform, architecture: process.arch, node: process.version, entrySha256: createHash('sha256').update(fs.readFileSync(entry)).digest('hex') };
  let child, interrupt, waiting = true;
  const interrupted = new Promise((_, reject) => { interrupt = () => reject(new Error('exercise interrupted')); });
  interrupted.catch(() => {});
  process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
  const log = fs.openSync(path.join(root, 'runtime.log'), 'wx', 0o600);
  try {
    child = track(spawn(path.join(root, 'install/bin/node'), [entry], { env, stdio: ['ignore', log, log] }));
    const term = path.join(home, '.junto/term/control.sock');
    const work = path.join(home, '.junto/work/control.sock');
    await Promise.race([within((async () => {
      while (waiting && (!fs.existsSync(term) || !fs.existsSync(work))) await delay(50);
      if (!waiting) throw new Error('boot cancelled');
    })(), 20000, 'core did not expose term and work sockets'), child.closed.then(() => { throw new Error('core exited before ready'); }), interrupted]);
    result.steps.boot = { ok: true };
    const terminal = connect(term);
    let ping, seats;
    try {
      const auth = await terminal.exchange({ token: fs.readFileSync(path.join(home, '.junto/term/token'), 'utf8').trim() });
      assert.ok(auth.ok, 'term authentication failed');
      ping = await terminal.exchange({ v: 1, id: 'ping', op: 'ping' });
      seats = await terminal.exchange({ v: 1, id: 'list', op: 'list' });
    } finally { terminal.socket.destroy(); }
    assert.ok(ping.ok && ping.data?.pong === true);
    assert.ok(seats.ok); assert.deepEqual(seats.data?.sessions, []);
    const workClient = connect(work);
    let unregisteredSeat;
    try { unregisteredSeat = await workClient.exchange({ token: 'probe', op: 'ping' }); }
    finally { workClient.socket.destroy(); }
    assert.ok(!unregisteredSeat.ok && unregisteredSeat.error?.type === 'AuthError');
    result.steps.status = { ok: true, ping, seats, unregisteredSeat };
  } catch (error) { result.error = String(error); }
  finally {
    waiting = false;
    try {
      const started = performance.now();
      const stopped = await stop(child);
      result.steps.shutdown = { ok: stopped?.code === 0 && !stopped.forced, exit: stopped?.code, forced: stopped?.forced, seconds: (performance.now() - started) / 1000 };
    } catch (error) { result.error = String(error); }
    fs.closeSync(log);
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    result.ok = !result.error && ['boot', 'status', 'shutdown'].every(step => result.steps[step]?.ok);
    fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  let result;
  try { result = await probe(JSON.parse(process.argv[2])); }
  catch (error) { result = { ok: false, error: String(error) }; }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
