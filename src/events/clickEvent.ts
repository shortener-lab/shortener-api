import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const TOPIC_CLICKS = 'link.clicked';
export const TOPIC_CLICKS_DLQ = 'link.clicked.dlq';

const schema = z.object({
  v: z.literal(1),
  eventId: z.uuid(),
  code: z.string().regex(/^[0-9A-Za-z]{7}$/),
  occurredAt: z.iso.datetime(),
  userAgent: z.string().max(512),
});

export type ClickEvent = z.infer<typeof schema>;

export function buildClickEvent(code: string, userAgent: string | undefined, now = new Date()): ClickEvent {
  return { v: 1, eventId: randomUUID(), code, occurredAt: now.toISOString(), userAgent: (userAgent ?? '').slice(0, 512) };
}

export function parseClickEvent(raw: Buffer | string | null | undefined): ClickEvent {
  if (raw === null || raw === undefined) throw new Error('mensagem sem valor');
  return schema.parse(JSON.parse(raw.toString()));
}
