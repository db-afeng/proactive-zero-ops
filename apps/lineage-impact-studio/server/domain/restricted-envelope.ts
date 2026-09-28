import { z } from 'zod';

import {
  AssessmentReferenceSchema,
  CommitShaSchema,
  GitHubRepositorySchema,
  type AssessmentReference,
} from './identifiers';

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

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

export const RestrictedAssessmentEnvelopeV2Schema = z
  .object({
    schema_version: z.literal(2),
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
    evidence: JsonValueSchema,
  })
  .strict();

export type RestrictedAssessmentEnvelopeV2 = z.infer<typeof RestrictedAssessmentEnvelopeV2Schema>;

export class InvalidRestrictedEnvelopeError extends Error {
  override readonly name = 'InvalidRestrictedEnvelopeError';

  constructor() {
    super('Restricted assessment envelope is invalid');
  }
}

/**
 * Parse the exact v2 wire envelope and optionally bind it to the requested
 * opaque reference. The generic error deliberately does not echo evidence.
 */
export function parseRestrictedAssessmentEnvelope(
  input: unknown,
  expectedReference?: AssessmentReference
): RestrictedAssessmentEnvelopeV2 {
  try {
    const decoded = decodeEnvelopeInput(input);
    const envelope = RestrictedAssessmentEnvelopeV2Schema.parse(decoded);
    if (expectedReference !== undefined && envelope.assessment_reference !== expectedReference) {
      throw new InvalidRestrictedEnvelopeError();
    }
    return envelope;
  } catch (error) {
    if (error instanceof InvalidRestrictedEnvelopeError) {
      throw error;
    }
    throw new InvalidRestrictedEnvelopeError();
  }
}

function decodeEnvelopeInput(input: unknown): unknown {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    return input;
  }

  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new InvalidRestrictedEnvelopeError();
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}
