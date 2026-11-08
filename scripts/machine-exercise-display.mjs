// Run through with-app-run-lock.sh using the native bundle's bin/node.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { track, stop, within } from './machine-exercise-process.mjs';

const [flag, destination, separator, ...command] = process.argv.slice(2);
assert.ok(flag === '--receipt' && path.isAbsolute(destination) && separator === '--' && command.length);
assert.equal(process.env.JUNTO_APP_RUN_LOCK_HELD, '1', 'run through scripts/with-app-run-lock.sh');
const receipt = { ok: false, command };
const root = fs.mkdtempSync('/tmp/junto-display-');
const auth = path.join(root, 'Xauthority');
fs.writeFileSync(auth, '', { mode: 0o600 });
const log = fs.openSync(path.join(root, 'xvfb.log'), 'wx', 0o600);
let displayChild, commandChild;
let interrupt;
const interrupted = new Promise((_, reject) => { interrupt = () => reject(new Error('display exercise interrupted')); });
interrupted.catch(() => {});
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);
try {
  let display;
  for (let attempt = 0; attempt < 20; attempt++) {
    const number = randomInt(200, 10000);
    display = `:${number}`;
    if (fs.existsSync(`/tmp/.X${number}-lock`) || fs.existsSync(`/tmp/.X11-unix/X${number}`)) continue;
    const authorization = spawnSync('xauth', ['-f', auth], { input: `add ${display} . ${randomBytes(16).toString('hex')}\n`, timeout: 5000, stdio: ['pipe', 'ignore', 'pipe'] });
    assert.equal(authorization.status, 0, 'xauth failed');
    displayChild = track(spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', auth, '-displayfd', '3'], { stdio: ['ignore', log, log, 'pipe'] }));
    const ready = new Promise((resolve, reject) => {
      let answer = '';
      displayChild.child.stdio[3].on('data', chunk => {
        answer += chunk.toString();
        if (answer.includes('\n')) resolve(answer === `${number}\n`);
        else if (answer.length > 16) reject(new Error('invalid display readiness'));
      });
    });
    const started = await Promise.race([within(ready, 10000, 'display readiness timed out').catch(() => false), displayChild.closed.then(() => false), interrupted]);
    if (started && displayChild.child.exitCode === null) break;
    await stop(displayChild);
    displayChild = undefined;
  }
  assert.ok(displayChild, 'could not start an authenticated owned display');
  receipt.display = display;
  commandChild = track(spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, DISPLAY: display, XAUTHORITY: auth } }));
  const result = await Promise.race([commandChild.closed, interrupted]);
  receipt.commandExit = result.code;
  receipt.ok = result.code === 0;
} catch (error) { receipt.error = String(error); }
finally {
  try { await stop(commandChild); }
  catch (error) { receipt.error = String(error); receipt.ok = false; }
  try {
    const result = await stop(displayChild);
    receipt.displayExit = result?.code;
    receipt.displayStopped = true;
  } catch (error) { receipt.error = String(error); receipt.ok = false; }
  fs.closeSync(log);
  fs.rmSync(root, { recursive: true });
  receipt.temporaryRootRemoved = !fs.existsSync(root);
  fs.writeFileSync(destination, JSON.stringify(receipt, null, 2) + '\n');
  process.removeListener('SIGTERM', interrupt);
  process.removeListener('SIGINT', interrupt);
}
process.exitCode = receipt.ok ? 0 : 1;
