import { logger } from './logger.js';

export function onShutdown(steps: Array<() => Promise<unknown>>, timeoutMs = 25_000): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'encerrando');
    setTimeout(() => {
      logger.error('shutdown passou do tempo; forçando saída');
      process.exit(1);
    }, timeoutMs).unref();
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        logger.error({ err }, 'erro durante o shutdown');
      }
    }
    logger.info('encerrado');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
