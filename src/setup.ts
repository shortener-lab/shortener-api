import path from 'node:path';
import { loadBaseConfig } from './config.js';
import { logger } from './logger.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createKafka } from './events/kafka.js';
import { TOPIC_CLICKS, TOPIC_CLICKS_DLQ } from './events/clickEvent.js';

const config = loadBaseConfig();

const pool = createPool(config);
const applied = await runMigrations(pool, path.resolve('migrations'));
logger.info({ applied }, 'migrations ok');
await pool.end();

const admin = createKafka(config, 'shortener-setup').admin();
await admin.connect();
const existing = await admin.listTopics();
const missing = [
  { topic: TOPIC_CLICKS, numPartitions: 3 },
  { topic: TOPIC_CLICKS_DLQ, numPartitions: 1 },
].filter((t) => !existing.includes(t.topic));
if (missing.length > 0) {
  await admin.createTopics({
    topics: missing.map((t) => ({ ...t, replicationFactor: config.KAFKA_REPLICATION_FACTOR })),
  });
}
logger.info({ created: missing.map((t) => t.topic) }, 'tópicos ok');
await admin.disconnect();
