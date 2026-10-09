import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { exercise, ownedRoot } = require('../scripts/machine-install-exercise-remote.cjs');

describe('machine exercise ownership', () => {
  it('refuses foreign markers and symlink roots before removal', () => {
    const root = mkdtempSync(join(homedir(), '.junto-install-exercise-'));
    const link = root + '-link';
    try {
      writeFileSync(join(root, 'exercise-owner'), 'owner');
      expect(() => exercise('remove', { root, owner: 'foreign' })).toThrow();
      expect(existsSync(root)).toBe(true);
      symlinkSync(root, link);
      expect(() => ownedRoot({ root: link, owner: 'owner' })).toThrow();
      expect(exercise('remove', { root, owner: 'owner' })).toEqual({ removed: true });
    } finally { rmSync(link, { force: true }); rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses a symlink ownership marker', () => {
    const root = mkdtempSync(join(homedir(), '.junto-install-exercise-'));
    try {
      writeFileSync(join(root, 'actual'), 'owner');
      symlinkSync(join(root, 'actual'), join(root, 'exercise-owner'));
      expect(() => ownedRoot({ root, owner: 'owner' })).toThrow();
    } finally { rmSync(root, { recursive: true }); }
  });
  it('drains only its spawned child during shutdown', () => {
    const helper = new URL('../scripts/machine-exercise-process.mjs', import.meta.url).href;
    const result = spawnSync('node', ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { track, stop } from ${JSON.stringify(helper)};
      const owned = track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
      console.log(JSON.stringify(await stop(owned)));
    `], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ code: null, signal: 'SIGTERM', forced: false });
  });
});
