import { describe, expect, it } from 'vitest';

import {
  AssessmentReferenceSchema,
  CommitShaSchema,
  GitHubRepositorySchema,
  UnityCatalogVolumeRootSchema,
  restrictedEnvelopePath,
} from './identifiers';

const REFERENCE = 'lgr_0123456789abcdefghijklmnopqrstuv';
const VOLUME = '/Volumes/proactive_zero_ops_catalog/proactive_zero_ops_guard/restricted_assessments';

describe('trusted identifiers', () => {
  it('constructs an envelope path only from an opaque reference and exact Volume root', () => {
    expect(restrictedEnvelopePath(VOLUME, REFERENCE)).toBe(`${VOLUME}/${REFERENCE}.json`);
  });

  it.each([
    '',
    'lgr_short',
    `${REFERENCE}/other`,
    `${REFERENCE}.json`,
    ` ${REFERENCE}`,
    'lgr_0123456789abcdefghijklmnopqrstu%2F',
  ])('rejects unsafe or non-opaque assessment reference %j', (value) => {
    expect(AssessmentReferenceSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    'dbfs:/Volumes/catalog/schema/volume',
    '/Volumes/catalog/schema',
    '/Volumes/catalog/schema/volume/child',
    '/Volumes/catalog/schema/../volume',
    '/Volumes/catalog//schema/volume',
    '/Volumes/catalog/schema/volume/',
  ])('rejects noncanonical Volume root %j', (value) => {
    expect(UnityCatalogVolumeRootSchema.safeParse(value).success).toBe(false);
  });

  it('accepts only owner/name repositories and full lowercase commit IDs', () => {
    expect(GitHubRepositorySchema.parse('db-afeng/proactive-zero-ops')).toBe('db-afeng/proactive-zero-ops');
    expect(GitHubRepositorySchema.safeParse('db-afeng/proactive-zero-ops/extra').success).toBe(false);
    expect(CommitShaSchema.safeParse('a'.repeat(40)).success).toBe(true);
    expect(CommitShaSchema.safeParse('A'.repeat(40)).success).toBe(false);
    expect(CommitShaSchema.safeParse('a'.repeat(39)).success).toBe(false);
  });
});
