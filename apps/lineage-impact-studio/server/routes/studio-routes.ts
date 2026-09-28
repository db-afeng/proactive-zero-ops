import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Application, Request, Response } from 'express';

import { serializeAssessmentViewV1 } from '../domain/assessment-view';
import { parseAssessmentReference } from '../domain/identifiers';
import { GitHubAppClient } from '../integrations/github';
import { LineageImpactRepository, type OmnigentSessionView } from '../persistence/repository';
import { bootstrapLineageImpactStore, type QueryExecutor } from '../persistence/schema';
import { Aes256GcmCipher, decodeBase64EncryptionKey } from '../security/encryption';
import { issueOAuthAttempt, OAUTH_COOKIE_OPTIONS } from '../security/oauth';
import { OboAuthorizationError, requireOboRequest } from '../security/obo';
import {
  AssessmentPermissionCheckError,
  AssessmentService,
  AssessmentUnavailableError,
} from '../services/assessment-service';
import type { UserAnalyticsExecutor } from '../services/asset-authorization';
import { VolumeRestrictedEnvelopeReader, type VolumeReader } from '../services/restricted-envelope-reader';

const OAUTH_BINDING_COOKIE = 'lineage_impact_oauth_binding';
const OAUTH_RETURN_COOKIE = 'lineage_impact_oauth_return';
const ASSET_QUERY_PATH = resolve(process.cwd(), 'config/queries/asset_access.obo.sql');
const FIX_UNAVAILABLE_REASON =
  'Fix generation is disabled because this workspace has no supported Omnigent programming interface.';

interface StudioAppKit {
  analytics: {
    asUser(request: Request): UserAnalyticsExecutor;
  };
  volume: VolumeReader;
  lakebase: QueryExecutor;
  server: {
    extend(callback: (application: Application) => void): void;
  };
}

interface OAuthRuntime {
  client: GitHubAppClient;
}

export async function setupStudioRoutes(appkit: StudioAppKit): Promise<void> {
  await bootstrapLineageImpactStore(appkit.lakebase);

  const encryptionKey = decodeBase64EncryptionKey(requiredEnvironment('LINEAGE_IMPACT_ENCRYPTION_KEY'));
  const repository = new LineageImpactRepository(appkit.lakebase, new Aes256GcmCipher(encryptionKey));
  encryptionKey.fill(0);

  const assessmentService = new AssessmentService({
    reader: new VolumeRestrictedEnvelopeReader(appkit.volume),
    assetAccessQuery: await readFile(ASSET_QUERY_PATH, 'utf8'),
  });
  const oauth = optionalOAuthRuntime();

  appkit.server.extend((application) => {
    application.get('/api/capabilities', (_request, response) => {
      response.json({ omnigent: { available: false, reason: FIX_UNAVAILABLE_REASON } });
    });

    application.get('/api/assessments/:reference', async (request, response) => {
      response.set('Cache-Control', 'private, no-store');
      try {
        const view = await assessmentService.getView({
          request,
          reference: request.params.reference,
          userAnalytics: appkit.analytics.asUser(request),
        });
        response.type('application/json').send(serializeAssessmentViewV1(view));
      } catch (error) {
        sendAssessmentError(response, error);
      }
    });

    application.get('/api/github/status', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const status = await repository.getGitHubConnectionStatus(viewer.subject);
        response.json(status.connected ? { connected: true, login: status.identity.login } : { connected: false });
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.get('/api/github/login', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        if (oauth === null) {
          sendUnavailable(response, 'GitHub OAuth is not configured for this deployment.');
          return;
        }
        const returnTo = safeReturnPath(request.query.returnTo);
        const binding = randomBytes(32).toString('base64url');
        const attempt = issueOAuthAttempt({ binding });
        await repository.createOAuthAttempt({ actorSubject: viewer.subject, record: attempt.record });
        response.cookie(OAUTH_BINDING_COOKIE, binding, OAUTH_COOKIE_OPTIONS);
        response.cookie(OAUTH_RETURN_COOKIE, returnTo, OAUTH_COOKIE_OPTIONS);
        response.redirect(
          302,
          oauth.client.buildAuthorizeUrl({
            state: attempt.state,
            codeChallenge: attempt.codeChallenge,
          })
        );
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.get('/api/github/oauth/callback', async (request, response) => {
      const returnTo = safeReturnPath(cookieValue(request, OAUTH_RETURN_COOKIE));
      try {
        const viewer = requireOboRequest(request);
        if (oauth === null) {
          sendUnavailable(response, 'GitHub OAuth is not configured for this deployment.');
          return;
        }
        const state = singleQueryValue(request.query.state);
        const code = singleQueryValue(request.query.code);
        const binding = cookieValue(request, OAUTH_BINDING_COOKIE);
        if (state === null || code === null || binding === null) throw new Error('invalid_oauth_callback');
        const consumed = await repository.consumeOAuthAttempt({
          actorSubject: viewer.subject,
          submittedState: state,
          binding,
        });
        const tokens = await oauth.client.exchangeCode({ code, codeVerifier: consumed.codeVerifier });
        const identity = await oauth.client.getViewer(tokens.accessToken);
        await repository.saveGitHubConnection({
          actorSubject: viewer.subject,
          identity,
          credential: tokens,
        });
        clearOAuthCookies(response);
        response.redirect(303, returnTo);
      } catch {
        clearOAuthCookies(response);
        response.redirect(303, `${returnTo}${returnTo.includes('#') ? '' : '#fix'}`);
      }
    });

    application.post('/api/github/disconnect', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        if (oauth !== null) {
          const credential = await repository.loadGitHubCredential(viewer.subject);
          if (credential !== null) {
            await oauth.client.revokeUserToken(credential.accessToken);
          }
        }
        await repository.disconnectGitHub(viewer.subject);
        response.json({ connected: false });
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.post('/api/assessments/:reference/fix-sessions', async (request, response) => {
      try {
        await reauthorizeAssessment(assessmentService, appkit, request, request.params.reference);
        sendUnavailable(response, FIX_UNAVAILABLE_REASON);
      } catch (error) {
        sendAssessmentError(response, error);
      }
    });

    application.get('/api/fix-sessions/:id', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const session = await repository.getOmnigentSession(viewer.subject, request.params.id);
        if (session === null) {
          response.status(404).json({ code: 'FIX_SESSION_NOT_FOUND', message: 'Fix session was not found.' });
          return;
        }
        response.json(toFixSession(session));
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.delete('/api/fix-sessions/:id', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const session = await repository.requestOmnigentCancellation({
          actorSubject: viewer.subject,
          sessionId: request.params.id,
        });
        response.json(toFixSession(session));
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.get('/api/fix-sessions/:id/stream', (_request, response) => {
      response.status(503).json({ code: 'OMNIGENT_UNAVAILABLE', message: FIX_UNAVAILABLE_REASON });
    });

    application.get('/api/fix-sessions/:id/patch', (_request, response) => {
      response.status(404).json({ code: 'PATCH_NOT_FOUND', message: 'Validated patch was not found.' });
    });

    application.post('/api/fix-sessions/:id/approval', (_request, response) => {
      sendUnavailable(response, FIX_UNAVAILABLE_REASON);
    });

    application.post('/api/fix-sessions/:id/commit', (_request, response) => {
      sendUnavailable(response, FIX_UNAVAILABLE_REASON);
    });

    application.get('/api/audit/:reference', async (request, response) => {
      try {
        const view = await reauthorizeAssessment(assessmentService, appkit, request, request.params.reference);
        const records = await repository.listCommitAudit(view.viewer.subject, view.reference);
        response.json({
          records: records.map((record) => ({
            id: record.intentId,
            actor: record.actorSubject,
            expectedHeadSha: record.expectedHeadSha,
            patchDigest: record.patchDigest,
            approvedAt: record.approvedAt,
            ...(record.occurredAt === null ? {} : { committedAt: record.occurredAt }),
            outcome: record.outcome,
            ...(record.commitSha === null ? {} : { commitSha: record.commitSha }),
          })),
        });
      } catch (error) {
        sendAssessmentError(response, error);
      }
    });
  });
}

async function reauthorizeAssessment(
  assessmentService: AssessmentService,
  appkit: StudioAppKit,
  request: Request,
  reference: unknown
) {
  return assessmentService.getView({
    request,
    reference,
    userAnalytics: appkit.analytics.asUser(request),
  });
}

function toFixSession(session: OmnigentSessionView) {
  return {
    id: session.id,
    status: session.status,
    ...(session.statusMessage === null ? {} : { message: session.statusMessage }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function optionalOAuthRuntime(): OAuthRuntime | null {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { client: new GitHubAppClient({ clientId, clientSecret, redirectUri }) };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment setting ${name} is not available`);
  return value;
}

function sendAssessmentError(response: Response, error: unknown): void {
  if (error instanceof AssessmentUnavailableError) {
    response.status(404).json({ code: 'ASSESSMENT_UNAVAILABLE', message: error.message });
    return;
  }
  if (error instanceof AssessmentPermissionCheckError) {
    response.status(403).json({ code: 'PERMISSION_CHECK_FAILED', message: error.message });
    return;
  }
  sendRouteError(response, error);
}

function sendRouteError(response: Response, error: unknown): void {
  if (error instanceof OboAuthorizationError) {
    response.status(401).json({ code: 'OBO_REQUIRED', message: error.message });
    return;
  }
  response.status(500).json({ code: 'REQUEST_FAILED', message: 'The request could not be completed.' });
}

function sendUnavailable(response: Response, message: string): void {
  response.status(503).json({ code: 'OMNIGENT_UNAVAILABLE', message });
}

function singleQueryValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : null;
}

function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacter(value)) {
    return '/';
  }
  try {
    const parsed = new URL(value, 'https://lineage-impact.invalid');
    if (parsed.origin !== 'https://lineage-impact.invalid') return '/';
    if (!parsed.pathname.startsWith('/assessments/')) return '/';
    const reference = parsed.pathname.slice('/assessments/'.length);
    parseAssessmentReference(reference);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function cookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function clearOAuthCookies(response: Response): void {
  response.clearCookie(OAUTH_BINDING_COOKIE, { ...OAUTH_COOKIE_OPTIONS, maxAge: undefined });
  response.clearCookie(OAUTH_RETURN_COOKIE, { ...OAUTH_COOKIE_OPTIONS, maxAge: undefined });
}
