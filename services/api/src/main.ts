import { parseConfig } from '@zentwine/config';
import { buildApp } from './app.js';
async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const app = buildApp();
  await app.listen({ host: config.host, port: config.port });
  console.log(JSON.stringify({ level: 'info', event: 'api.started', host: config.host, port: config.port, mode: 'development-bootstrap' }));
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 5000).unref();
    app.close().then(() => { clearTimeout(timer); process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
main().catch(() => { console.error('API could not start. Check configuration and port availability.'); process.exitCode = 1; });
