import { setTimeout as delay } from 'node:timers/promises';
import { parseClickEvent, TOPIC_CLICKS_DLQ, type ClickEvent } from '../events/clickEvent.js';
import type { MessageSender } from '../events/kafka.js';
import type { ProcessResult } from '../analytics/processClick.js';
import { logger } from '../logger.js';

export type HandleResult = ProcessResult | 'dead-lettered';

interface Deps {
  process: (event: ClickEvent) => Promise<ProcessResult>;
  dlq: MessageSender;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

interface IncomingMessage {
  key?: Buffer | null;
  value: Buffer | null;
}

export async function handleMessage(deps: Deps, message: IncomingMessage): Promise<HandleResult> {
  let event: ClickEvent;
  try {
    event = parseClickEvent(message.value);
  } catch (err) {
    await sendToDlq(deps.dlq, message, err); // mensagem malformada nunca vai funcionar: não adianta tentar de novo
    return 'dead-lettered';
  }

  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? delay;
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.process(event);
    } catch (err) {
      if (attempt >= maxAttempts) {
        await sendToDlq(deps.dlq, message, err);
        return 'dead-lettered';
      }
      logger.warn({ err, attempt, eventId: event.eventId }, 'falha ao processar; tentando de novo');
      await sleep(200 * 2 ** (attempt - 1)); // 200ms, 400ms...
    }
  }
}

async function sendToDlq(dlq: MessageSender, message: IncomingMessage, err: unknown): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error({ reason }, 'enviando mensagem para a DLQ');
  await dlq.send({
    topic: TOPIC_CLICKS_DLQ,
    messages: [{ key: message.key?.toString() ?? null, value: message.value?.toString() ?? '', headers: { error: reason } }],
  });
}
