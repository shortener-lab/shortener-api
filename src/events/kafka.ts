import kafkaLib from '@confluentinc/kafka-javascript';
import type { BaseConfig } from '../config.js';

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
