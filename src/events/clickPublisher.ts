import { logger } from '../logger.js';
import { TOPIC_CLICKS, type ClickEvent } from './clickEvent.js';
import type { MessageSender } from './kafka.js';

export interface ClickPublisher {
  publish(event: ClickEvent): void;
}

// Fire-and-forget: o redirect não espera o Kafka. Se o broker cair, o cliente (librdkafka)
// segura as mensagens em memória e tenta de novo por alguns minutos; depois disso, o erro é só logado.
export function createClickPublisher(sender: MessageSender): ClickPublisher {
  return {
    publish(event) {
      sender
        .send({ topic: TOPIC_CLICKS, messages: [{ key: event.code, value: JSON.stringify(event) }] })
        .catch((err) => logger.error({ err, eventId: event.eventId }, 'falha ao publicar clique'));
    },
  };
}
