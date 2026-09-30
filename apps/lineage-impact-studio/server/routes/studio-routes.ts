import { createHash, randomBytes } from 'node:crypto';

import type { Application, Request, Response } from 'express';
import { z } from 'zod';

import {
  serializeAssessmentViewV3,
  serializeSourceEvidenceView,
  type AssessmentViewV3,
} from '../domain/assessment-view';
import { CommitShaSchema, parseAssessmentReference } from '../domain/identifiers';
import { DatabricksFixOAuthClient, DatabricksFixOAuthError } from '../integrations/databricks/fix-oauth-client';
import { GitHubAppClient } from '../integrations/github';
import { GitHubIntegrationError } from '../integrations/github/errors';
import { OmnigentClient, OmnigentIntegrationError } from '../integrations/omnigent';
import {
  UserWorkspaceGitCredentialClient,
  WorkspaceGitCredentialClient,
} from '../integrations/omnigent/git-credential-client';
import {
  LineageImpactRepository,
  PersistenceError,
  type GitHubUserCredential,
  type OmnigentSessionView,
} from '../persistence/repository';
import { bootstrapLineageImpactStore, type QueryExecutor } from '../persistence/schema';
import { Aes256GcmCipher, decodeBase64EncryptionKey } from '../security/encryption';
import { issueOAuthAttempt, OAUTH_COOKIE_OPTIONS } from '../security/oauth';
import { OboAuthorizationError, optionalOboAccessToken, requireOboEmail, requireOboRequest } from '../security/obo';
import { PatchPolicyError, validatePatchCandidate } from '../security/patch-policy';
import {
  AssessmentService,
  AssessmentUnavailableError,
  DetailedEvidenceUnavailableError,
} from '../services/assessment-service';
import type { UserAnalyticsExecutor } from '../services/asset-authorization';
import { FixService } from '../services/fix-service';
import { GitHubCredentialService } from '../services/github-credential-service';
import { VolumeRestrictedEnvelopeReader, type VolumeReader } from '../services/restricted-envelope-reader';

const OAUTH_BINDING_COOKIE = 'lineage_impact_oauth_binding';
const OAUTH_RETURN_COOKIE = 'lineage_impact_oauth_return';
const DATABRICKS_OAUTH_BINDING_COOKIE = 'lineage_impact_databricks_oauth_binding';
const DATABRICKS_OAUTH_RETURN_COOKIE = 'lineage_impact_databricks_oauth_return';
const DATABRICKS_OAUTH_COOKIE_OPTIONS = Object.freeze({
  ...OAUTH_COOKIE_OPTIONS,
  path: '/api/databricks/oauth',
});
const FIX_UNAVAILABLE_REASON = 'Fix generation could not authenticate to Omnigent from this app runtime.';
const FIX_AUTH_REQUIRED_MESSAGE = 'Connect Databricks to authorize Omnigent as your user before starting a manual fix.';
const AUTOMATION_ACTOR_PREFIX = 'github-check:';
const AUTOMATIC_FIX_GUIDANCE =
  'Propose the smallest safe source change that resolves the failed downstream-impact check while preserving existing contracts.';

const StartFixBodySchema = z
  .object({
    guidance: z.string().trim().min(1).max(1200),
    expectedHeadSha: CommitShaSchema,
  })
  .strict();

const StartAutomaticFixBodySchema = z
  .object({
    expectedHeadSha: CommitShaSchema,
    // Optional during the two-phase rollout so the app can be deployed before
    // the trusted workflow starts sending caller-owned credentials.
    gitCredentialId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

const PatchActionBodySchema = z
  .object({
    patchDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    expectedHeadSha: CommitShaSchema,
  })
  .strict();

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
  });
  const oauth = optionalOAuthRuntime();
  const databricksFixOAuth = DatabricksFixOAuthClient.fromEnvironment();
  const omnigent = OmnigentClient.fromEnvironment();
  const workspaceGitCredentials = WorkspaceGitCredentialClient.fromEnvironment();
  const userGitCredentials = UserWorkspaceGitCredentialClient.fromEnvironment();
  const fixService =
    oauth !== null && omnigent !== null
      ? new FixService(repository, oauth.client, omnigent, workspaceGitCredentials)
      : null;
  const githubCredentials = oauth === null ? null : new GitHubCredentialService(repository, oauth.client);

  if (fixService !== null && workspaceGitCredentials !== null) {
    const clean = () => {
      void fixService.cleanupAbandonedGitCredentials().catch(() => {
        console.warn('Temporary Git credential cleanup will be retried.');
      });
    };
    clean();
    setInterval(clean, 15 * 60 * 1000).unref();
  }

  const cleanExpiredUserTokens = () => {
    void repository.deleteExpiredDatabricksFixAuthorizations().catch(() => {
      console.warn('Expired Databricks fix authorization cleanup will be retried.');
    });
  };
  cleanExpiredUserTokens();
  setInterval(cleanExpiredUserTokens, 15 * 60 * 1000).unref();

  appkit.server.extend((application) => {
    application.get('/api/capabilities', async (request, response) => {
      response.set('Cache-Control', 'private, no-store');
      let viewer;
      try {
        viewer = requireOboRequest(request);
      } catch {
        response.json({ omnigent: { available: false, reason: FIX_UNAVAILABLE_REASON } });
        return;
      }
      if (fixService === null || omnigent === null || userGitCredentials === null || databricksFixOAuth === null) {
        response.json({ omnigent: { available: false, reason: FIX_UNAVAILABLE_REASON } });
        return;
      }
      const userToken = await repository.loadActiveDatabricksFixToken(viewer.subject);
      if (userToken === null) {
        response.json({
          omnigent: { available: false, authorizationRequired: true, reason: FIX_AUTH_REQUIRED_MESSAGE },
        });
        return;
      }
      const capability = await omnigent.probe({ oboToken: userToken, allowServicePrincipalFallback: false });
      response.json({ omnigent: capability });
    });

    application.get('/api/assessments/:reference', async (request, response) => {
      const startedAt = Date.now();
      let metricStatus: SafeRequestStatus = 'failed';
      response.set('Cache-Control', 'private, no-store');
      try {
        const view = await assessmentService.getView({
          request,
          reference: request.params.reference,
          userAnalytics: appkit.analytics.asUser(request),
        });
        response.type('application/json').send(serializeAssessmentViewV3(view));
        metricStatus = 'succeeded';
      } catch (error) {
        metricStatus = assessmentMetricStatus(error);
        sendAssessmentError(response, error);
      } finally {
        recordSafeRequestMetric('assessment_view', metricStatus, startedAt);
      }
    });

    application.get('/api/assessments/:reference/source-evidence', async (request, response) => {
      const startedAt = Date.now();
      let metricStatus: SafeRequestStatus = 'failed';
      response.set('Cache-Control', 'private, no-store');
      try {
        const view = await reauthorizeAssessment(assessmentService, appkit, request, request.params.reference);
        if (view.detailState !== 'available') throw new DetailedEvidenceUnavailableError();
        const viewer = requireOboRequest(request);
        if (oauth === null || githubCredentials === null) {
          response.status(503).json({
            code: 'SOURCE_EVIDENCE_UNAVAILABLE',
            message: 'GitHub authorization is not configured for this deployment.',
          });
          metricStatus = 'unavailable';
          return;
        }
        const credential = await githubCredentials.loadActive(viewer.subject);
        if (credential === null) {
          response.status(409).json({
            code: 'GITHUB_DISCONNECTED',
            message: 'Connect GitHub to view exact source evidence.',
          });
          metricStatus = 'denied';
          return;
        }
        await oauth.client.getValidatedSourcePullRequest({
          accessToken: credential.accessToken,
          repository: view.pullRequest.repository,
          pullRequestNumber: view.pullRequest.number,
          expectedBaseSha: view.pullRequest.baseSha,
          expectedHeadSha: view.pullRequest.headSha,
        });
        const evidence = await assessmentService.getSourceEvidence({
          reference: request.params.reference,
          authorizedView: view,
        });
        response.type('application/json').send(serializeSourceEvidenceView(evidence));
        metricStatus = 'succeeded';
      } catch (error) {
        metricStatus = sourceMetricStatus(error);
        sendSourceEvidenceError(response, error);
      } finally {
        recordSafeRequestMetric('source_evidence', metricStatus, startedAt);
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
      } catch (error) {
        console.warn('[lineage-impact-studio] GitHub OAuth callback failed', {
          code: oauthCallbackFailureCode(error),
        });
        clearOAuthCookies(response);
        response.redirect(303, `${returnTo}${returnTo.includes('#') ? '' : '#fix'}`);
      }
    });

    application.post('/api/github/disconnect', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        if (oauth !== null && githubCredentials !== null) {
          const credential = await githubCredentials.loadActive(viewer.subject);
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

    application.get('/api/databricks/oauth/login', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        requireOboEmail(request);
        if (databricksFixOAuth === null) {
          sendUnavailable(response, 'Databricks authorization for manual fixes is not configured.');
          return;
        }
        const returnTo = safeReturnPath(request.query.returnTo);
        const binding = randomBytes(32).toString('base64url');
        const attempt = issueOAuthAttempt({ binding });
        await repository.createOAuthAttempt({ actorSubject: viewer.subject, record: attempt.record });
        response.cookie(DATABRICKS_OAUTH_BINDING_COOKIE, binding, DATABRICKS_OAUTH_COOKIE_OPTIONS);
        response.cookie(DATABRICKS_OAUTH_RETURN_COOKIE, returnTo, DATABRICKS_OAUTH_COOKIE_OPTIONS);
        response.redirect(
          302,
          databricksFixOAuth.buildAuthorizeUrl({
            state: attempt.state,
            codeChallenge: attempt.codeChallenge,
          })
        );
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.get('/api/databricks/oauth/callback', async (request, response) => {
      const returnTo = safeReturnPath(cookieValue(request, DATABRICKS_OAUTH_RETURN_COOKIE));
      try {
        const viewer = requireOboRequest(request);
        const email = requireOboEmail(request);
        if (databricksFixOAuth === null) throw new DatabricksFixOAuthError('invalid_configuration');
        const state = singleQueryValue(request.query.state);
        const code = singleQueryValue(request.query.code);
        const binding = cookieValue(request, DATABRICKS_OAUTH_BINDING_COOKIE);
        if (state === null || code === null || binding === null) throw new Error('invalid_oauth_callback');
        const consumed = await repository.consumeOAuthAttempt({
          actorSubject: viewer.subject,
          submittedState: state,
          binding,
        });
        const token = await databricksFixOAuth.exchangeCode({ code, codeVerifier: consumed.codeVerifier });
        await databricksFixOAuth.verifyOmnigentIdentity(token.accessToken, email);
        await repository.saveDatabricksFixAuthorization({
          actorSubject: viewer.subject,
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        });
        clearDatabricksOAuthCookies(response);
        response.redirect(303, returnTo);
      } catch (error) {
        console.warn('[lineage-impact-studio] Databricks fix OAuth callback failed', {
          code: oauthCallbackFailureCode(error),
        });
        clearDatabricksOAuthCookies(response);
        response.redirect(303, fixAuthorizationFailurePath(returnTo));
      }
    });

    application.post('/api/databricks/oauth/disconnect', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        await repository.disconnectDatabricksFixAuthorization(viewer.subject);
        response.json({ connected: false });
      } catch (error) {
        sendRouteError(response, error);
      }
    });

    application.post('/api/assessments/:reference/fix-sessions', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const body = StartFixBodySchema.parse(request.body);
        const view = await reauthorizeAssessment(assessmentService, appkit, request, request.params.reference);
        if (view.detailState !== 'available') throw new DetailedEvidenceUnavailableError();
        if (body.expectedHeadSha !== view.pullRequest.headSha) {
          response.status(409).json({
            code: 'STALE_PULL_REQUEST',
            message: 'The pull request no longer matches this assessment. Re-run the assessment.',
          });
          return;
        }
        if (
          fixService === null ||
          githubCredentials === null ||
          userGitCredentials === null ||
          databricksFixOAuth === null
        ) {
          sendUnavailable(response, FIX_UNAVAILABLE_REASON);
          return;
        }
        const credential = await githubCredentials.loadActive(viewer.subject);
        if (credential === null) {
          response.status(409).json({ code: 'GITHUB_DISCONNECTED', message: 'Connect GitHub to generate a fix.' });
          return;
        }
        const existing = await repository.getLatestOmnigentSession({
          actorSubject: viewer.subject,
          assessmentReference: view.reference,
          expectedHeadSha: view.pullRequest.headSha,
        });
        if (existing !== null && !isTerminalFixSession(existing)) {
          response.json(toFixSession(existing));
          return;
        }
        const sourceEvidence = await assessmentService.getSourceEvidence({
          reference: request.params.reference,
          authorizedView: view,
        });
        const userToken = await repository.loadActiveDatabricksFixToken(viewer.subject);
        if (userToken === null) {
          sendDatabricksFixAuthorizationRequired(response);
          return;
        }
        const gitCredentialId = await userGitCredentials.preferredGitHubCredentialId(userToken);
        const session = await fixService.start({
          actorSubject: viewer.subject,
          assessment: view,
          sourceEvidence,
          guidance: body.guidance,
          credential,
          omnigentAuth: { oboToken: userToken, allowServicePrincipalFallback: false },
          gitCredentialId,
        });
        response.status(202).json(toFixSession(session));
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.post('/api/automation/assessments/:reference/fix-sessions', async (request, response) => {
      try {
        requireOboRequest(request);
        const body = StartAutomaticFixBodySchema.parse(request.body);
        const actorSubject = automationActor(request.params.reference);
        const view = await assessmentService.getAutomationView({
          reference: request.params.reference,
          actorSubject,
        });
        if (view.detailState !== 'available') throw new DetailedEvidenceUnavailableError();
        if (!isFailedAssessmentStatus(view.status)) {
          response.status(409).json({ code: 'FIX_NOT_REQUIRED', message: 'This assessment did not fail the check.' });
          return;
        }
        if (body.expectedHeadSha !== view.pullRequest.headSha) {
          response.status(409).json({
            code: 'STALE_PULL_REQUEST',
            message: 'The pull request no longer matches this assessment. Re-run the assessment.',
          });
          return;
        }
        if (fixService === null) {
          sendUnavailable(response, FIX_UNAVAILABLE_REASON);
          return;
        }
        const existing = await repository.getLatestOmnigentSession({
          actorSubject,
          assessmentReference: view.reference,
          expectedHeadSha: body.expectedHeadSha,
        });
        if (existing !== null && existing.status !== 'failed' && existing.status !== 'cancelled') {
          response.json(toFixSession(existing));
          return;
        }
        const sourceEvidence = await assessmentService.getSourceEvidence({
          reference: request.params.reference,
          authorizedView: view,
        });
        const session = await fixService.start({
          actorSubject,
          assessment: view,
          sourceEvidence,
          guidance: AUTOMATIC_FIX_GUIDANCE,
          credential: transientGitHubCredential(request),
          omnigentAuth:
            body.gitCredentialId === undefined
              ? { oboToken: null }
              : {
                  oboToken: optionalOboAccessToken(request),
                  allowServicePrincipalFallback: false,
                },
          gitCredentialId: body.gitCredentialId,
        });
        response.status(202).json(toFixSession(session));
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.get('/api/assessments/:reference/fix-session', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const view = await reauthorizeAssessment(assessmentService, appkit, request, request.params.reference);
        const automated = await repository.getLatestOmnigentSession({
          actorSubject: automationActor(view.reference),
          assessmentReference: view.reference,
          expectedHeadSha: view.pullRequest.headSha,
        });
        const interactive = await repository.getLatestOmnigentSession({
          actorSubject: viewer.subject,
          assessmentReference: view.reference,
          expectedHeadSha: view.pullRequest.headSha,
        });
        const session = latestVisibleFixSession(automated, interactive);
        response.json({ session: session === null ? null : toFixSession(session) });
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.get('/api/automation/fix-sessions/:id', async (request, response) => {
      try {
        requireOboRequest(request);
        const owned = await repository.getOmnigentSessionById(request.params.id);
        if (owned === null || !isAutomationActor(owned.actorSubject)) {
          response.status(404).json({ code: 'FIX_SESSION_NOT_FOUND', message: 'Fix session was not found.' });
          return;
        }
        const view = await assessmentService.getAutomationView({
          reference: owned.session.assessmentReference,
          actorSubject: owned.actorSubject,
        });
        let session = owned.session;
        if (fixService !== null && !isTerminalFixSession(session)) {
          session = await fixService.synchronize({
            actorSubject: owned.actorSubject,
            session,
            assessment: view,
            credential: transientGitHubCredential(request),
            // New sessions resolve under the caller. Legacy sessions created
            // during rollout remain reachable through the app-SP fallback.
            omnigentAuth: { oboToken: optionalOboAccessToken(request) },
          });
        }
        response.json(toFixSession(session));
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.get('/api/fix-sessions/:id', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const owned = await repository.getOmnigentSessionById(request.params.id);
        if (owned === null || (!isAutomationActor(owned.actorSubject) && owned.actorSubject !== viewer.subject)) {
          response.status(404).json({ code: 'FIX_SESSION_NOT_FOUND', message: 'Fix session was not found.' });
          return;
        }
        let session = owned.session;
        const view = await reauthorizeAssessment(assessmentService, appkit, request, session.assessmentReference);
        if (
          fixService !== null &&
          githubCredentials !== null &&
          !isAutomationActor(owned.actorSubject) &&
          !isTerminalFixSession(session)
        ) {
          const credential = await githubCredentials.loadActive(viewer.subject);
          if (credential === null) {
            response.status(409).json({ code: 'GITHUB_DISCONNECTED', message: 'Reconnect GitHub to continue.' });
            return;
          }
          const manualToken =
            session.gitCredentialId === null ? await repository.loadActiveDatabricksFixToken(viewer.subject) : null;
          if (session.gitCredentialId === null && manualToken === null) {
            sendDatabricksFixAuthorizationRequired(response);
            return;
          }
          session = await fixService.synchronize({
            actorSubject: owned.actorSubject,
            session,
            assessment: view,
            credential,
            propagateAuthFailure: session.gitCredentialId === null,
            omnigentAuth:
              session.gitCredentialId === null
                ? { oboToken: manualToken, allowServicePrincipalFallback: false }
                : { oboToken: null },
          });
        }
        if (fixService !== null) await fixService.releaseSessionGitCredential(owned.actorSubject, session);
        response.json(toFixSession(session));
      } catch (error) {
        if (
          error instanceof OmnigentIntegrationError &&
          (error.code === 'unauthorized' || error.code === 'forbidden')
        ) {
          const viewer = requireOboRequest(request);
          await repository.disconnectDatabricksFixAuthorization(viewer.subject);
          sendDatabricksFixAuthorizationRequired(response);
          return;
        }
        sendFixError(response, error);
      }
    });

    application.delete('/api/fix-sessions/:id', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const session = await repository.getOmnigentSession(viewer.subject, request.params.id);
        if (session === null) {
          response.status(404).json({ code: 'FIX_SESSION_NOT_FOUND', message: 'Fix session was not found.' });
          return;
        }
        await reauthorizeAssessment(assessmentService, appkit, request, session.assessmentReference);
        const manualToken =
          session.gitCredentialId === null ? await repository.loadActiveDatabricksFixToken(viewer.subject) : null;
        if (session.gitCredentialId === null && manualToken === null) {
          sendDatabricksFixAuthorizationRequired(response);
          return;
        }
        const cancelled =
          fixService === null
            ? await repository.requestOmnigentCancellation({
                actorSubject: viewer.subject,
                sessionId: request.params.id,
              })
            : await fixService.cancel({
                actorSubject: viewer.subject,
                session,
                omnigentAuth:
                  session.gitCredentialId === null
                    ? { oboToken: manualToken, allowServicePrincipalFallback: false }
                    : { oboToken: null },
              });
        response.json(toFixSession(cancelled));
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.get('/api/fix-sessions/:id/stream', (_request, response) => {
      response.status(410).json({
        code: 'FIX_STREAM_RETIRED',
        message: 'Use the fix-session status endpoint for progress updates.',
      });
    });

    application.get('/api/fix-sessions/:id/patch', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const owned = await repository.getOmnigentSessionById(request.params.id);
        if (owned === null || (!isAutomationActor(owned.actorSubject) && owned.actorSubject !== viewer.subject)) {
          response.status(404).json({ code: 'FIX_SESSION_NOT_FOUND', message: 'Fix session was not found.' });
          return;
        }
        const session = owned.session;
        await reauthorizeAssessment(assessmentService, appkit, request, session.assessmentReference);
        if (fixService === null) {
          sendUnavailable(response, FIX_UNAVAILABLE_REASON);
          return;
        }
        const patch = await fixService.review(owned.actorSubject, session.id);
        if (patch === null) {
          response.status(404).json({ code: 'PATCH_NOT_FOUND', message: 'Validated patch was not found.' });
          return;
        }
        response.json(patch);
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.post('/api/fix-sessions/:id/approval', async (request, response) => {
      try {
        const viewer = requireOboRequest(request);
        const body = PatchActionBodySchema.parse(request.body);
        const context = await loadPatchActionContext({
          repository,
          assessmentService,
          appkit,
          request,
          sessionId: request.params.id,
          actorSubject: viewer.subject,
          body,
          github: oauth?.client ?? null,
          githubCredentials,
        });
        const approval = await repository.approvePatch({
          actorSubject: viewer.subject,
          sessionId: context.session.id,
          expectedHeadSha: body.expectedHeadSha,
          patchDigest: body.patchDigest,
        });
        response.status(approval.created ? 201 : 200).json({ approvedAt: approval.approvedAt });
      } catch (error) {
        sendFixError(response, error);
      }
    });

    application.post('/api/fix-sessions/:id/commit', async (request, response) => {
      let actorSubject: string | null = null;
      let intentId: string | null = null;
      let committedSha: string | null = null;
      try {
        const viewer = requireOboRequest(request);
        actorSubject = viewer.subject;
        const body = PatchActionBodySchema.parse(request.body);
        const context = await loadPatchActionContext({
          repository,
          assessmentService,
          appkit,
          request,
          sessionId: request.params.id,
          actorSubject: viewer.subject,
          body,
          github: oauth?.client ?? null,
          githubCredentials,
        });
        if (oauth === null) {
          sendUnavailable(response, 'GitHub OAuth is not configured for this deployment.');
          return;
        }
        const approval = await repository.getPatchApproval(
          viewer.subject,
          context.session.id,
          body.expectedHeadSha,
          body.patchDigest
        );
        if (approval === null) {
          response.status(409).json({ code: 'PATCH_NOT_APPROVED', message: 'Approve this exact patch before commit.' });
          return;
        }
        const intent = await repository.reserveCommit({
          actorSubject: viewer.subject,
          approvalId: approval.id,
          idempotencyKey: commitIdempotencyKey(context.session.id, body.patchDigest),
          assessmentReference: context.session.assessmentReference,
          repository: context.assessment.pullRequest.repository,
          pullRequestNumber: context.assessment.pullRequest.number,
          expectedHeadSha: body.expectedHeadSha,
          patchDigest: body.patchDigest,
        });
        intentId = intent.id;
        if (!intent.created) {
          const audit = (await repository.listCommitAudit(viewer.subject, context.session.assessmentReference)).find(
            (record) => record.intentId === intent.id
          );
          if (audit?.outcome === 'succeeded' && audit.commitSha !== null) {
            response.json({ outcome: 'succeeded', commitSha: audit.commitSha, message: 'Approved patch committed.' });
            return;
          }
          response.status(409).json({
            code: audit?.outcome === 'failed' ? 'COMMIT_ALREADY_FAILED' : 'COMMIT_IN_PROGRESS',
            message:
              audit?.outcome === 'failed'
                ? 'This approved commit attempt already failed and was recorded.'
                : 'This approved commit attempt is already being reconciled.',
          });
          return;
        }
        const created = await oauth.client.createCommitFromValidatedPatch({
          accessToken: context.credential.accessToken,
          pullRequestNumber: context.assessment.pullRequest.number,
          validatedPatch: context.validatedPatch,
          approvedExpectedHeadSha: body.expectedHeadSha,
          approvedPatchDigest: body.patchDigest,
          expectedFiles: context.patch.expectedFiles,
          message: `Apply lineage impact remediation for PR #${String(context.assessment.pullRequest.number)}`,
        });
        committedSha = created.commitSha;
        await repository.appendCommitAuditEvent({
          actorSubject: viewer.subject,
          intentId: intent.id,
          outcome: 'succeeded',
          commitSha: created.commitSha,
        });
        response.json({ outcome: 'succeeded', commitSha: created.commitSha, message: 'Approved patch committed.' });
      } catch (error) {
        if (actorSubject !== null && intentId !== null) {
          try {
            if (committedSha !== null) {
              await repository.appendCommitAuditEvent({
                actorSubject,
                intentId,
                outcome: 'succeeded',
                commitSha: committedSha,
              });
              response.json({ outcome: 'succeeded', commitSha: committedSha, message: 'Approved patch committed.' });
              return;
            } else {
              await repository.appendCommitAuditEvent({
                actorSubject,
                intentId,
                outcome: 'failed',
                errorCode: safeCommitErrorCode(error),
              });
            }
          } catch {
            // Preserve the original failure; audit persistence is independently observable.
          }
        }
        sendFixError(response, error);
      }
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

async function loadPatchActionContext(input: {
  repository: LineageImpactRepository;
  assessmentService: AssessmentService;
  appkit: StudioAppKit;
  request: Request;
  sessionId: string;
  actorSubject: string;
  body: z.infer<typeof PatchActionBodySchema>;
  github: GitHubAppClient | null;
  githubCredentials: GitHubCredentialService | null;
}) {
  if (input.github === null || input.githubCredentials === null) {
    throw new GitHubIntegrationError('invalid_configuration');
  }
  const session = await input.repository.getOmnigentSession(input.actorSubject, input.sessionId);
  if (session === null) throw new PersistenceError('not_found');
  if (session.status !== 'complete') throw new PersistenceError('conflict');
  const assessment = await reauthorizeAssessment(
    input.assessmentService,
    input.appkit,
    input.request,
    session.assessmentReference
  );
  if (
    input.body.expectedHeadSha !== session.expectedHeadSha ||
    input.body.expectedHeadSha !== assessment.pullRequest.headSha
  ) {
    throw new GitHubIntegrationError('head_changed');
  }
  const credential = await input.githubCredentials.loadActive(input.actorSubject);
  if (credential === null) throw new GitHubIntegrationError('unauthorized');
  const pull = await input.github.getValidatedPullRequest({
    accessToken: credential.accessToken,
    pullRequestNumber: assessment.pullRequest.number,
    expectedHeadSha: input.body.expectedHeadSha,
  });
  if (pull.repository.toLowerCase() !== assessment.pullRequest.repository.toLowerCase()) {
    throw new GitHubIntegrationError('repository_mismatch');
  }
  const patch = await input.repository.loadDecryptedValidatedPatchForSession(input.actorSubject, session.id);
  if (
    patch === null ||
    patch.expectedHeadSha !== input.body.expectedHeadSha ||
    patch.patchDigest !== input.body.patchDigest
  ) {
    throw new PersistenceError('not_found');
  }
  const validatedPatch = validatePatchCandidate({
    gate: {
      baseRepository: pull.repository,
      headRepository: pull.repository,
      isFork: false,
      pullRequestState: 'open',
      canPush: true,
      force: false,
      commitStrategy: 'normal',
      expectedHeadSha: input.body.expectedHeadSha,
      observedHeadSha: pull.headSha,
    },
    files: patch.files,
    patch: patch.bytes,
  });
  if (validatedPatch.digest !== input.body.patchDigest) throw new PatchPolicyError('Patch digest changed');
  return { session, assessment, credential, patch, validatedPatch };
}

function toFixSession(session: OmnigentSessionView) {
  const progress: Record<OmnigentSessionView['status'], number> = {
    queued: 8,
    running: 55,
    validating: 86,
    complete: 100,
    failed: 0,
    cancelled: 0,
  };
  return {
    id: session.id,
    status: session.status,
    progress: progress[session.status],
    ...(session.statusMessage === null ? {} : { message: session.statusMessage }),
    ...(session.status === 'failed' && session.statusMessage !== null ? { error: session.statusMessage } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function latestVisibleFixSession<T extends { createdAt: string }>(
  automated: T | null,
  interactive: T | null
): T | null {
  if (automated === null) return interactive;
  if (interactive === null) return automated;
  return interactive.createdAt >= automated.createdAt ? interactive : automated;
}

function isTerminalFixSession(session: OmnigentSessionView): boolean {
  return session.status === 'complete' || session.status === 'failed' || session.status === 'cancelled';
}

function commitIdempotencyKey(sessionId: string, patchDigest: string): string {
  return `fix:${sessionId}:${createHash('sha256').update(patchDigest).digest('hex').slice(0, 24)}`;
}

function automationActor(assessmentReference: string): string {
  return `${AUTOMATION_ACTOR_PREFIX}${parseAssessmentReference(assessmentReference)}`;
}

export function isFailedAssessmentStatus(status: AssessmentViewV3['status']): boolean {
  return status === 'block' || status === 'error';
}

function isAutomationActor(actorSubject: string): boolean {
  return actorSubject.startsWith(AUTOMATION_ACTOR_PREFIX);
}

function transientGitHubCredential(request: Request): GitHubUserCredential {
  const value = request.headers['x-lineage-github-token'];
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 4096 ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x20 || point === 0x7f;
    })
  ) {
    throw new GitHubIntegrationError('unauthorized');
  }
  return {
    accessToken: value,
    refreshToken: null,
    tokenType: 'bearer',
    scopes: [],
    expiresAt: null,
    refreshTokenExpiresAt: null,
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
  sendRouteError(response, error);
}

function sendSourceEvidenceError(response: Response, error: unknown): void {
  if (error instanceof DetailedEvidenceUnavailableError) {
    response.status(409).json({ code: 'DETAILED_EVIDENCE_UNAVAILABLE', message: error.message });
    return;
  }
  if (error instanceof GitHubIntegrationError) {
    if (error.code === 'pull_request_closed' || error.code === 'base_changed' || error.code === 'head_changed') {
      response.status(409).json({
        code: 'STALE_PULL_REQUEST',
        message: 'The pull request no longer matches this assessment. Re-run the assessment.',
      });
      return;
    }
    if (
      error.code === 'unauthorized' ||
      error.code === 'forbidden' ||
      error.code === 'not_found' ||
      error.code === 'read_not_permitted' ||
      error.code === 'repository_mismatch'
    ) {
      response.status(403).json({
        code: 'GITHUB_READ_REQUIRED',
        message: 'Your connected GitHub identity cannot read this assessment source.',
      });
      return;
    }
    response.status(502).json({
      code: 'GITHUB_VALIDATION_FAILED',
      message: 'GitHub source authorization could not be verified.',
    });
    return;
  }
  sendAssessmentError(response, error);
}

function sendFixError(response: Response, error: unknown): void {
  if (error instanceof z.ZodError || (error instanceof Error && error.message === 'invalid_guidance')) {
    response.status(400).json({ code: 'INVALID_FIX_REQUEST', message: 'The fix request is invalid.' });
    return;
  }
  if (error instanceof DetailedEvidenceUnavailableError) {
    response.status(409).json({ code: 'DETAILED_EVIDENCE_UNAVAILABLE', message: error.message });
    return;
  }
  if (error instanceof GitHubIntegrationError) {
    if (
      error.code === 'pull_request_closed' ||
      error.code === 'base_changed' ||
      error.code === 'head_changed' ||
      error.code === 'conflict'
    ) {
      response.status(409).json({
        code: 'STALE_PULL_REQUEST',
        message: 'The pull request no longer matches this assessment. Re-run the assessment.',
      });
      return;
    }
    if (error.code === 'invalid_configuration') {
      sendUnavailable(response, 'GitHub OAuth is not configured for this deployment.');
      return;
    }
    if (
      error.code === 'unauthorized' ||
      error.code === 'forbidden' ||
      error.code === 'not_found' ||
      error.code === 'read_not_permitted' ||
      error.code === 'write_not_permitted' ||
      error.code === 'repository_mismatch' ||
      error.code === 'fork_not_supported'
    ) {
      response.status(403).json({
        code: 'GITHUB_ACCESS_REQUIRED',
        message: 'Your connected GitHub identity cannot update this pull request.',
      });
      return;
    }
    if (error.code === 'invalid_request' || error.code === 'unsafe_change') {
      response
        .status(422)
        .json({ code: 'UNSAFE_PATCH', message: 'The proposed patch did not pass safety validation.' });
      return;
    }
    response.status(error.retryable ? 503 : 502).json({
      code: 'GITHUB_VALIDATION_FAILED',
      message: 'GitHub could not verify or commit the approved patch.',
    });
    return;
  }
  if (error instanceof OmnigentIntegrationError) {
    if (error.code === 'git_credential_missing' || error.code === 'git_credential_ambiguous') {
      response.status(409).json({ code: 'GIT_CREDENTIAL_REQUIRED', message: error.message });
      return;
    }
    if (error.code === 'git_credential_access_denied') {
      response.status(403).json({ code: 'GIT_CREDENTIAL_ACCESS_DENIED', message: error.message });
      return;
    }
    response.status(error.retryable ? 503 : 502).json({ code: 'OMNIGENT_UNAVAILABLE', message: error.message });
    return;
  }
  if (error instanceof PatchPolicyError) {
    response.status(422).json({ code: 'UNSAFE_PATCH', message: 'The proposed patch did not pass safety validation.' });
    return;
  }
  if (error instanceof PersistenceError) {
    if (error.code === 'not_found') {
      response
        .status(404)
        .json({ code: 'FIX_RESOURCE_NOT_FOUND', message: 'The requested fix resource was not found.' });
      return;
    }
    if (error.code === 'conflict' || error.code === 'idempotency_conflict') {
      response.status(409).json({ code: 'FIX_STATE_CONFLICT', message: 'The fix is no longer in the required state.' });
      return;
    }
  }
  sendAssessmentError(response, error);
}

function safeCommitErrorCode(error: unknown): string {
  if (error instanceof GitHubIntegrationError) return `github_${error.code}`;
  if (error instanceof PersistenceError) return `persistence_${error.code}`;
  if (error instanceof PatchPolicyError) return 'unsafe_patch';
  return 'unexpected';
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

function sendDatabricksFixAuthorizationRequired(response: Response): void {
  response.status(409).json({ code: 'DATABRICKS_FIX_AUTH_REQUIRED', message: FIX_AUTH_REQUIRED_MESSAGE });
}

type SafeRequestStatus = 'succeeded' | 'denied' | 'unavailable' | 'stale' | 'failed';

function assessmentMetricStatus(error: unknown): SafeRequestStatus {
  if (error instanceof OboAuthorizationError) return 'denied';
  if (error instanceof AssessmentUnavailableError) return 'unavailable';
  return 'failed';
}

function sourceMetricStatus(error: unknown): SafeRequestStatus {
  if (error instanceof DetailedEvidenceUnavailableError) return 'unavailable';
  if (error instanceof GitHubIntegrationError) {
    if (error.code === 'pull_request_closed' || error.code === 'base_changed' || error.code === 'head_changed') {
      return 'stale';
    }
    if (
      error.code === 'unauthorized' ||
      error.code === 'forbidden' ||
      error.code === 'not_found' ||
      error.code === 'read_not_permitted' ||
      error.code === 'repository_mismatch'
    ) {
      return 'denied';
    }
  }
  return assessmentMetricStatus(error);
}

/** Never add references, asset names, SQL, paths, or lineage identifiers here. */
function recordSafeRequestMetric(
  route: 'assessment_view' | 'source_evidence',
  status: SafeRequestStatus,
  startedAt: number
) {
  console.info('[lineage-impact-studio] request metric', {
    route,
    status,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });
}

export function oauthCallbackFailureCode(error: unknown): string {
  if (error instanceof OboAuthorizationError) return 'obo_required';
  if (error instanceof DatabricksFixOAuthError) return `databricks_${error.code}`;
  if (error instanceof GitHubIntegrationError) return `github_${error.code}`;
  if (error instanceof PersistenceError) return `persistence_${error.code}`;
  if (error instanceof Error && error.message === 'invalid_oauth_callback') return 'invalid_callback';
  return 'unexpected';
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

function fixAuthorizationFailurePath(returnTo: string): string {
  const url = new URL(returnTo, 'https://lineage-impact.invalid');
  url.searchParams.set('fixAuth', 'failed');
  return `${url.pathname}${url.search}${url.hash}`;
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

function clearDatabricksOAuthCookies(response: Response): void {
  response.clearCookie(DATABRICKS_OAUTH_BINDING_COOKIE, {
    ...DATABRICKS_OAUTH_COOKIE_OPTIONS,
    maxAge: undefined,
  });
  response.clearCookie(DATABRICKS_OAUTH_RETURN_COOKIE, {
    ...DATABRICKS_OAUTH_COOKIE_OPTIONS,
    maxAge: undefined,
  });
}
