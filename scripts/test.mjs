import { readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(new URL('../.test-build/', import.meta.url), { recursive: true, force: true });
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json']);
const tests = (await readdir(new URL('../tests/', import.meta.url)))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `tests/${name}`);
if (tests.length === 0) throw new Error('No pure-module tests found.');
run(['--test', ...tests]);
