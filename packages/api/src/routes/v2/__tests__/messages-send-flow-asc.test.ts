/**
 * POST /messages/send with `flow`, through the REAL asc-flow plugin.
 *
 * The other flow route tests mock `sendMessage`, so none of them reaches a
 * channel. These run the route into `AscFlowPlugin` with every ASC platform
 * call stubbed (`stubPlatform`; nothing here may reach the real ASC) and assert
 * what the caller sees: one message for a body with paragraphs, and a 201 that
 * says the Flow went out as text when the platform refuses it.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AscFlowPlugin } from '@omni/channel-asc-flow';
import {
  MockEventBus,
  type RecordedCall,
  connectPlugin,
  createContext,
  instanceId,
  jsonResponse,
  openTurn,
  stubPlatform,
} from '@omni/channel-asc-flow/testing';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { messagesRoutes } from '../messages';

const FLOW = { flowId: '9', cta: 'Abrir' };
const BODY = 'Ola, tudo bem?\n\nToque abaixo para escolher';

let plugin: AscFlowPlugin;
let calls: RecordedCall[];
let restore: () => void;

const of = (path: string) => calls.filter((c) => c.path === path);

async function bootPlugin(overrides: Record<string, () => Response> = {}): Promise<void> {
  const stub = stubPlatform(overrides);
  calls = stub.calls;
  restore = stub.restore;
  plugin = new AscFlowPlugin();
  await plugin.initialize(createContext(new MockEventBus()));
  await connectPlugin(plugin);
  // An outbound turn is deliverable only while the flow's poll is waiting.
  await openTurn(plugin);
  calls.length = 0;
}

function mountRoute(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('services', {
      instances: { getById: mock(async (id: string) => ({ id, channel: 'asc-flow' })) },
      persons: { getIdentityForChannel: mock(async () => null) },
      chats: { findByExternalIdSmart: mock(async () => null) },
    } as never);
    c.set('channelRegistry', { get: mock(() => plugin) } as never);
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
  return app;
}

async function sendFlow(): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await mountRoute().request('/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, to: '42', text: BODY, flow: FLOW }),
  });
  return { status: res.status, data: ((await res.json()) as { data: Record<string, unknown> }).data };
}

afterEach(async () => {
  await plugin?.destroy();
  restore?.();
});

describe('POST /messages/send with flow, into the real asc-flow plugin', () => {
  test('a body with a blank line goes out as one Flow, and the 201 says deliveredAs flow', async () => {
    await bootPlugin();

    const { status, data } = await sendFlow();

    expect(status).toBe(201);
    expect(data).toMatchObject({ status: 'sent', deliveredAs: 'flow' });
    expect('flowToken' in data).toBe(false);
    expect(of('/callbackFlowMsg')).toHaveLength(0);
    expect(of('/sendMsgInterativaAvancado')).toHaveLength(1);
    expect(of('/sendMsgInterativaAvancado')[0]?.body).toMatchObject({
      msg_interativa_parametros: { tipo: '5', mensagem: BODY, fluxo: { fluxo_id: '9', texto_botao: 'Abrir' } },
    });
  });

  test('a Flow the platform refuses reaches the person as its text, and the 201 says deliveredAs text', async () => {
    await bootPlugin({ '/sendMsgInterativaAvancado': () => jsonResponse({ cod_error: 1, msg: 'nao' }, 400) });

    const { status, data } = await sendFlow();

    expect(status).toBe(201);
    expect(data).toMatchObject({ status: 'sent', deliveredAs: 'text' });
    expect(of('/callbackFlowMsg').map((c) => c.body.msg_usuario)).toEqual([BODY]);
  });
});
