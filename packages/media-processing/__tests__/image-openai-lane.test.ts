import { afterEach, describe, expect, it, mock } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requests: Array<Record<string, unknown>> = [];

mock.module('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          return {
            choices: [{ message: { content: 'a receipt' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          };
        },
      },
    };
  },
}));

const { resetAllCircuitBreakers } = await import('../src/circuit-breaker');
const { ImageProcessor } = await import('../src/processors');

afterEach(() => {
  requests.length = 0;
  resetAllCircuitBreakers();
});

describe('ImageProcessor OpenAI vision lane', () => {
  it('sends max_completion_tokens, not max_tokens, so reasoning vision models accept the request', async () => {
    const imagePath = join(tmpdir(), `omni-image-openai-lane-${Date.now()}.jpg`);
    await writeFile(imagePath, Buffer.from('fake-image'));

    try {
      const processor = new ImageProcessor({
        groqApiKey: undefined,
        openaiApiKey: 'test-openai-key',
        geminiApiKey: undefined,
        defaultLanguage: 'pt',
        maxFileSizeMb: 25,
        openaiVisionModel: 'gpt-5.6-luna',
      });

      const result = await processor.process(imagePath, 'image/jpeg');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('openai');
      expect(result.content).toBe('a receipt');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe('gpt-5.6-luna');
      expect(requests[0]?.max_completion_tokens).toBe(1024);
      expect(requests[0]).not.toHaveProperty('max_tokens');
    } finally {
      await rm(imagePath, { force: true });
    }
  });
});
