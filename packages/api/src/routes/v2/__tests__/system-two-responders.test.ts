import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { scopeEnforcerMiddleware } from '../../../middleware/scope-enforcer';
import type { AppVariables } from '../../../types';
import { systemRoutes } from '../system';

// The 200 path reads real rows: two-responders-postgres.test.ts.
test('a key without system:read cannot read the two-responder diagnosis', async () => {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', {
      id: 'two-responders-test',
      name: 'two-responders',
      scopes: ['instances:read', 'events:read'],
      instanceIds: null,
      expiresAt: null,
      profile: null,
      chatAllowlist: [],
      instanceAllowlist: [],
      outboundRecipientAllowlist: [],
    });
    await next();
  });
  app.use('*', scopeEnforcerMiddleware);
  app.route('/api/v2/system', systemRoutes);
  const response = await app.request('/api/v2/system/two-responders');
  expect(response.status).toBe(403);
});
