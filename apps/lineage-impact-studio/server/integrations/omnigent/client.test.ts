import { describe, expect, it, vi } from 'vitest';

import { DatabricksServicePrincipalTokenProvider, OmnigentClient } from './client';

const HOST = 'https://workspace.example.databricks.com';
const OBO_TOKEN = `obo_${'u'.repeat(40)}`;
const SERVICE_TOKEN = `service_${'s'.repeat(40)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Omnigent authentication', () => {
  it('accepts the hostname-only DATABRICKS_HOST format injected into apps', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'me' }));
    const client = new OmnigentClient({
      workspaceHost: 'workspace.example.databricks.com',
      fetchImplementation: fetchMock,
    });

    await expect(client.probe({ oboToken: OBO_TOKEN })).resolves.toEqual({ available: true, authMode: 'obo' });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://workspace.example.databricks.com/api/2.0/omnigent/v1/me'
    );
  });

  it('uses the user OBO token when Omnigent accepts it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'me' }));
    const servicePrincipal = { getToken: vi.fn().mockResolvedValue(SERVICE_TOKEN) };
    const client = new OmnigentClient({
      workspaceHost: HOST,
      fetchImplementation: fetchMock,
      servicePrincipal,
    });

    await expect(client.probe({ oboToken: OBO_TOKEN })).resolves.toEqual({ available: true, authMode: 'obo' });
    expect(servicePrincipal.getToken).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${OBO_TOKEN}`);
  });

  it('dispatches a managed-session prompt as an event instead of a history-only initial item', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'agent-1', name: 'polly' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'session-1', status: 'idle', sandbox_status: { stage: 'provisioning' } }, 201)
      )
      .mockResolvedValueOnce(jsonResponse({ accepted: true }, 202));
    const client = new OmnigentClient({ workspaceHost: HOST, fetchImplementation: fetchMock });

    await expect(
      client.createManagedSession(
        {
          repository: 'db-afeng/proactive-zero-ops',
          headRef: 'feature/lineage-fix',
          title: 'Lineage fix',
          prompt: 'Make the narrow source change.',
          labels: { source: 'lineage-impact-studio' },
        },
        { oboToken: OBO_TOKEN }
      )
    ).resolves.toMatchObject({
      authMode: 'obo',
      value: { id: 'session-1', status: 'idle', sandboxStage: 'provisioning' },
    });

    const createBody = requestJsonBody(fetchMock.mock.calls[1]?.[1]?.body);
    expect(createBody).toMatchObject({
      agent_id: 'agent-1',
      host_type: 'managed',
      initial_items: [],
      workspace: 'https://github.com/db-afeng/proactive-zero-ops.git#feature/lineage-fix',
    });
    const eventBody = requestJsonBody(fetchMock.mock.calls[2]?.[1]?.body);
    expect(eventBody).toMatchObject({
      type: 'message',
      data: { role: 'user', content: [{ type: 'input_text', text: 'Make the narrow source change.' }] },
    });
    expect(requestUrl(fetchMock.mock.calls[2]?.[0])).toContain('/v1/sessions/session-1/events');
  });

  it.each([401, 403])('falls back to the app service principal after OBO status %s', async (status) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'denied' }, status))
      .mockResolvedValueOnce(jsonResponse({ id: 'app-service-principal' }));
    const servicePrincipal = { getToken: vi.fn().mockResolvedValue(SERVICE_TOKEN) };
    const client = new OmnigentClient({
      workspaceHost: HOST,
      fetchImplementation: fetchMock,
      servicePrincipal,
    });

    await expect(client.probe({ oboToken: OBO_TOKEN })).resolves.toEqual({
      available: true,
      authMode: 'service-principal',
    });
    expect(servicePrincipal.getToken).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${OBO_TOKEN}`);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('caches a service-principal OAuth token until its refresh window', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ access_token: SERVICE_TOKEN, expires_in: 3600 }));
    const provider = new DatabricksServicePrincipalTokenProvider({
      workspaceHost: HOST,
      clientId: 'app-client-id',
      clientSecret: 'app-client-secret',
      fetchImplementation: fetchMock,
    });

    await expect(provider.getToken()).resolves.toBe(SERVICE_TOKEN);
    await expect(provider.getToken()).resolves.toBe(SERVICE_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toMatch(/^Basic /u);
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    if (!(init?.body instanceof URLSearchParams)) throw new TypeError('expected OAuth form body');
    expect(init.body.get('grant_type')).toBe('client_credentials');
    expect(init.body.get('scope')).toBe('all-apis');
  });
});

function requestJsonBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') throw new TypeError('expected JSON body');
  return JSON.parse(body) as unknown;
}

function requestUrl(input: string | URL | Request | undefined): string {
  if (input === undefined) throw new TypeError('expected request URL');
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}
