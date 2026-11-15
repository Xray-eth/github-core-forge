import { createApp } from './app.ts';

const environment = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
if (!environment) {
  process.stderr.write('MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const timeoutMs = 30_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environment}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`registration rejected with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('registration rejected')) throw error;
    }
    await wait(backoff(attempt));
  }
}

async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environment}/done`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok && (await response.json() as { done?: unknown }).done === true) return;
    } catch {
      // Retry while the environment is unavailable or has not finished.
    }
    await wait(backoff(attempt));
  }
}

async function runTrial(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not determine the listening port');

  await register(address.port);
  await awaitCompletion();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

try {
  await runTrial();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
