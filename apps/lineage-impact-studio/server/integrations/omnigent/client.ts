import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { OmnigentIntegrationError } from './errors';

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OmnigentAuthMode = 'obo' | 'service-principal';

export interface OmnigentAuthContext {
  oboToken?: string | null;
}

export interface OmnigentCapability {
  available: boolean;
  authMode?: OmnigentAuthMode;
  reason?: string;
}

export interface OmnigentSessionSnapshot {
  id: string;
  status: 'idle' | 'running' | 'waiting' | 'failed';
  runnerOnline: boolean | null;
  hostOnline: boolean | null;
  sandboxStage: string | null;
  error: string | null;
}

export interface OmnigentChangedFile {
  path: string;
  status: string;
}

export interface OmnigentFileDiff {
  path: string;
  before: string | null;
  after: string | null;
}

export interface CreateManagedSessionInput {
  repository: string;
  headRef: string;
  title: string;
  prompt: string;
  labels: Record<string, string>;
}

interface AuthenticatedResult<T> {
  value: T;
  authMode: OmnigentAuthMode;
}

interface ServicePrincipalTokenProvider {
  getToken(): Promise<string>;
}

const AgentListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(512),
      name: z.string().min(1).max(256),
    })
  ),
});

const SessionSchema = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(['idle', 'running', 'waiting', 'failed']),
  runner_online: z.boolean().nullable().optional(),
  host_online: z.boolean().nullable().optional(),
  sandbox_status: z
    .object({
      stage: z.string().max(128).optional(),
      status: z.string().max(128).optional(),
      error: z.string().max(1000).nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  last_task_error: z.record(z.string(), z.string()).nullable().optional(),
});

const ChangedFilesSchema = z.object({
  data: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        status: z.string().min(1).max(64),
      })
    )
    .max(10_000),
});

const FileDiffSchema = z.object({
  path: z.string().min(1).max(4096),
  before: z
    .string()
    .max(4 * 1024 * 1024)
    .nullable(),
  after: z
    .string()
    .max(4 * 1024 * 1024)
    .nullable(),
});

const ServicePrincipalTokenSchema = z.object({
  access_token: z
    .string()
    .min(20)
    .max(16 * 1024),
  expires_in: z.coerce.number().int().positive().max(86_400).optional().default(3600),
});

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MANAGED_DISPATCH_TIMEOUT_MS = 90_000;

export class OmnigentClient {
  readonly #baseUrl: string;
  readonly #agentName: string;
  readonly #fetch: FetchImplementation;
  readonly #servicePrincipal: ServicePrincipalTokenProvider | null;

  constructor(options: {
    workspaceHost: string;
    agentName?: string;
    fetchImplementation?: FetchImplementation;
    servicePrincipal?: ServicePrincipalTokenProvider | null;
  }) {
    const host = normalizedWorkspaceHost(options.workspaceHost);
    this.#baseUrl = `${host}/api/2.0/omnigent`;
    this.#agentName = validateAgentName(options.agentName ?? 'polly');
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#servicePrincipal = options.servicePrincipal ?? null;
  }

  static fromEnvironment(fetchImplementation: FetchImplementation = fetch): OmnigentClient | null {
    const workspaceHost = process.env.DATABRICKS_HOST;
    if (!workspaceHost) return null;
    const clientId = process.env.DATABRICKS_CLIENT_ID;
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
    const servicePrincipal =
      clientId && clientSecret
        ? new DatabricksServicePrincipalTokenProvider({
            workspaceHost,
            clientId,
            clientSecret,
            fetchImplementation,
          })
        : null;
    return new OmnigentClient({
      workspaceHost,
      agentName: process.env.OMNIGENT_AGENT_NAME,
      fetchImplementation,
      servicePrincipal,
    });
  }

  async probe(auth: OmnigentAuthContext): Promise<OmnigentCapability> {
    try {
      const result = await this.#json('/v1/me', { method: 'GET' }, auth);
      if (!isObject(result.value)) throw new OmnigentIntegrationError('invalid_response');
      return { available: true, authMode: result.authMode };
    } catch (error) {
      const reason = error instanceof OmnigentIntegrationError ? error.message : 'Omnigent could not be reached';
      return { available: false, reason };
    }
  }

  async createManagedSession(
    input: CreateManagedSessionInput,
    auth: OmnigentAuthContext
  ): Promise<AuthenticatedResult<OmnigentSessionSnapshot>> {
    const agent = await this.#findAgent(auth);
    const message = {
      type: 'message',
      data: {
        role: 'user',
        content: [{ type: 'input_text', text: input.prompt }],
      },
    };
    const body = {
      agent_id: agent.value,
      // A managed session has no runner at create time. Omnigent persists
      // initial items as history-only seeds in that state, so dispatch the
      // prompt through the event route after registering the session.
      initial_items: [],
      title: input.title,
      labels: input.labels,
      host_type: 'managed',
      workspace: managedRepositoryUrl(input.repository, input.headRef),
    };
    const created = await this.#json('/v1/sessions', { method: 'POST', body: JSON.stringify(body) }, auth);
    const snapshot = parseSession(created.value);
    try {
      const dispatched = await this.#json(
        `/v1/sessions/${encodeOpaqueId(snapshot.id)}/events`,
        { method: 'POST', body: JSON.stringify(message) },
        auth,
        true,
        MANAGED_DISPATCH_TIMEOUT_MS
      );
      return { value: snapshot, authMode: dispatched.authMode };
    } catch (error) {
      try {
        await this.interruptSession(snapshot.id, auth);
      } catch {
        // Best-effort cleanup; preserve the sanitized dispatch failure.
      }
      throw error;
    }
  }

  async getSession(
    sessionId: string,
    auth: OmnigentAuthContext
  ): Promise<AuthenticatedResult<OmnigentSessionSnapshot>> {
    const result = await this.#json(
      `/v1/sessions/${encodeOpaqueId(sessionId)}?include_items=false&include_liveness=true`,
      { method: 'GET' },
      auth,
      true
    );
    return { value: parseSession(result.value), authMode: result.authMode };
  }

  async interruptSession(sessionId: string, auth: OmnigentAuthContext): Promise<void> {
    await this.#json(
      `/v1/sessions/${encodeOpaqueId(sessionId)}/events`,
      { method: 'POST', body: JSON.stringify({ type: 'interrupt', data: {} }) },
      auth,
      true
    );
  }

  async listChangedFiles(
    sessionId: string,
    auth: OmnigentAuthContext
  ): Promise<AuthenticatedResult<OmnigentChangedFile[]>> {
    const result = await this.#json(
      `/v1/sessions/${encodeOpaqueId(sessionId)}/resources/environments/default/changes`,
      { method: 'GET' },
      auth,
      true
    );
    const parsed = ChangedFilesSchema.safeParse(result.value);
    if (!parsed.success) throw new OmnigentIntegrationError('invalid_response');
    return {
      value: parsed.data.data.map((file) => ({ path: file.path, status: file.status })),
      authMode: result.authMode,
    };
  }

  async getFileDiff(
    sessionId: string,
    path: string,
    auth: OmnigentAuthContext
  ): Promise<AuthenticatedResult<OmnigentFileDiff>> {
    const result = await this.#json(
      `/v1/sessions/${encodeOpaqueId(sessionId)}/resources/environments/default/diff/${encodePath(path)}`,
      { method: 'GET' },
      auth,
      true
    );
    const parsed = FileDiffSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.path !== path) throw new OmnigentIntegrationError('invalid_response');
    return { value: parsed.data, authMode: result.authMode };
  }

  async #findAgent(auth: OmnigentAuthContext): Promise<AuthenticatedResult<string>> {
    const result = await this.#json('/v1/agents?limit=1000', { method: 'GET' }, auth);
    const parsed = AgentListSchema.safeParse(result.value);
    if (!parsed.success) throw new OmnigentIntegrationError('invalid_response');
    const agent = parsed.data.data.find((candidate) => candidate.name === this.#agentName);
    if (agent === undefined) throw new OmnigentIntegrationError('invalid_configuration');
    return { value: agent.id, authMode: result.authMode };
  }

  async #json(
    path: string,
    init: RequestInit,
    auth: OmnigentAuthContext,
    fallbackOnNotFound = false,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<AuthenticatedResult<unknown>> {
    const oboToken = validOptionalToken(auth.oboToken);
    if (oboToken !== null) {
      const response = await this.#request(path, init, oboToken, timeoutMs);
      if (response.ok) return { value: await parseJson(response), authMode: 'obo' };
      if (![401, 403, ...(fallbackOnNotFound ? [404] : [])].includes(response.status)) {
        throw responseError(response.status);
      }
    }
    if (this.#servicePrincipal === null) {
      throw new OmnigentIntegrationError(oboToken === null ? 'invalid_configuration' : 'forbidden');
    }
    const serviceToken = await this.#servicePrincipal.getToken();
    const response = await this.#request(path, init, serviceToken, timeoutMs);
    if (!response.ok) throw responseError(response.status);
    return { value: await parseJson(response), authMode: 'service-principal' };
  }

  async #request(path: string, init: RequestInit, token: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
      });
    } catch {
      throw new OmnigentIntegrationError('request_failed', null, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class DatabricksServicePrincipalTokenProvider implements ServicePrincipalTokenProvider {
  readonly #tokenUrl: string;
  readonly #authorization: string;
  readonly #fetch: FetchImplementation;
  #cached: { value: string; expiresAt: number } | null = null;

  constructor(options: {
    workspaceHost: string;
    clientId: string;
    clientSecret: string;
    fetchImplementation?: FetchImplementation;
  }) {
    const clientId = boundedCredential(options.clientId);
    const clientSecret = boundedCredential(options.clientSecret);
    this.#tokenUrl = `${normalizedWorkspaceHost(options.workspaceHost)}/oidc/v1/token`;
    this.#authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached !== null && this.#cached.expiresAt > now + 60_000) return this.#cached.value;
    let response: Response;
    try {
      response = await this.#fetch(this.#tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: this.#authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
      });
    } catch {
      throw new OmnigentIntegrationError('request_failed', null, true);
    }
    if (!response.ok) throw new OmnigentIntegrationError('unauthorized', response.status);
    const parsed = ServicePrincipalTokenSchema.safeParse(await parseJson(response));
    if (!parsed.success) throw new OmnigentIntegrationError('invalid_response');
    this.#cached = {
      value: parsed.data.access_token,
      expiresAt: now + parsed.data.expires_in * 1000,
    };
    return this.#cached.value;
  }
}

function parseSession(value: unknown): OmnigentSessionSnapshot {
  const parsed = SessionSchema.safeParse(value);
  if (!parsed.success) throw new OmnigentIntegrationError('invalid_response');
  const sandbox = parsed.data.sandbox_status;
  const error = parsed.data.last_task_error;
  return {
    id: parsed.data.id,
    status: parsed.data.status,
    runnerOnline: parsed.data.runner_online ?? null,
    hostOnline: parsed.data.host_online ?? null,
    sandboxStage: sandbox?.stage ?? sandbox?.status ?? null,
    error: error?.message ?? error?.code ?? sandbox?.error ?? null,
  };
}

async function parseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_JSON_BYTES) {
    throw new OmnigentIntegrationError('invalid_response');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new OmnigentIntegrationError('invalid_response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OmnigentIntegrationError('invalid_response');
  }
}

function responseError(status: number): OmnigentIntegrationError {
  if (status === 400 || status === 422) return new OmnigentIntegrationError('invalid_request', status);
  if (status === 401) return new OmnigentIntegrationError('unauthorized', status);
  if (status === 403) return new OmnigentIntegrationError('forbidden', status);
  if (status === 404) return new OmnigentIntegrationError('not_found', status);
  if (status === 409) return new OmnigentIntegrationError('conflict', status);
  if (status === 429) return new OmnigentIntegrationError('rate_limited', status, true);
  if (status >= 500) return new OmnigentIntegrationError('unavailable', status, true);
  return new OmnigentIntegrationError('request_failed', status);
}

function normalizedWorkspaceHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  return url.origin;
}

function managedRepositoryUrl(repository: string, headRef: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !/^[A-Za-z0-9._/-]+$/u.test(headRef)) {
    throw new OmnigentIntegrationError('invalid_request');
  }
  return `https://github.com/${repository}.git#${headRef}`;
}

function validateAgentName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  return value;
}

function validOptionalToken(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.length < 20 || value.length > 16 * 1024 || hasControl(value)) return null;
  return value;
}

function boundedCredential(value: string): string {
  if (value.length === 0 || value.length > 4096 || hasControl(value)) {
    throw new OmnigentIntegrationError('invalid_configuration');
  }
  return value;
}

function encodeOpaqueId(value: string): string {
  if (value.length === 0 || value.length > 512 || hasControl(value)) {
    throw new OmnigentIntegrationError('invalid_request');
  }
  return encodeURIComponent(value);
}

function encodePath(value: string): string {
  if (value.length === 0 || value.length > 4096 || value.startsWith('/') || value.includes('\\') || hasControl(value)) {
    throw new OmnigentIntegrationError('invalid_request');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new OmnigentIntegrationError('invalid_request');
  }
  return parts.map(encodeURIComponent).join('/');
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || point === 0x7f) return true;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
