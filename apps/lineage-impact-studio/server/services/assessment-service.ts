import { createHash } from 'node:crypto';

import type { Request } from 'express';

import {
  createAssessmentViewV2,
  SourceEvidenceViewSchema,
  type AssessmentViewV2,
  type SourceEvidenceView,
} from '../domain/assessment-view';
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

export class DetailedEvidenceUnavailableError extends Error {
  override readonly name = 'DetailedEvidenceUnavailableError';

  constructor() {
    super('Re-run this assessment before requesting source evidence.');
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
  }): Promise<AssessmentViewV2> {
    const viewer = requireOboRequest(options.request);
    const { reference, envelope } = await this.#load(options.reference);
    try {
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

      return createAssessmentViewV2({
        reference,
        projection,
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
        access,
      });
    } catch (error) {
      if (error instanceof AssessmentUnavailableError || error instanceof AssessmentPermissionCheckError) throw error;
      console.warn('[lineage-impact-studio] Assessment unavailable after envelope load', safeErrorType(error));
      throw new AssessmentUnavailableError();
    }
  }

  async getSourceEvidence(options: {
    reference: unknown;
    authorizedView: AssessmentViewV2;
  }): Promise<SourceEvidenceView> {
    const { reference, envelope } = await this.#load(options.reference);
    if (envelope.schema_version !== 3 || options.authorizedView.detailState !== 'available') {
      throw new DetailedEvidenceUnavailableError();
    }
    if (options.authorizedView.reference !== reference) throw new AssessmentUnavailableError();
    const changeIds = new Set(options.authorizedView.changes.map((change) => change.id));
    const impactIds = new Set(options.authorizedView.impacts.map((impact) => impact.id));
    const pullRequestFilesUrl = `https://github.com/${envelope.source.repository}/pull/${String(envelope.source.pull_request_number)}/files`;
    return SourceEvidenceViewSchema.parse({
      schemaVersion: 1,
      assessmentReference: reference,
      pullRequestFilesUrl,
      changes: envelope.evidence.display_evidence.changes
        .filter((change) => changeIds.has(change.id))
        .map((change) => ({
          id: change.id,
          filePath: change.file_path,
          diffUrl:
            change.file_path === null
              ? null
              : `${pullRequestFilesUrl}#diff-${createHash('sha256').update(change.file_path).digest('hex')}`,
          beforeExpression: change.before_expression,
          afterExpression: change.after_expression,
        })),
      impacts: envelope.evidence.display_evidence.impacts
        .filter((impact) => impactIds.has(impact.id))
        .map((impact) => ({ id: impact.id, targetExpression: impact.target_expression })),
    });
  }

  async #load(referenceValue: unknown) {
    let reference: string;
    let envelopeBytes: Uint8Array;
    try {
      reference = parseAssessmentReference(referenceValue);
      envelopeBytes = await this.#reader.read(reference);
      return { reference, envelope: parseRestrictedAssessmentEnvelope(envelopeBytes, reference) };
    } catch (error) {
      console.warn('[lineage-impact-studio] Assessment unavailable at envelope load', safeErrorType(error));
      throw new AssessmentUnavailableError();
    }
  }
}

export function createAuthorizedFixContext(view: AssessmentViewV2) {
  const authorizedLineage = view.impacts.map((impact) =>
    impact.path
      .filter((segment) => segment.kind === 'asset')
      .map((segment) => ({ reference: segment.reference, assetType: segment.assetType }))
  );
  return {
    schemaVersion: 1 as const,
    assessmentReference: view.reference,
    status: view.status,
    message: view.message,
    pullRequest: view.pullRequest,
    authorizedLineage,
    disclosureState: view.disclosure.state,
  };
}

function assessmentFreshness(createdAtValue: string, now: Date): AssessmentViewV2['source']['freshness'] | 'expired' {
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
