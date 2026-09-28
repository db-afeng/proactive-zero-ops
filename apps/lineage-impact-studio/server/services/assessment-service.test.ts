import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  AssessmentPermissionCheckError,
  AssessmentService,
  AssessmentUnavailableError,
  createAuthorizedFixContext,
} from './assessment-service';

const reference = 'lgr_0123456789abcdefghijklmnopqrstuv';
const now = new Date('2026-09-28T12:00:00Z');

function request(): Request {
  const result = Object.create(null) as Request;
  result.headers = {
    'x-forwarded-user': 'viewer-id',
    'x-forwarded-email': 'viewer@example.com',
    'x-forwarded-access-token': 't'.repeat(32),
  };
  return result;
}

function payload(createdAt = '2026-09-28T10:00:00Z'): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      schema_version: 2,
      assessment_reference: reference,
      created_at: createdAt,
      source: {
        provider: 'github',
        repository: 'db-afeng/proactive-zero-ops',
        pull_request_number: 4,
        base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
      },
      classification: 'restricted',
      authentication: 'required',
      viewer_authorization: 'required',
      assessment_principal: 'service_principal',
      evidence: {
        result: {
          status: 'block',
          impacts: [
            {
              path: [
                'catalog.schema.allowed',
                'catalog.schema.hidden_one',
                'catalog.schema.hidden_two',
                'catalog.schema.allowed_two',
              ],
              evidence: 'must never reach the browser',
            },
          ],
        },
      },
    })
  );
}

function service(bytes = payload()) {
  return new AssessmentService({
    reader: { read: vi.fn().mockResolvedValue(bytes) },
    assetAccessQuery: 'SELECT access',
    now: () => now,
  });
}

describe('AssessmentService', () => {
  it('returns authorized assets with one anonymous contiguous restricted segment', async () => {
    const view = await service().getView({
      request: request(),
      reference,
      userAnalytics: {
        query: vi.fn().mockResolvedValue({
          data: [
            { ordinal: 0, asset_reference: 'catalog.schema.allowed', can_select: true, asset_type: 'TABLE' },
            { ordinal: 1, asset_reference: 'catalog.schema.hidden_one', can_select: false, asset_type: 'TABLE' },
            { ordinal: 2, asset_reference: 'catalog.schema.hidden_two', can_select: false, asset_type: 'VIEW' },
            { ordinal: 3, asset_reference: 'catalog.schema.allowed_two', can_select: true, asset_type: 'VIEW' },
          ],
        }),
      },
    });

    expect(view.lineagePaths[0]?.segments).toEqual([
      { kind: 'asset', reference: 'catalog.schema.allowed', assetType: 'table' },
      { kind: 'restricted' },
      { kind: 'asset', reference: 'catalog.schema.allowed_two', assetType: 'view' },
    ]);
    expect(view.disclosure.state).toBe('partial');
    expect(JSON.stringify(view)).not.toContain('hidden_one');
    expect(JSON.stringify(view)).not.toContain('hidden_two');
    expect(JSON.stringify(view)).not.toContain('must never');
    expect(createAuthorizedFixContext(view).authorizedLineage).toEqual([
      [
        { reference: 'catalog.schema.allowed', assetType: 'table' },
        { reference: 'catalog.schema.allowed_two', assetType: 'view' },
      ],
    ]);
  });

  it('uses the same generic unavailable response for missing, expired, and no-access references', async () => {
    const missing = new AssessmentService({
      reader: { read: vi.fn().mockRejectedValue(new Error('missing')) },
      assetAccessQuery: 'SELECT access',
    });
    await expect(
      missing.getView({ request: request(), reference, userAnalytics: { query: vi.fn() } })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);

    await expect(
      service(payload('2026-08-01T10:00:00Z')).getView({
        request: request(),
        reference,
        userAnalytics: { query: vi.fn() },
      })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);

    await expect(
      service().getView({
        request: request(),
        reference,
        userAnalytics: {
          query: vi.fn().mockResolvedValue({
            data: [
              { ordinal: 0, asset_reference: 'catalog.schema.allowed', can_select: false, asset_type: 'TABLE' },
              { ordinal: 1, asset_reference: 'catalog.schema.hidden_one', can_select: false, asset_type: 'TABLE' },
              { ordinal: 2, asset_reference: 'catalog.schema.hidden_two', can_select: false, asset_type: 'VIEW' },
              { ordinal: 3, asset_reference: 'catalog.schema.allowed_two', can_select: false, asset_type: 'VIEW' },
            ],
          }),
        },
      })
    ).rejects.toBeInstanceOf(AssessmentUnavailableError);
  });

  it('does not fall back when OBO verification fails', async () => {
    await expect(
      service().getView({
        request: request(),
        reference,
        userAnalytics: { query: vi.fn().mockRejectedValue(new Error('OBO denied')) },
      })
    ).rejects.toBeInstanceOf(AssessmentPermissionCheckError);
  });
});
