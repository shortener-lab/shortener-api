import { setTimeout as delay } from 'node:timers/promises';
import kafkaLib from '@confluentinc/kafka-javascript';
import type { BaseConfig } from '../config.js';
import { logger } from '../logger.js';

const { Kafka } = kafkaLib.KafkaJS;

export interface OutgoingMessage {
  key: string | null;
  value: string;
  headers?: Record<string, string>;
}

export interface MessageSender {
  send(record: { topic: string; messages: OutgoingMessage[] }): Promise<unknown>;
}

export function createKafka(cfg: Pick<BaseConfig, 'KAFKA_BROKERS' | 'KAFKA_SSL'>, clientId: string) {
  return new Kafka({ kafkaJS: { clientId, brokers: cfg.KAFKA_BROKERS, ssl: cfg.KAFKA_SSL } });
}

export interface ConnectableProducer extends MessageSender {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface BackgroundProducer {
  sender: MessageSender;
  ready: Promise<void>; // resolve ao conectar, ou ao desistir por causa do close()
  close(): Promise<void>;
}

// Conecta sem segurar quem chamou: com o Kafka fora, a api abre a porta mesmo assim e o redirect
// funciona; os cliques desse intervalo são recusados (o publisher só loga). Um producer cujo
// connect() falhou não aceita outro connect(), então cada tentativa usa um producer novo.
export function connectInBackground(
  makeProducer: () => ConnectableProducer,
  opts: { retryMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): BackgroundProducer {
  const retryMs = opts.retryMs ?? 5_000;
  const sleep = opts.sleep ?? delay;
  let connected: ConnectableProducer | null = null;
  let attempt: ConnectableProducer | null = null;
  let closed = false;

  const ready = (async () => {
    while (!closed) {
      const producer = makeProducer();
      attempt = producer;
      try {
        await producer.connect();
        connected = producer;
        logger.info('kafka: producer conectado');
        return;
      } catch (err) {
        if (closed) return;
        logger.warn({ err }, 'kafka: falha ao conectar; tentando de novo');
        await sleep(retryMs);
      } finally {
        attempt = null;
      }
    }
  })();

  return {
    sender: {
      send(record) {
        if (!connected) return Promise.reject(new Error('kafka: producer não conectado'));
        return connected.send(record);
      },
    },
    ready,
    async close() {
      closed = true;
      await (connected ?? attempt)?.disconnect(); // com o connect pendente, o disconnect o aborta
    },
  };
}
