import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const directory = fileURLToPath(new URL('.', import.meta.url));
let reader;
let available = false;
try {
  const response = await fetch('http://127.0.0.1:4491/api/dashboard?source=all', {
    signal: AbortSignal.timeout(25000),
  });
  const snapshot = await response.json();
  available = response.ok && Boolean(snapshot.stats?.usage) && snapshot.windowMode === 'strict';
} catch {
  /* Start the bundled read-only usage service when it is unavailable. */
}
if (!available) {
  reader = spawn(
    process.execPath,
    ['server.mjs', '--port', '4491', '--days', '30', '--strict-window'],
    {
      cwd: fileURLToPath(new URL('./server/', import.meta.url)),
      stdio: 'inherit',
    },
  );
}
const server = await createServer({
  root: directory,
  server: { host: '127.0.0.1', port: 4520, strictPort: true },
});
await server.listen();
server.printUrls();
async function close() {
  await server.close();
  reader?.kill('SIGTERM');
  process.exit();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
reader?.on('exit', (code) => {
  if (code) console.error('Usage reader stopped. Check whether port 4491 is already occupied.');
});
