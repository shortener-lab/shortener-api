import { describe, expect, it } from 'vitest';
import { connectInBackground } from '../../src/events/kafka.js';

const noSleep = async () => {};
const record = { topic: 'link.clicked', messages: [{ key: 'abcDEF1', value: '{}' }] };

// connect: 'ok' conecta, 'fail' rejeita, 'hang' fica pendente até alguém chamar disconnect().
function fakeProducer(connect: 'ok' | 'fail' | 'hang') {
  let abort: (err: Error) => void = () => {};
  const producer = {
    sent: [] as unknown[],
    disconnected: false,
    connect: () => {
      if (connect === 'ok') return Promise.resolve();
      if (connect === 'fail') return Promise.reject(new Error('broker transport failure'));
      return new Promise<void>((_resolve, reject) => {
        abort = reject;
      });
    },
    disconnect: async () => {
      producer.disconnected = true;
      abort(new Error('Connect aborted by disconnect().'));
    },
    send: async (r: unknown) => {
      producer.sent.push(r);
    },
  };
  return producer;
}

describe('connectInBackground', () => {
  it('não espera o Kafka: enquanto não conecta, send rejeita na hora', async () => {
    const bg = connectInBackground(() => fakeProducer('hang'), { sleep: noSleep });
    await expect(bg.sender.send(record)).rejects.toThrow(/não conectado/);
    await bg.close();
  });

  it('a cada falha tenta com um producer novo e, ao conectar, envia por ele', async () => {
    const made = [fakeProducer('fail'), fakeProducer('fail'), fakeProducer('ok')];
    let next = 0;
    const bg = connectInBackground(() => made[next++]!, { sleep: noSleep });
    await bg.ready;
    expect(next).toBe(3);
    await bg.sender.send(record);
    expect(made[2]!.sent).toEqual([record]);
    await bg.close();
  });

  it('close aborta a tentativa em andamento e para de tentar', async () => {
    const pending = fakeProducer('hang');
    let made = 0;
    const bg = connectInBackground(() => (made++, pending), { sleep: noSleep });
    await bg.close();
    await bg.ready;
    expect(pending.disconnected).toBe(true);
    expect(made).toBe(1);
  });

  it('close desconecta o producer conectado', async () => {
    const producer = fakeProducer('ok');
    const bg = connectInBackground(() => producer, { sleep: noSleep });
    await bg.ready;
    await bg.close();
    expect(producer.disconnected).toBe(true);
  });
});
