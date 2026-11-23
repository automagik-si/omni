import { describe, expect, it } from 'bun:test';
import { extractAgentOptions } from '../agent-options';

/** Every test that expects buttons opts in, mirroring a canSendButtons channel. */
const supported = { buttonsSupported: true };

describe('extractAgentOptions', () => {
  it('turns two options into inline buttons and removes the block', () => {
    const parsed = extractAgentOptions(
      'Certo! Qual é o nível do curso?\n\n[[opções: Graduação | Pós-graduação]]',
      supported,
    );

    expect(parsed.buttons).toEqual([{ text: 'Graduação' }, { text: 'Pós-graduação' }]);
    expect(parsed.list).toBeUndefined();
    expect(parsed.text).toBe('Certo! Qual é o nível do curso?');
  });

  it('keeps three options inline (the provider renders reply buttons)', () => {
    const parsed = extractAgentOptions('Escolha: [[opções: Presencial | EAD | Semipresencial]]', supported);

    expect(parsed.buttons?.map((button) => button.text)).toEqual(['Presencial', 'EAD', 'Semipresencial']);
    expect(parsed.list).toBeUndefined();
    expect(parsed.text).toBe('Escolha:');
  });

  it('asks for a list when there are 4 to 10 options', () => {
    const parsed = extractAgentOptions('Qual delas? [[opções: A | B | C | D | E]]', supported);

    expect(parsed.buttons).toHaveLength(5);
    expect(parsed.list).toEqual({ forceList: true });
  });

  it('caps a list at 10 rows and keeps the overflow in the text', () => {
    const options = Array.from({ length: 12 }, (_, index) => `Opção ${index + 1}`);
    const parsed = extractAgentOptions(`Qual delas? [[opções: ${options.join(' | ')}]]`, supported);

    expect(parsed.buttons).toHaveLength(10);
    expect(parsed.list).toEqual({ forceList: true });
    expect(parsed.text).toContain('Qual delas?');
    // Nothing is lost: items 11 and 12 move to the body as lines.
    expect(parsed.text).toContain('• Opção 11');
    expect(parsed.text).toContain('• Opção 12');
    expect(parsed.text).not.toContain('Opção 1 |');
  });

  it('leaves a malformed block untouched', () => {
    const unterminated = 'Qual é o nível? [[opções: Graduação | Pós-graduação';
    const single = 'Qual é o nível? [[opções: Graduação | ]]';

    expect(extractAgentOptions(unterminated, supported)).toEqual({ text: unterminated });
    expect(extractAgentOptions(single, supported)).toEqual({ text: single });
  });

  it('returns the text exactly as received when there is no block', () => {
    const text = 'Certo! Para falar do semipresencial, qual é o nível do curso?';

    expect(extractAgentOptions(text, supported)).toEqual({ text });
  });

  it('does nothing on a channel without canSendButtons', () => {
    const text = 'Escolha: [[opções: A | B]]';

    expect(extractAgentOptions(text)).toEqual({ text });
    expect(extractAgentOptions(text, { buttonsSupported: false })).toEqual({ text });
  });

  it('accepts the English marker', () => {
    const parsed = extractAgentOptions('Pick one: [[options: On campus | Online]]', supported);

    expect(parsed.buttons).toEqual([{ text: 'On campus' }, { text: 'Online' }]);
    expect(parsed.text).toBe('Pick one:');
  });

  it('keeps the reply when the block is the whole message (no body left)', () => {
    const text = '[[opções: A | B]]';

    expect(extractAgentOptions(text, supported)).toEqual({ text });
  });

  it('drops bullet prefixes the model may add to the items', () => {
    const parsed = extractAgentOptions('Qual? [[opções: - A | • B | * C]]', supported);

    expect(parsed.buttons?.map((button) => button.text)).toEqual(['A', 'B', 'C']);
  });
});
