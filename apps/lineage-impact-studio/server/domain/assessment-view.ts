import { z } from 'zod';

import { AssessmentReferenceSchema, CommitShaSchema, GitHubRepositorySchema } from './identifiers';

export const AssessmentStatusSchema = z.enum(['pass', 'warn', 'block', 'error']);
export const AssessmentFreshnessSchema = z.enum(['current', 'stale', 'unknown']);
export const DisclosureStateSchema = z.enum(['full', 'partial', 'none']);

export const LineageAssetSchema = z
  .object({
    reference: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value === value.trim() && !hasUnsafeTextCharacter(value), {
        message: 'Invalid asset reference',
      }),
    assetType: z.enum(['table', 'view', 'materialized_view', 'streaming_table', 'unknown']),
  })
  .strict();

export const LineageDisclosureInputSchema = z
  .object({
    authorized: z.boolean(),
    asset: LineageAssetSchema,
  })
  .strict();

export const AuthorizedLineageAssetSchema = z
  .object({
    kind: z.literal('asset'),
    reference: LineageAssetSchema.shape.reference,
    assetType: LineageAssetSchema.shape.assetType,
  })
  .strict();

/** A deliberately content-free placeholder for one contiguous hidden run. */
export const RestrictedSegmentSchema = z.object({ kind: z.literal('restricted') }).strict();

export const LineageSegmentSchema = z.discriminatedUnion('kind', [
  AuthorizedLineageAssetSchema,
  RestrictedSegmentSchema,
]);

export type LineageDisclosureInput = z.infer<typeof LineageDisclosureInputSchema>;
export type LineageSegment = z.infer<typeof LineageSegmentSchema>;

const STATUS_MESSAGES = {
  pass: 'No blocking downstream impact was identified.',
  warn: 'The assessment completed with a non-blocking warning.',
  block: 'A potentially breaking downstream impact was identified.',
  error: 'The assessment could not be completed safely.',
} as const;

const DISCLOSURE_NOTICES = {
  full: 'All referenced lineage assets are visible to you.',
  partial: 'Some lineage is hidden because you do not have access.',
  none: 'Lineage details are hidden because you do not have access.',
} as const;

export const AssessmentViewV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    reference: AssessmentReferenceSchema,
    status: AssessmentStatusSchema,
    message: z.enum([STATUS_MESSAGES.pass, STATUS_MESSAGES.warn, STATUS_MESSAGES.block, STATUS_MESSAGES.error]),
    source: z
      .object({
        provider: z.literal('github'),
        createdAt: z.iso.datetime({ offset: true }),
        freshness: AssessmentFreshnessSchema,
      })
      .strict(),
    pullRequest: z
      .object({
        repository: GitHubRepositorySchema,
        number: z.number().int().positive(),
        baseSha: CommitShaSchema,
        headSha: CommitShaSchema,
      })
      .strict(),
    viewer: z
      .object({
        subject: z
          .string()
          .min(1)
          .max(512)
          .refine((value) => !hasUnsafeTextCharacter(value)),
        displayName: z
          .string()
          .min(1)
          .max(512)
          .refine((value) => value === value.trim() && !hasUnsafeTextCharacter(value)),
      })
      .strict(),
    lineagePaths: z.array(
      z
        .object({
          segments: z.array(LineageSegmentSchema).min(1),
        })
        .strict()
    ),
    disclosure: z
      .object({
        state: DisclosureStateSchema,
        notice: z.enum([DISCLOSURE_NOTICES.full, DISCLOSURE_NOTICES.partial, DISCLOSURE_NOTICES.none]),
      })
      .strict(),
  })
  .strict()
  .superRefine((view, context) => {
    if (view.message !== STATUS_MESSAGES[view.status]) {
      context.addIssue({ code: 'custom', path: ['message'], message: 'Status message mismatch' });
    }
    if (view.disclosure.notice !== DISCLOSURE_NOTICES[view.disclosure.state]) {
      context.addIssue({
        code: 'custom',
        path: ['disclosure', 'notice'],
        message: 'Disclosure notice mismatch',
      });
    }
  });

export type AssessmentViewV1 = z.infer<typeof AssessmentViewV1Schema>;

export interface AssessmentViewV1Input {
  reference: string;
  status: z.infer<typeof AssessmentStatusSchema>;
  source: AssessmentViewV1['source'];
  pullRequest: AssessmentViewV1['pullRequest'];
  viewer: AssessmentViewV1['viewer'];
  lineagePaths: AssessmentViewV1['lineagePaths'];
}

export function redactLineagePath(input: readonly LineageDisclosureInput[]): LineageSegment[] {
  const result: LineageSegment[] = [];
  let insideRestrictedRun = false;

  for (const candidateValue of input) {
    const candidate = LineageDisclosureInputSchema.parse(candidateValue);
    if (!candidate.authorized) {
      if (!insideRestrictedRun) {
        result.push({ kind: 'restricted' });
        insideRestrictedRun = true;
      }
      continue;
    }

    result.push({
      kind: 'asset',
      reference: candidate.asset.reference,
      assetType: candidate.asset.assetType,
    });
    insideRestrictedRun = false;
  }

  return result;
}

export function disclosureStateFor(paths: readonly { segments: readonly LineageSegment[] }[]) {
  let hasAuthorized = false;
  let hasRestricted = false;
  for (const path of paths) {
    for (const segmentValue of path.segments) {
      const segment = LineageSegmentSchema.parse(segmentValue);
      hasAuthorized ||= segment.kind === 'asset';
      hasRestricted ||= segment.kind === 'restricted';
    }
  }

  if (hasRestricted && hasAuthorized) return 'partial' as const;
  if (hasRestricted) return 'none' as const;
  return 'full' as const;
}

/** Build the browser DTO from an explicit allowlist; raw envelopes are not accepted. */
export function createAssessmentViewV1(input: AssessmentViewV1Input): AssessmentViewV1 {
  const disclosureState = disclosureStateFor(input.lineagePaths);
  return AssessmentViewV1Schema.parse({
    schemaVersion: 1,
    reference: input.reference,
    status: input.status,
    message: STATUS_MESSAGES[input.status],
    source: input.source,
    pullRequest: input.pullRequest,
    viewer: input.viewer,
    lineagePaths: input.lineagePaths,
    disclosure: {
      state: disclosureState,
      notice: DISCLOSURE_NOTICES[disclosureState],
    },
  });
}

/** Re-validate at the final serialization boundary so unknown evidence keys fail closed. */
export function serializeAssessmentViewV1(value: unknown): string {
  return JSON.stringify(AssessmentViewV1Schema.parse(value));
}

function hasUnsafeTextCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029) {
      return true;
    }
  }
  return false;
}
