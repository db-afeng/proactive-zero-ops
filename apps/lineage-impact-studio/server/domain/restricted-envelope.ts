import { z } from 'zod';

import {
  AssessmentReferenceSchema,
  CommitShaSchema,
  GitHubRepositorySchema,
  type AssessmentReference,
} from './identifiers';

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_EXPRESSION_LENGTH = 100_000;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const AssetReferenceSchema = z
  .string()
  .min(5)
  .max(1024)
  .refine((value) => {
    const parts = value.split('.');
    return (
      value === value.trim() &&
      parts.length === 3 &&
      parts.every((part) => part.length > 0 && part.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(part))
    );
  }, 'Invalid Unity Catalog asset reference');

const IdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const ColumnNameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !hasControlCharacter(value));
const ExpressionSchema = z.string().min(1).max(MAX_EXPRESSION_LENGTH).nullable();
const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..') &&
      !hasControlCharacter(value),
    'Invalid repository path'
  )
  .nullable();

export const TypeFamilySchema = z.enum(['numeric', 'text', 'boolean', 'date', 'timestamp', 'complex', 'unknown']);
export const OperationKindSchema = z.enum([
  'arithmetic',
  'aggregate',
  'comparison',
  'filter',
  'join',
  'cast',
  'constraint',
  'pass_through',
  'unknown',
]);
export const ImpactReasonCodeSchema = z.enum([
  'incompatible_type',
  'missing_column',
  'renamed_column',
  'incompatible_operation',
  'semantic_change',
  'upstream_failure',
  'manual_review',
]);
export const RemediationKindSchema = z.enum([
  'restore_contract',
  'add_compatibility_column',
  'update_consumers',
  'reassess',
]);
export const EvidenceOriginSchema = z.enum(['observed_lineage', 'proposed_code']);

export const DisplayChangeSchema = z
  .object({
    id: IdentifierSchema,
    asset: AssetReferenceSchema,
    column: ColumnNameSchema,
    change_kind: z.enum(['added', 'deleted', 'renamed', 'modified']),
    before_type: TypeFamilySchema,
    after_type: TypeFamilySchema,
    before_expression: ExpressionSchema,
    after_expression: ExpressionSchema,
    file_path: RepositoryPathSchema,
  })
  .strict();

export const DisplayImpactSchema = z
  .object({
    id: IdentifierSchema,
    change_id: IdentifierSchema,
    relation: z.enum(['direct', 'transitive']),
    target_asset: AssetReferenceSchema,
    target_column: ColumnNameSchema.nullable(),
    operation: OperationKindSchema,
    reason: ImpactReasonCodeSchema,
    evidence_level: z.enum(['definition', 'lineage']),
    path: z.array(AssetReferenceSchema).min(1).max(64),
    target_expression: ExpressionSchema,
    remediation: RemediationKindSchema,
  })
  .strict();

export const DisplayEdgeSchema = z
  .object({
    id: IdentifierSchema,
    source_asset: AssetReferenceSchema,
    target_asset: AssetReferenceSchema,
    source_column: ColumnNameSchema.nullable(),
    target_column: ColumnNameSchema.nullable(),
    level: z.enum(['column', 'table']),
    origins: z.array(EvidenceOriginSchema).min(1).max(2),
    last_observed_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const DisplayEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    headline: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !hasControlCharacter(value)),
    recommended_action: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !hasControlCharacter(value)),
    changes: z.array(DisplayChangeSchema).max(100),
    impacts: z.array(DisplayImpactSchema).max(500),
    edges: z.array(DisplayEdgeSchema).max(500),
  })
  .strict()
  .superRefine((evidence, context) => {
    const changeIds = new Set(evidence.changes.map((change) => change.id));
    const impactIds = new Set<string>();
    for (const impact of evidence.impacts) {
      if (!changeIds.has(impact.change_id)) {
        context.addIssue({ code: 'custom', path: ['impacts'], message: 'Impact references an unknown change' });
      }
      if (impactIds.has(impact.id)) {
        context.addIssue({ code: 'custom', path: ['impacts'], message: 'Impact identifier is not unique' });
      }
      impactIds.add(impact.id);
    }
    if (changeIds.size !== evidence.changes.length) {
      context.addIssue({ code: 'custom', path: ['changes'], message: 'Change identifier is not unique' });
    }
  });

const GuardResultV3Schema = z
  .object({
    status: z.enum(['pass', 'warn', 'block', 'error']),
    severity: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    confidence: z.number().min(0).max(1),
    summary: z.string().max(100_000),
    assessment_complete: z.boolean(),
    discovery_certainty: z.enum(['complete', 'incomplete']),
    changed_files: z.array(z.string()).optional(),
    changed_columns: z.array(JsonValueSchema).optional(),
    impacts: z.array(JsonValueSchema).optional(),
    lineage_edges: z.array(JsonValueSchema).optional(),
    semantic_changes: z.array(JsonValueSchema).optional(),
    bundle_changes: z.array(JsonValueSchema).optional(),
    coverage_limitations: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    error: z.string().nullable().optional(),
  })
  .strict();

const EnvelopeBaseSchema = z.object({
  assessment_reference: AssessmentReferenceSchema,
  created_at: z.iso.datetime({ offset: true }),
  source: z
    .object({
      provider: z.literal('github'),
      repository: GitHubRepositorySchema,
      pull_request_number: z.number().int().positive(),
      base_sha: CommitShaSchema,
      head_sha: CommitShaSchema,
    })
    .strict(),
  classification: z.literal('restricted'),
  authentication: z.literal('required'),
  viewer_authorization: z.literal('required'),
  assessment_principal: z.literal('service_principal'),
});

export const RestrictedAssessmentEnvelopeV2Schema = EnvelopeBaseSchema.extend({
  schema_version: z.literal(2),
  evidence: JsonValueSchema,
}).strict();

export const RestrictedAssessmentEnvelopeV3Schema = EnvelopeBaseSchema.extend({
  schema_version: z.literal(3),
  evidence: z
    .object({
      result: GuardResultV3Schema,
      display_evidence: DisplayEvidenceSchema,
      identity_semantics: z
        .object({
          assessment_principal: z.literal('service_principal'),
          on_behalf_of_user: z.literal(false),
        })
        .strict(),
      discovery: JsonValueSchema.optional(),
      model_assessment: JsonValueSchema.optional(),
    })
    .strict(),
}).strict();

export const RestrictedAssessmentEnvelopeSchema = z.discriminatedUnion('schema_version', [
  RestrictedAssessmentEnvelopeV2Schema,
  RestrictedAssessmentEnvelopeV3Schema,
]);

export type RestrictedAssessmentEnvelopeV2 = z.infer<typeof RestrictedAssessmentEnvelopeV2Schema>;
export type RestrictedAssessmentEnvelopeV3 = z.infer<typeof RestrictedAssessmentEnvelopeV3Schema>;
export type RestrictedAssessmentEnvelope = z.infer<typeof RestrictedAssessmentEnvelopeSchema>;
export type DisplayEvidence = z.infer<typeof DisplayEvidenceSchema>;

export class InvalidRestrictedEnvelopeError extends Error {
  override readonly name = 'InvalidRestrictedEnvelopeError';

  constructor() {
    super('Restricted assessment envelope is invalid');
  }
}

/** Parse the exact supported wire envelopes and bind them to the opaque reference. */
export function parseRestrictedAssessmentEnvelope(
  input: unknown,
  expectedReference?: AssessmentReference
): RestrictedAssessmentEnvelope {
  try {
    const decoded = decodeEnvelopeInput(input);
    const envelope = RestrictedAssessmentEnvelopeSchema.parse(decoded);
    if (expectedReference !== undefined && envelope.assessment_reference !== expectedReference) {
      throw new InvalidRestrictedEnvelopeError();
    }
    return envelope;
  } catch (error) {
    if (error instanceof InvalidRestrictedEnvelopeError) throw error;
    throw new InvalidRestrictedEnvelopeError();
  }
}

function decodeEnvelopeInput(input: unknown): unknown {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) return input;
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) throw new InvalidRestrictedEnvelopeError();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029) return true;
  }
  return false;
}
