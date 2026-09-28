import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { CommitShaSchema, GitHubRepositorySchema } from '../domain/identifiers';

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 50;
const PATCH_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const LOCK_FILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  '.next',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const PROTECTED_DIRECTORY_NAMES = new Set([
  '.claude',
  '.codex',
  '.cursor',
  '.databricks',
  '.github',
  'apps',
  'charts',
  'deploy',
  'deployment',
  'helm',
  'infra',
  'infrastructure',
  'k8s',
  'kubernetes',
  'resources',
  'terraform',
]);

const AGENT_INSTRUCTION_NAMES = new Set([
  'agents.md',
  'claude.md',
  'copilot-instructions.md',
  'cursor.md',
  'gemini.md',
]);

const DEPLOYMENT_FILE_NAMES = new Set([
  'app.yaml',
  'app.yml',
  'bundle.yaml',
  'bundle.yml',
  'databricks.yaml',
  'databricks.yml',
  'dockerfile',
]);

export const RepositoryPathSchema = z.string().superRefine((value, context) => {
  try {
    validateRepositoryPath(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Unsafe repository path' });
  }
});

export const ChangedFileDescriptorSchema = z
  .object({
    beforePath: RepositoryPathSchema.nullable(),
    afterPath: RepositoryPathSchema.nullable(),
    binary: z.literal(false),
    generated: z.literal(false),
    beforeType: z.enum(['absent', 'regular']),
    afterType: z.enum(['absent', 'regular']),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.beforePath === null && file.afterPath === null) {
      context.addIssue({ code: 'custom', message: 'Changed file has no path' });
    }
    if ((file.beforePath === null) !== (file.beforeType === 'absent')) {
      context.addIssue({ code: 'custom', message: 'Before-path type is inconsistent' });
    }
    if ((file.afterPath === null) !== (file.afterType === 'absent')) {
      context.addIssue({ code: 'custom', message: 'After-path type is inconsistent' });
    }
  });

export const CommitGateInputSchema = z
  .object({
    baseRepository: GitHubRepositorySchema,
    headRepository: GitHubRepositorySchema,
    isFork: z.literal(false),
    pullRequestState: z.literal('open'),
    canPush: z.literal(true),
    force: z.literal(false),
    commitStrategy: z.literal('normal'),
    expectedHeadSha: CommitShaSchema,
    observedHeadSha: CommitShaSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.baseRepository.toLowerCase() !== input.headRepository.toLowerCase()) {
      context.addIssue({ code: 'custom', message: 'Fork pull requests are not supported' });
    }
    if (input.expectedHeadSha !== input.observedHeadSha) {
      context.addIssue({ code: 'custom', message: 'Pull request head changed' });
    }
  });

export const PatchCandidateSchema = z
  .object({
    gate: CommitGateInputSchema,
    files: z.array(ChangedFileDescriptorSchema).min(1).max(MAX_CHANGED_FILES),
    patch: z.union([z.string(), z.instanceof(Uint8Array)]),
  })
  .strict();

export type CommitGateInput = z.infer<typeof CommitGateInputSchema>;
export type ChangedFileDescriptor = z.infer<typeof ChangedFileDescriptorSchema>;

export interface ValidatedPatch {
  bytes: Buffer;
  digest: string;
  files: ChangedFileDescriptor[];
  gate: CommitGateInput;
}

export class PatchPolicyError extends Error {
  override readonly name = 'PatchPolicyError';

  constructor(message: string) {
    super(message);
  }
}

export function validatePatchCandidate(input: unknown): ValidatedPatch {
  let candidate: z.infer<typeof PatchCandidateSchema>;
  try {
    candidate = PatchCandidateSchema.parse(input);
  } catch {
    throw new PatchPolicyError('Patch candidate failed safety validation');
  }

  for (const file of candidate.files) {
    if (file.beforePath !== null) enforcePathPolicy(file.beforePath);
    if (file.afterPath !== null) enforcePathPolicy(file.afterPath);
  }

  const bytes =
    typeof candidate.patch === 'string' ? Buffer.from(candidate.patch, 'utf8') : Buffer.from(candidate.patch);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PATCH_BYTES || bytes.includes(0)) {
    throw new PatchPolicyError('Patch must be non-empty text within the size limit');
  }

  let patchText: string;
  try {
    patchText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PatchPolicyError('Patch must be valid UTF-8 text');
  }

  const patchFiles = parseUnifiedDiffFiles(patchText);
  const declared = candidate.files.map(fileIdentity).sort();
  const observed = patchFiles.map(fileIdentity).sort();
  if (declared.length !== observed.length || declared.some((identity, index) => identity !== observed[index])) {
    throw new PatchPolicyError('Patch file headers do not match the validated file list');
  }

  return {
    bytes,
    digest: computePatchDigest(bytes),
    files: candidate.files,
    gate: candidate.gate,
  };
}

export function computePatchDigest(patch: string | Uint8Array): string {
  const bytes = typeof patch === 'string' ? Buffer.from(patch, 'utf8') : Buffer.from(patch);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function verifyPatchApproval(options: {
  patch: string | Uint8Array;
  requestedPatchDigest: string;
  approvedPatchDigest: string;
  expectedHeadSha: string;
  approvedHeadSha: string;
}): boolean {
  const actualDigest = computePatchDigest(options.patch);
  const actualMatchesRequest = constantTimeDigestEqual(actualDigest, options.requestedPatchDigest);
  const actualMatchesApproval = constantTimeDigestEqual(actualDigest, options.approvedPatchDigest);
  const headMatches = constantTimeShaEqual(options.expectedHeadSha, options.approvedHeadSha);
  return actualMatchesRequest && actualMatchesApproval && headMatches;
}

function parseUnifiedDiffFiles(patch: string): ChangedFileDescriptor[] {
  if (
    /^(?:GIT binary patch|Binary files |diff --cc |diff --combined |@@@ )/mu.test(patch) ||
    /^(?:old mode|new mode|new file mode|deleted file mode) (?:120000|160000)$/mu.test(patch) ||
    /^Subproject commit /mu.test(patch) ||
    /^(?:rename|copy) (?:from|to) /mu.test(patch)
  ) {
    throw new PatchPolicyError('Binary, rename, copy, symlink, submodule, or combined patches are forbidden');
  }

  const lines = patch.split('\n');
  const files: ChangedFileDescriptor[] = [];
  let sectionOpen = false;
  let beforePath: string | null | undefined;
  let afterPath: string | null | undefined;
  let hasHunk = false;

  const finishSection = () => {
    if (!sectionOpen) return;
    if (beforePath === undefined || afterPath === undefined || !hasHunk) {
      throw new PatchPolicyError('Every patch section must be a text diff with at least one hunk');
    }
    files.push({
      beforePath,
      afterPath,
      binary: false,
      generated: false,
      beforeType: beforePath === null ? 'absent' : 'regular',
      afterType: afterPath === null ? 'absent' : 'regular',
    });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishSection();
      if (!/^diff --git a\/.+ b\/.+$/u.test(line) || line.includes('"')) {
        throw new PatchPolicyError('Ambiguous diff header is not supported');
      }
      sectionOpen = true;
      beforePath = undefined;
      afterPath = undefined;
      hasHunk = false;
      continue;
    }
    if (!sectionOpen) {
      if (line.length > 0) {
        throw new PatchPolicyError('Patch contains content outside a git diff section');
      }
      continue;
    }
    if (!hasHunk && line.startsWith('--- ')) {
      if (beforePath !== undefined) throw new PatchPolicyError('Duplicate old-path header');
      beforePath = parsePatchPath(line.slice(4), 'a/');
    } else if (!hasHunk && line.startsWith('+++ ')) {
      if (afterPath !== undefined) throw new PatchPolicyError('Duplicate new-path header');
      afterPath = parsePatchPath(line.slice(4), 'b/');
    } else if (line.startsWith('@@ ')) {
      if (beforePath === undefined || afterPath === undefined) {
        throw new PatchPolicyError('Patch hunk appeared before path headers');
      }
      hasHunk = true;
    }
  }
  finishSection();

  if (files.length === 0 || files.length > MAX_CHANGED_FILES) {
    throw new PatchPolicyError('Patch contains an unsupported number of files');
  }
  const identities = files.map(fileIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new PatchPolicyError('Patch contains duplicate file sections');
  }
  for (const file of files) {
    if (file.beforePath !== null) enforcePathPolicy(file.beforePath);
    if (file.afterPath !== null) enforcePathPolicy(file.afterPath);
  }
  return files;
}

function parsePatchPath(value: string, prefix: 'a/' | 'b/'): string | null {
  if (value === '/dev/null') return null;
  if (!value.startsWith(prefix) || value.includes('"') || value.includes('\t')) {
    throw new PatchPolicyError('Ambiguous patch path is not supported');
  }
  const path = value.slice(prefix.length);
  validateRepositoryPath(path);
  return path;
}

function validateRepositoryPath(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    throw new PatchPolicyError('Unsafe repository path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new PatchPolicyError('Unsafe repository path');
  }
}

function enforcePathPolicy(value: string): void {
  validateRepositoryPath(value);
  const lower = value.toLowerCase();
  const parts = lower.split('/');
  const baseName = parts[parts.length - 1] ?? '';

  if (parts.includes('.git')) {
    throw new PatchPolicyError('Git metadata cannot be changed');
  }
  if (parts.some((part) => PROTECTED_DIRECTORY_NAMES.has(part))) {
    throw new PatchPolicyError('Protected application, deployment, or instruction path');
  }
  if (parts.some((part) => GENERATED_DIRECTORY_NAMES.has(part))) {
    throw new PatchPolicyError('Generated files cannot be changed');
  }
  if (
    AGENT_INSTRUCTION_NAMES.has(baseName) ||
    DEPLOYMENT_FILE_NAMES.has(baseName) ||
    LOCK_FILE_NAMES.has(baseName) ||
    baseName.endsWith('.lock') ||
    baseName.endsWith('.tf') ||
    baseName.endsWith('.tf.json') ||
    /(?:^|[._-])generated(?:[._-]|$)/u.test(baseName) ||
    /\.min\.(?:css|js|mjs|cjs)$/u.test(baseName) ||
    /(?:_pb2\.py|\.pb\.go)$/u.test(baseName)
  ) {
    throw new PatchPolicyError('Generated, lock, deployment, or instruction file cannot be changed');
  }
}

function fileIdentity(file: Pick<ChangedFileDescriptor, 'beforePath' | 'afterPath'>): string {
  return `${file.beforePath ?? ''}\u0000${file.afterPath ?? ''}`;
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  const leftValid = PATCH_DIGEST_PATTERN.test(left);
  const rightValid = PATCH_DIGEST_PATTERN.test(right);
  const leftBytes = leftValid ? Buffer.from(left.slice(7), 'hex') : Buffer.alloc(32);
  const rightBytes = rightValid ? Buffer.from(right.slice(7), 'hex') : Buffer.alloc(32);
  return timingSafeEqual(leftBytes, rightBytes) && leftValid && rightValid;
}

function constantTimeShaEqual(left: string, right: string): boolean {
  const leftValid = CommitShaSchema.safeParse(left).success;
  const rightValid = CommitShaSchema.safeParse(right).success;
  const leftBytes = leftValid ? Buffer.from(left, 'hex') : Buffer.alloc(64);
  const rightBytes = rightValid ? Buffer.from(right, 'hex') : Buffer.alloc(64);
  const width = Math.max(leftBytes.byteLength, rightBytes.byteLength, 64);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftValid && rightValid && left.length === right.length;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
