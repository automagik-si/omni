/**
 * POST /messages/send — `flow` (a WhatsApp Flow sent with the send-text key).
 *
 * The endpoint hands the plugin the same message `POST
 * /instances/:id/whatsapp-flows/send` does — `content.type: 'flow'` plus the
 * descriptor in `metadata.flow` — with the message `text` as the body when
 * `bodyText` is missing and the caller's `flowToken` kept and echoed in the 201.
 * A flow stands alone (no buttons, list or location request) and only goes out
 * on a channel with a flow sender.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { messagesRoutes } from '../messages';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const FLOW = { flowId: '1234567890', screen: 'PROFILE', cta: 'Escolher', flowToken: 'test-flow-token' };

type SentMessage = {
  to: string;
  content: Record<string, unknown> & { type: string; text?: string };
  metadata?: Record<string, unknown> & { flow?: Record<string, unknown> };
};

function mountMessagesRoutes(channel = 'whatsapp-business', sendResult: Record<string, unknown> = {}) {
  const sendMessage = mock(async (_instanceId: string, _message: unknown) => ({
    success: true,
    messageId: 'SENT-MSG-ID',
    timestamp: 123,
    ...sendResult,
  }));

  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('services', {
      instances: {
        getById: mock(async (id: string) => ({ id, channel })),
      },
      persons: {
        getIdentityForChannel: mock(async () => null),
      },
      chats: {
        findByExternalIdSmart: mock(async () => null),
      },
    } as never);
    c.set('channelRegistry', {
      get: mock(() => ({
        capabilities: { canSendText: true },
        sendMessage,
      })),
    } as never);
    c.set('apiKey', {
      id: 'test',
      name: 'test',
      scopes: ['messages:send'],
      instanceIds: null,
      expiresAt: null,
    } as never);
    await next();
  });
  app.route('/messages', messagesRoutes);
  return { app, sendMessage };
}

async function postSend(app: Hono<{ Variables: AppVariables }>, body: Record<string, unknown>) {
  return app.request('/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: INSTANCE_ID, to: '5511999998888', text: 'Qual é o seu curso?', ...body }),
  });
}

function sentMessage(sendMessage: ReturnType<typeof mock>): SentMessage {
  const [, message] = sendMessage.mock.calls[0] as [string, SentMessage];
  return message;
}

async function errorOf(
  res: Response,
): Promise<{ code: string; message?: string; issues?: Array<{ path: unknown[] }> }> {
  return ((await res.json()) as { error: { code: string; message?: string; issues?: Array<{ path: unknown[] }> } })
    .error;
}

describe('POST /messages/send with flow', () => {
  test('sends content.type flow with metadata.flow, the body from text and the caller flowToken echoed', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const data = { levels: [{ id: 'level_a', title: 'Nível A' }] };

    const res = await postSend(app, { flow: { ...FLOW, data, flowAction: 'navigate' } });

    expect(res.status).toBe(201);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sentMessage(sendMessage);
    expect(message.content).toEqual({ type: 'flow', text: 'Qual é o seu curso?' });
    expect(message.metadata?.flow).toEqual({
      ...FLOW,
      data,
      flowAction: 'navigate',
      bodyText: 'Qual é o seu curso?',
    });
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ messageId: 'SENT-MSG-ID', status: 'sent', flowToken: FLOW.flowToken });
  });

  test('keeps an explicit bodyText as the body', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, bodyText: 'Toque para escolher' } });

    expect(res.status).toBe(201);
    const message = sentMessage(sendMessage);
    expect(message.content.text).toBe('Toque para escolher');
    expect(message.metadata?.flow?.bodyText).toBe('Toque para escolher');
  });

  test('generates a flowToken when the caller sends none, and returns it', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const { flowToken: _omitted, ...withoutToken } = FLOW;

    const res = await postSend(app, { flow: withoutToken });

    expect(res.status).toBe(201);
    const token = sentMessage(sendMessage).metadata?.flow?.flowToken;
    expect(token).toMatch(/^omni\.1234567890\.[0-9a-f-]{36}$/);
    const json = (await res.json()) as { data: { flowToken?: string } };
    expect(json.data.flowToken).toBe(token as string);
  });

  test('whatsapp-business refuses data without screen, which Meta would drop', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const { screen: _screen, ...noScreen } = FLOW;

    const res = await postSend(app, { flow: { ...noScreen, data: { levels: [] } } });

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('screen');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('whatsapp-business refuses data on a data_exchange flow, whose endpoint decides the first screen', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, flowAction: 'data_exchange', data: { levels: [] } } });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('whatsapp-business sends a flow without screen when it carries no data', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const { screen: _screen, ...noScreen } = FLOW;

    const res = await postSend(app, { flow: { ...noScreen, data: {} } });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).content.type).toBe('flow');
  });

  for (const channel of ['telegram', 'whatsapp-baileys', 'hermes']) {
    test(`a ${channel} instance answers 400 WRONG_CHANNEL and sends nothing`, async () => {
      const { app, sendMessage } = mountMessagesRoutes(channel);

      const res = await postSend(app, { flow: FLOW });

      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('WRONG_CHANNEL');
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }

  const combinations: Array<[string, Record<string, unknown>]> = [
    ['buttons', { buttons: [{ text: 'Sim', data: 'yes' }] }],
    ['list', { list: { forceList: true } }],
    ['requestLocation', { requestLocation: true }],
  ];
  for (const [field, extra] of combinations) {
    test(`refuses flow together with ${field}`, async () => {
      const { app, sendMessage } = mountMessagesRoutes();

      const res = await postSend(app, { flow: FLOW, ...extra });

      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.issues?.map((i) => i.path)).toEqual([[field]]);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }

  test('requestLocation: false and an empty buttons array do not count as combined', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: FLOW, requestLocation: false, buttons: [] });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).content.type).toBe('flow');
  });

  test('refuses a flow naming both flowId and flowName', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, flowName: 'perfil' } });

    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('refuses a flow without cta', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const { cta: _cta, ...noCta } = FLOW;

    const res = await postSend(app, { flow: noCta });

    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('refuses a text above the flow body limit when bodyText is missing, and accepts it with bodyText', async () => {
    const long = 'x'.repeat(1025);
    const refused = mountMessagesRoutes();
    const res = await postSend(refused.app, { text: long, flow: FLOW });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(refused.sendMessage).not.toHaveBeenCalled();

    const accepted = mountMessagesRoutes();
    const ok = await postSend(accepted.app, { text: long, flow: { ...FLOW, bodyText: 'Toque para escolher' } });
    expect(ok.status).toBe(201);
  });

  test('a send without flow keeps its shape: no metadata.flow, no flowToken', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, {});

    expect(res.status).toBe(201);
    const message = sentMessage(sendMessage);
    expect(message.content.type).toBe('text');
    expect(message.metadata && 'flow' in message.metadata).toBe(false);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect('flowToken' in json.data).toBe(false);
  });
});

describe('POST /messages/send with flow — the body goes through the outbound filter', () => {
  const ROUTING_HEADER = '[channel:whatsapp-business chat:5511999998888]';
  const DIRECTIVE = '⚡ REPLY NOW to the user';

  test('an explicit bodyText loses its routing header and agent directive, like text does', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, {
      flow: { ...FLOW, bodyText: `${ROUTING_HEADER} Toque para escolher\n${DIRECTIVE}` },
    });

    expect(res.status).toBe(201);
    const message = sentMessage(sendMessage);
    expect(message.content.text).toBe('Toque para escolher');
    expect(message.metadata?.flow?.bodyText).toBe('Toque para escolher');
  });

  test('a bodyText that the filter empties is refused with 400 VALIDATION_ERROR', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, bodyText: `${ROUTING_HEADER} ${DIRECTIVE}` } });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('a text that the filter empties is refused when it is the flow body (no bodyText)', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { text: DIRECTIVE, flow: FLOW });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('a text that the filter empties does not filter the send when bodyText carries the body', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { text: DIRECTIVE, flow: { ...FLOW, bodyText: 'Toque para escolher' } });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).metadata?.flow?.bodyText).toBe('Toque para escolher');
  });

  test('the body limit applies to the text as the filter leaves it', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { text: `${ROUTING_HEADER} ${'x'.repeat(1024)}`, flow: FLOW });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).metadata?.flow?.bodyText).toBe('x'.repeat(1024));
  });

  test('a send without flow whose text the filter empties still answers 200 filtered', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { text: DIRECTIVE });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('filtered');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /messages/send with flow on asc-flow', () => {
  // What the ASC platform carries: the flow id, the button label, the body,
  // header and footer, and `data` as the payload. No screen, no token.
  const ASC_FLOW = { flowId: '1234567890', cta: 'Escolher', data: { levels: [{ id: 'level_a', title: 'Nível A' }] } };

  test('takes the flow by flowId and answers 201 without a flowToken, which the platform does not carry', async () => {
    const { app, sendMessage } = mountMessagesRoutes('asc-flow');

    const res = await postSend(app, { flow: { ...ASC_FLOW, flowAction: 'navigate', draft: false } });

    expect(res.status).toBe(201);
    const message = sentMessage(sendMessage);
    expect(message.content.type).toBe('flow');
    expect(message.metadata?.flow).toMatchObject({ ...ASC_FLOW, bodyText: 'Qual é o seu curso?' });
    expect(message.metadata?.flow && 'flowToken' in message.metadata.flow).toBe(false);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ messageId: 'SENT-MSG-ID', status: 'sent' });
    expect('flowToken' in json.data).toBe(false);
  });

  const unsupported: Array<[string, Record<string, unknown>]> = [
    ['flowName', { flowId: undefined, flowName: 'perfil' }],
    ['screen', { screen: 'PROFILE' }],
    ['flowAction', { flowAction: 'data_exchange' }],
    ['draft', { draft: true }],
    ['flowToken', { flowToken: 'test-flow-token' }],
  ];
  for (const [field, extra] of unsupported) {
    test(`refuses ${field}, which the platform cannot carry, with 400 VALIDATION_ERROR`, async () => {
      const { app, sendMessage } = mountMessagesRoutes('asc-flow');

      const res = await postSend(app, { flow: { ...ASC_FLOW, ...extra } });

      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain(field);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }
});

describe('POST /messages/send with flow — the cogna-cx-agent chat kit request', () => {
  // The shape the kit sends: whatsapp-business, the body in text, and every
  // Flow field it relies on. It must keep going out exactly like this.
  const KIT_FLOW = {
    flowId: '1234567890',
    screen: 'PROFILE',
    cta: 'Escolher',
    flowToken: 'test-flow-token',
    flowAction: 'navigate',
    data: {
      levels: [{ id: 'level_a', title: 'Nível A' }],
      modalities: [{ id: 'modality_a', title: 'Modalidade A' }],
    },
  };

  test('goes out as one Flow with the body from text and answers 201 with flowToken and deliveredAs flow', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: KIT_FLOW });

    expect(res.status).toBe(201);
    const message = sentMessage(sendMessage);
    expect(message.content).toEqual({ type: 'flow', text: 'Qual é o seu curso?' });
    expect(message.metadata?.flow).toEqual({ ...KIT_FLOW, bodyText: 'Qual é o seu curso?' });
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ status: 'sent', flowToken: 'test-flow-token', deliveredAs: 'flow' });
  });
});

describe('POST /messages/send with flow — what the caller is told was delivered', () => {
  test('a Flow the channel delivered as text answers deliveredAs text', async () => {
    const { app } = mountMessagesRoutes('whatsapp-business', { degradedTo: 'text' });

    const res = await postSend(app, { flow: FLOW });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Record<string, unknown> }).data.deliveredAs).toBe('text');
  });

  test('a send without flow carries no deliveredAs', async () => {
    const { app } = mountMessagesRoutes('whatsapp-business', { degradedTo: 'text' });

    const res = await postSend(app, {});

    expect(res.status).toBe(201);
    expect('deliveredAs' in ((await res.json()) as { data: Record<string, unknown> }).data).toBe(false);
  });
});

describe('POST /messages/send with flow — options refused before the channel', () => {
  test('whatsapp-business refuses screen on a data_exchange flow even without data', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, flowAction: 'data_exchange' } });

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('screen');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('whatsapp-business sends a data_exchange flow without screen', async () => {
    const { app, sendMessage } = mountMessagesRoutes();
    const { screen: _screen, ...noScreen } = FLOW;

    const res = await postSend(app, { flow: { ...noScreen, flowAction: 'data_exchange' } });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).metadata?.flow?.flowAction).toBe('data_exchange');
  });

  for (const channel of ['whatsapp-business', 'asc-flow']) {
    test(`${channel} refuses draft: true, which only the instances:write flow route sends`, async () => {
      const { app, sendMessage } = mountMessagesRoutes(channel);

      const res = await postSend(app, { flow: { flowId: '1234567890', cta: 'Escolher', draft: true } });

      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain('draft');
      expect(error.message).toContain('/whatsapp-flows/send');
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }

  test('refuses an empty flowToken', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, flowToken: '' } });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /messages/send with flow — header, footer and cta go through the outbound filter', () => {
  const ROUTING_HEADER = '[channel:whatsapp-business chat:5511999998888]';
  const DIRECTIVE = '⚡ REPLY NOW to the user';

  test('strips routing headers and agent directives from headerText, footerText and cta', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, {
      flow: {
        ...FLOW,
        // Short enough for the 30-character cta limit, which applies as sent.
        cta: '[chat:42] Escolher',
        headerText: `${ROUTING_HEADER} Topo`,
        footerText: `Rodapé\n${DIRECTIVE}`,
      },
    });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).metadata?.flow).toMatchObject({
      cta: 'Escolher',
      headerText: 'Topo',
      footerText: 'Rodapé',
    });
  });

  test('drops a header or footer the filter empties', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, headerText: DIRECTIVE, footerText: ROUTING_HEADER } });

    expect(res.status).toBe(201);
    const flow = sentMessage(sendMessage).metadata?.flow ?? {};
    expect('headerText' in flow).toBe(false);
    expect('footerText' in flow).toBe(false);
  });

  test('refuses a cta the filter empties, since the button needs a label', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: { ...FLOW, cta: DIRECTIVE } });

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('cta');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /messages/send with flow — markdown follows the instance format mode', () => {
  test('a flow send hands the plugin the format mode, convert by default', async () => {
    const { app, sendMessage } = mountMessagesRoutes();

    const res = await postSend(app, { flow: FLOW });

    expect(res.status).toBe(201);
    expect(sentMessage(sendMessage).metadata?.messageFormatMode).toBe('convert');
  });
});
