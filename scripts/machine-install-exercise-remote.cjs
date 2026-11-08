// Run only with the installed bundle's bin/node. No product database is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function ownedRoot(input) {
  const root = input.root;
  assert.equal(path.dirname(root), fs.realpathSync(os.homedir()));
  assert.ok(path.basename(root).startsWith('.junto-install-exercise-'));
  const directory = fs.lstatSync(root);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.uid, process.getuid());
  const marker = path.join(root, 'exercise-owner');
  const metadata = fs.lstatSync(marker);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.uid, process.getuid());
  assert.equal(fs.readFileSync(marker, 'utf8'), input.owner);
  return root;
}

function exercise(operation, input) {
  const root = ownedRoot(input);
  if (operation === 'remove') {
    fs.rmSync(root, { recursive: true });
    return { removed: !fs.existsSync(root) };
  }
  const home = path.join(root, 'home');
  const install = path.join(root, 'install');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JUNTO_')));
  Object.assign(env, { JUNTO_HOME: home, LC_ALL: 'C', TZ: 'UTC' });
  function run(command, args, allowed = [0], timeout = 5000) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.ok(allowed.includes(result.status), result.stderr || command + ' exited ' + result.status);
    return result;
  }
  function epoch(pid, absentAllowed = false) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const result = run('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,sess=,lstart='], absentAllowed ? [0, 1] : [0]);
    assert.equal(result.stderr.trim(), '');
    if (!result.stdout.trim()) return undefined;
    const match = result.stdout.trim().match(/^(\d+)\s+\d+\s+\S+\s+(.+)$/);
    assert.ok(match && Number(match[1]) === pid);
    return { pid, startKey: match[2] };
  }
  const cli = path.join(install, 'current/bin/junto');
  if (operation === 'observe') {
    const answer = JSON.parse(run(cli, ['machine', 'status', '{}']).stdout);
    assert.ok(answer.ok && answer.command === 'machine status');
    return { status: answer.data, epoch: epoch(answer.data.pid), selected: fs.readlinkSync(path.join(install, 'current')) };
  }
  assert.equal(operation, 'uninstall');
  const uninstall = JSON.parse(run(cli, ['machine', 'uninstall-local', JSON.stringify({ juntoHome: home, installRoot: install })], [0], 40000).stdout);
  assert.ok(uninstall.ok && uninstall.command === 'machine uninstall-local');
  const data = uninstall.data;
  assert.equal(data.disposition, 'stopped');
  assert.equal(data.definitionRemoved, true);
  assert.equal(data.serviceLabel, input.serviceLabel);
  assert.equal(data.juntoHome, home);
  assert.equal(data.installRoot, install);
  const current = epoch(input.epoch.pid, true);
  assert.ok(!current || current.startKey !== input.epoch.startKey);
  let definition;
  if (process.platform === 'darwin') {
    definition = path.join(os.homedir(), 'Library/LaunchAgents', data.serviceLabel + '.plist');
    run('/bin/launchctl', ['print', 'user/' + process.getuid() + '/' + data.serviceLabel], [113]);
  } else {
    definition = path.join(os.homedir(), '.config/systemd/user', data.serviceLabel + '.service');
    const fields = Object.fromEntries(run('/usr/bin/systemctl', ['--user', 'show', data.serviceLabel + '.service', '--property=LoadState,MainPID']).stdout.trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(fields, { LoadState: 'not-found', MainPID: '0' });
  }
  assert.equal(fs.existsSync(definition), false);
  assert.throws(() => fs.lstatSync(definition), { code: 'ENOENT' });
  return { uninstall, epochGone: true, definitionGone: true, serviceAbsent: true };
}

if (require.main === module) console.log(JSON.stringify(exercise(process.argv[2], JSON.parse(process.argv[3]))));
module.exports = { exercise, ownedRoot };
