import { describe, expect, it } from 'vitest';
import { createClickPublisher } from '../../src/events/clickPublisher.js';
import { buildClickEvent } from '../../src/events/clickEvent.js';

describe('clickPublisher', () => {
  it('publica no tópico de cliques com o código como chave', () => {
    const sent: unknown[] = [];
    const publisher = createClickPublisher({ send: async (r) => { sent.push(r); } });
    const e = buildClickEvent('abcDEF1', 'curl/8.7.1');
    publisher.publish(e);
    expect(sent).toEqual([{ topic: 'link.clicked', messages: [{ key: 'abcDEF1', value: JSON.stringify(e) }] }]);
  });

  it('nunca propaga erro do Kafka', async () => {
    const publisher = createClickPublisher({ send: async () => { throw new Error('broker fora'); } });
    expect(() => publisher.publish(buildClickEvent('abcDEF1', undefined))).not.toThrow();
    // Se a rejeição não fosse tratada, o vitest acusaria "unhandled rejection" aqui.
    await new Promise((r) => setTimeout(r, 10));
  });
});
