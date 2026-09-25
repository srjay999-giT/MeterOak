import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryDirectory = path.join(root, '.test-tmp');
await mkdir(temporaryDirectory, { recursive: true });

const serverTests = (await readdir(path.join(root, 'server/test')))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => path.join('server/test', name));
const frontendTests = (await readdir(path.join(root, 'src')))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('src', name));

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--test', ...frontendTests, ...serverTests],
  {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      TMP: temporaryDirectory,
      TEMP: temporaryDirectory,
    },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
