import { createServer } from 'vite';
import { spawn } from 'child_process';
import electronPath from 'electron';
import { buildElectron } from './build-electron.mjs';

async function startDev() {
  await buildElectron();

  const server = await createServer({
    configFile: 'vite.config.ts',
    server: {
      host: '127.0.0.1',
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  const devUrl = `http://127.0.0.1:${port}`;
  console.log(`[Vite Dev Server] Listening on ${devUrl}`);

  const electronProcess = spawn(String(electronPath), ['.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devUrl,
    },
  });

  electronProcess.on('close', () => {
    server.close();
    process.exit(0);
  });
}

startDev().catch((err) => {
  console.error(err);
  process.exit(1);
});
