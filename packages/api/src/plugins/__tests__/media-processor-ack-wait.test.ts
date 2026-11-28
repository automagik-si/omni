import { describe, expect, it, mock } from 'bun:test';
import { DEFAULT_MEDIA_TIMEOUTS } from '@omni/media-processing';
import { MEDIA_PROCESSOR_ACK_WAIT_MS, setupMediaProcessor } from '../media-processor';

const ATTEMPTS_PER_CALL = 4;

function createMockEventBus() {
  return {
    subscribe: mock(async () => ({ unsubscribe: mock(() => {}) })),
    subscribePattern: mock(async () => ({ unsubscribe: mock(() => {}) })),
    publish: mock(async () => {}),
    publishGeneric: mock(async () => {}),
  };
}

const services = {
  settings: {
    getSecret: mock(() => Promise.resolve(undefined)),
    getString: mock(() => Promise.resolve(undefined)),
  },
} as never;

describe('media-processor message.received consumer', () => {
  it('holds a delivery unacked for longer than the slowest image description, so it is not redelivered mid-run', async () => {
    const eventBus = createMockEventBus();

    await setupMediaProcessor(eventBus as never, {} as never, services);

    const call = eventBus.subscribe.mock.calls.find((args) => (args as unknown[])[0] === 'message.received') as
      | unknown[]
      | undefined;
    const options = call?.[2] as { durable?: string; ackWaitMs?: number } | undefined;
    expect(options?.durable).toBe('media-processor');
    expect(options?.ackWaitMs).toBe(MEDIA_PROCESSOR_ACK_WAIT_MS);

    const { imageTimeoutMs } = DEFAULT_MEDIA_TIMEOUTS;
    const geminiThenExtendedThenOpenAiMs = ATTEMPTS_PER_CALL * (imageTimeoutMs + 2 * imageTimeoutMs + imageTimeoutMs);
    expect(MEDIA_PROCESSOR_ACK_WAIT_MS).toBeGreaterThan(geminiThenExtendedThenOpenAiMs);
  });
});
