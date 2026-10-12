import { describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../../src/worker/handleMessage.js';
import { buildClickEvent } from '../../src/events/clickEvent.js';
import type { OutgoingMessage } from '../../src/events/kafka.js';

const noSleep = async () => {};
const validMessage = () => ({
  key: Buffer.from('abcDEF1'),
  value: Buffer.from(JSON.stringify(buildClickEvent('abcDEF1', 'curl/8.7.1'))),
});
function fakeDlq() {
  const sent: { topic: string; messages: OutgoingMessage[] }[] = [];
  return { sent, send: async (r: { topic: string; messages: OutgoingMessage[] }) => { sent.push(r); } };
}

describe('handleMessage', () => {
  it('processa mensagem válida', async () => {
    const dlq = fakeDlq();
    const process = vi.fn().mockResolvedValue('processed');
    expect(await handleMessage({ process, dlq, sleep: noSleep }, validMessage())).toBe('processed');
    expect(dlq.sent).toHaveLength(0);
  });

  it('JSON inválido vai direto para a DLQ, sem tentar processar', async () => {
    const dlq = fakeDlq();
    const process = vi.fn();
    const result = await handleMessage({ process, dlq, sleep: noSleep }, { key: null, value: Buffer.from('{lixo') });
    expect(result).toBe('dead-lettered');
    expect(process).not.toHaveBeenCalled();
    expect(dlq.sent[0]?.topic).toBe('link.clicked.dlq');
  });

  it('tenta de novo em falha temporária', async () => {
    const dlq = fakeDlq();
    const process = vi.fn().mockRejectedValueOnce(new Error('db piscou')).mockResolvedValueOnce('processed');
    expect(await handleMessage({ process, dlq, sleep: noSleep }, validMessage())).toBe('processed');
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('desiste após 3 tentativas e manda para a DLQ com o motivo', async () => {
    const dlq = fakeDlq();
    const process = vi.fn().mockRejectedValue(new Error('db fora'));
    expect(await handleMessage({ process, dlq, sleep: noSleep }, validMessage())).toBe('dead-lettered');
    expect(process).toHaveBeenCalledTimes(3);
    expect(dlq.sent[0]?.messages[0]).toMatchObject({ key: 'abcDEF1', headers: { error: 'db fora' } });
  });
});
