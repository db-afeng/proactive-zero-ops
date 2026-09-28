import type { Request } from 'express';

import { createAssessmentViewV1, redactLineagePath, type AssessmentViewV1 } from '../domain/assessment-view';
import { projectRestrictedEvidence } from '../domain/evidence-projection';
import { parseAssessmentReference } from '../domain/identifiers';
import { parseRestrictedAssessmentEnvelope } from '../domain/restricted-envelope';
import { requireOboRequest } from '../security/obo';
import { authorizeAssets, type UserAnalyticsExecutor } from './asset-authorization';

const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ASSESSMENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class AssessmentUnavailableError extends Error {
  override readonly name = 'AssessmentUnavailableError';

  constructor() {
    super('This assessment is unavailable.');
  }
}

export class AssessmentPermissionCheckError extends Error {
  override readonly name = 'AssessmentPermissionCheckError';

  constructor() {
    super('Your Databricks permissions could not be verified.');
  }
}

export interface RestrictedEnvelopeReader {
  read(reference: string): Promise<Uint8Array>;
}

export interface AssessmentServiceOptions {
  reader: RestrictedEnvelopeReader;
  assetAccessQuery: string;
  now?: () => Date;
}

export class AssessmentService {
  readonly #reader: RestrictedEnvelopeReader;
  readonly #assetAccessQuery: string;
  readonly #now: () => Date;

  constructor(options: AssessmentServiceOptions) {
    this.#reader = options.reader;
    this.#assetAccessQuery = options.assetAccessQuery;
    this.#now = options.now ?? (() => new Date());
  }

  async getView(options: {
    request: Request;
    reference: unknown;
    userAnalytics: UserAnalyticsExecutor;
  }): Promise<AssessmentViewV1> {
    const viewer = requireOboRequest(options.request);
    let reference: string;
    let envelopeBytes: Uint8Array;
    try {
      reference = parseAssessmentReference(options.reference);
      envelopeBytes = await this.#reader.read(reference);
    } catch (error) {
      console.warn('[lineage-impact-studio] Assessment unavailable at envelope load', safeErrorType(error));
      throw new AssessmentUnavailableError();
    }

    try {
      const envelope = parseRestrictedAssessmentEnvelope(envelopeBytes, reference);
      const freshness = assessmentFreshness(envelope.created_at, this.#now());
      if (freshness === 'expired') throw new AssessmentUnavailableError();
      const projection = projectRestrictedEvidence(envelope);
      let access: Awaited<ReturnType<typeof authorizeAssets>>;
      try {
        access = await authorizeAssets({
          executor: options.userAnalytics,
          queryText: this.#assetAccessQuery,
          assets: projection.uniqueAssets,
        });
      } catch (error) {
        console.warn('[lineage-impact-studio] Assessment permission check failed', safeErrorType(error));
        throw new AssessmentPermissionCheckError();
      }

      const anyAuthorized = [...access.values()].some((decision) => decision.authorized);
      if (projection.uniqueAssets.length > 0 && !anyAuthorized) {
        console.warn('[lineage-impact-studio] Assessment has no authorized assets');
        throw new AssessmentUnavailableError();
      }

      const lineagePaths = projection.lineagePaths.map((path) => ({
        segments: redactLineagePath(
          path.map((asset) => {
            const decision = access.get(asset.reference);
            return {
              authorized: decision?.authorized === true,
              asset: {
                reference: asset.reference,
                assetType: decision?.assetType ?? asset.assetType,
              },
            };
          })
        ),
      }));

      return createAssessmentViewV1({
        reference,
        status: projection.status,
        source: {
          provider: 'github',
          createdAt: envelope.created_at,
          freshness,
        },
        pullRequest: {
          repository: envelope.source.repository,
          number: envelope.source.pull_request_number,
          baseSha: envelope.source.base_sha,
          headSha: envelope.source.head_sha,
        },
        viewer,
        lineagePaths,
      });
    } catch (error) {
      if (error instanceof AssessmentUnavailableError || error instanceof AssessmentPermissionCheckError) {
        throw error;
      }
      console.warn('[lineage-impact-studio] Assessment unavailable after envelope load', safeErrorType(error));
      throw new AssessmentUnavailableError();
    }
  }
}

export function createAuthorizedFixContext(view: AssessmentViewV1) {
  return {
    schemaVersion: 1 as const,
    assessmentReference: view.reference,
    status: view.status,
    message: view.message,
    pullRequest: view.pullRequest,
    authorizedLineage: view.lineagePaths.map((path) =>
      path.segments
        .filter((segment) => segment.kind === 'asset')
        .map((segment) => ({ reference: segment.reference, assetType: segment.assetType }))
    ),
    disclosureState: view.disclosure.state,
  };
}

function assessmentFreshness(createdAtValue: string, now: Date): AssessmentViewV1['source']['freshness'] | 'expired' {
  const createdAt = Date.parse(createdAtValue);
  const age = now.getTime() - createdAt;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  if (age > MAX_ASSESSMENT_AGE_MS) return 'expired';
  return age <= CURRENT_WINDOW_MS ? 'current' : 'stale';
}

function safeErrorType(error: unknown): Record<string, string> {
  const result: Record<string, string> = { type: error instanceof Error ? error.name : typeof error };
  if (typeof error === 'object' && error !== null) {
    const reason: unknown = Reflect.get(error, 'reason');
    if (typeof reason === 'string' && /^[a-z_]+$/.test(reason)) result.reason = reason;
  }
  return result;
}
