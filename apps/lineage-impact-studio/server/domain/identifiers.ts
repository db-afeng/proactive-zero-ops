import { z } from 'zod';

const ASSESSMENT_REFERENCE_PATTERN = /^lgr_[A-Za-z0-9_-]{32}$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const UNITY_CATALOG_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$/;

export const AssessmentReferenceSchema = z.string().regex(ASSESSMENT_REFERENCE_PATTERN, 'Invalid assessment reference');

export const GitHubRepositorySchema = z.string().superRefine((value, context) => {
  const parts = value.split('/');
  if (parts.length !== 2 || !GITHUB_NAME_PATTERN.test(parts[0] ?? '') || !GITHUB_NAME_PATTERN.test(parts[1] ?? '')) {
    context.addIssue({ code: 'custom', message: 'Invalid GitHub repository' });
  }
});

export const CommitShaSchema = z.string().regex(COMMIT_SHA_PATTERN, 'Invalid full commit SHA');

export const UnityCatalogVolumeRootSchema = z.string().superRefine((value, context) => {
  if (value !== value.trim() || value.includes('//') || value.endsWith('/')) {
    context.addIssue({ code: 'custom', message: 'Invalid Unity Catalog Volume root' });
    return;
  }

  const parts = value.split('/');
  if (
    parts.length !== 5 ||
    parts[0] !== '' ||
    parts[1] !== 'Volumes' ||
    !parts.slice(2).every((part) => UNITY_CATALOG_NAME_PATTERN.test(part))
  ) {
    context.addIssue({ code: 'custom', message: 'Invalid Unity Catalog Volume root' });
  }
});

export type AssessmentReference = z.infer<typeof AssessmentReferenceSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export type CommitSha = z.infer<typeof CommitShaSchema>;

export function parseAssessmentReference(value: unknown): AssessmentReference {
  return AssessmentReferenceSchema.parse(value);
}

export function restrictedEnvelopePath(volumeRoot: unknown, reference: unknown): string {
  const root = UnityCatalogVolumeRootSchema.parse(volumeRoot);
  const safeReference = AssessmentReferenceSchema.parse(reference);
  return `${root}/${safeReference}.json`;
}
