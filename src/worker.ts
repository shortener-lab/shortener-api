import http from 'node:http';
import { loadWorkerConfig } from './config.js';
import { logger } from './logger.js';
import { createPool } from './db/pool.js';
import { createKafka } from './events/kafka.js';
import { TOPIC_CLICKS } from './events/clickEvent.js';
import { processClick } from './analytics/processClick.js';
import { handleMessage } from './worker/handleMessage.js';
import { onShutdown } from './shutdown.js';

const config = loadWorkerConfig();
const pool = createPool(config);
const kafka = createKafka(config, 'shortener-worker');
const dlqProducer = kafka.producer({ kafkaJS: { idempotent: true } });
const consumer = kafka.consumer({ kafkaJS: { groupId: 'shortener-analytics', fromBeginning: true } });

await dlqProducer.connect();
await consumer.connect();
await consumer.subscribe({ topics: [TOPIC_CLICKS] });
await consumer.run({
  eachMessage: async ({ partition, message }) => {
    const result = await handleMessage({ process: (event) => processClick(pool, event), dlq: dlqProducer }, message);
    logger.debug({ partition, offset: message.offset, result }, 'mensagem tratada');
  },
});

// Endpoint mínimo para o livenessProbe do Kubernetes.
const health = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
});
health.listen(config.WORKER_HEALTH_PORT);
logger.info('worker consumindo');

onShutdown([
  () => consumer.disconnect(), // devolve as partições ao grupo; outra réplica assume na hora
  () => dlqProducer.disconnect(),
  () => new Promise<void>((resolve) => health.close(() => resolve())),
  () => pool.end(),
]);
