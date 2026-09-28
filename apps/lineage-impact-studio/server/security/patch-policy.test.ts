import { describe, expect, it } from 'vitest';

import { PatchPolicyError, computePatchDigest, validatePatchCandidate, verifyPatchApproval } from './patch-policy';

const SAFE_PATH = 'src/credit_risk/transformations/silver/exposure.sql';

function gate() {
  return {
    baseRepository: 'db-afeng/proactive-zero-ops',
    headRepository: 'db-afeng/proactive-zero-ops',
    isFork: false,
    pullRequestState: 'open',
    canPush: true,
    force: false,
    commitStrategy: 'normal',
    expectedHeadSha: 'a'.repeat(40),
    observedHeadSha: 'a'.repeat(40),
  };
}

function file(path = SAFE_PATH) {
  return {
    beforePath: path,
    afterPath: path,
    binary: false,
    generated: false,
    beforeType: 'regular',
    afterType: 'regular',
  };
}

function patch(path = SAFE_PATH) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-SELECT old_value',
    '+SELECT new_value',
    '',
  ].join('\n');
}

describe('patch and commit safety policy', () => {
  it('accepts a small text patch for the exact same-repository open PR head', () => {
    const candidate = validatePatchCandidate({ gate: gate(), files: [file()], patch: patch() });
    expect(candidate.digest).toBe(computePatchDigest(patch()));
    expect(candidate.files).toHaveLength(1);
  });

  it.each([
    ['fork flag', { isFork: true }],
    ['fork repository', { headRepository: 'attacker/fork' }],
    ['force update', { force: true }],
    ['non-normal strategy', { commitStrategy: 'force' }],
    ['closed PR', { pullRequestState: 'closed' }],
    ['removed write permission', { canPush: false }],
    ['stale head', { observedHeadSha: 'b'.repeat(40) }],
  ])('rejects %s at the commit-gate input boundary', (_label, change) => {
    expect(() => validatePatchCandidate({ gate: { ...gate(), ...change }, files: [file()], patch: patch() })).toThrow(
      PatchPolicyError
    );
  });

  it.each([
    '.github/workflows/release.yml',
    'apps/other-app/server.ts',
    'resources/job.yml',
    'infra/main.tf',
    'databricks.yml',
    'AGENTS.md',
    '.codex/instructions.md',
    'package-lock.json',
    'client/dist/app.js',
    'src/client.generated.ts',
    '../outside.sql',
    '/absolute.sql',
  ])('rejects protected, generated, lock, instruction, or unsafe path %j', (path) => {
    expect(() => validatePatchCandidate({ gate: gate(), files: [file(path)], patch: patch(path) })).toThrow(
      PatchPolicyError
    );
  });

  it('rejects binary, generated, symlink, submodule, and undeclared patch changes', () => {
    expect(() =>
      validatePatchCandidate({
        gate: gate(),
        files: [{ ...file(), binary: true }],
        patch: patch(),
      })
    ).toThrow(PatchPolicyError);
    expect(() =>
      validatePatchCandidate({
        gate: gate(),
        files: [{ ...file(), generated: true }],
        patch: patch(),
      })
    ).toThrow(PatchPolicyError);
    expect(() =>
      validatePatchCandidate({
        gate: gate(),
        files: [{ ...file(), afterType: 'symlink' }],
        patch: patch(),
      })
    ).toThrow(PatchPolicyError);
    expect(() => validatePatchCandidate({ gate: gate(), files: [file('src/other.sql')], patch: patch() })).toThrow(
      PatchPolicyError
    );
    expect(() =>
      validatePatchCandidate({
        gate: gate(),
        files: [file()],
        patch: `${patch()}GIT binary patch\nliteral 1\nA`,
      })
    ).toThrow(PatchPolicyError);
    expect(() =>
      validatePatchCandidate({
        gate: gate(),
        files: [file()],
        patch: patch().replace('index 1111111..2222222 100644', 'new file mode 120000'),
      })
    ).toThrow(PatchPolicyError);
  });

  it('rejects rename metadata and duplicate sections, but handles path-like hunk content', () => {
    const rename = patch().replace(
      'index 1111111..2222222 100644',
      `similarity index 90%\nrename from ${SAFE_PATH}\nrename to src/renamed.sql`
    );
    expect(() => validatePatchCandidate({ gate: gate(), files: [file()], patch: rename })).toThrow(PatchPolicyError);
    expect(() => validatePatchCandidate({ gate: gate(), files: [file(), file()], patch: patch() + patch() })).toThrow(
      PatchPolicyError
    );

    const pathLikeContent = patch().replace('-SELECT old_value', '--- looks-like-an-old-path');
    expect(() => validatePatchCandidate({ gate: gate(), files: [file()], patch: pathLikeContent })).not.toThrow();
  });

  it('verifies the exact approved bytes, digest, and head together', () => {
    const approvedPatch = patch();
    const digest = computePatchDigest(approvedPatch);
    expect(
      verifyPatchApproval({
        patch: approvedPatch,
        requestedPatchDigest: digest,
        approvedPatchDigest: digest,
        expectedHeadSha: 'a'.repeat(40),
        approvedHeadSha: 'a'.repeat(40),
      })
    ).toBe(true);
    expect(
      verifyPatchApproval({
        patch: `${approvedPatch}\n`,
        requestedPatchDigest: digest,
        approvedPatchDigest: digest,
        expectedHeadSha: 'a'.repeat(40),
        approvedHeadSha: 'a'.repeat(40),
      })
    ).toBe(false);
    expect(
      verifyPatchApproval({
        patch: approvedPatch,
        requestedPatchDigest: digest,
        approvedPatchDigest: digest,
        expectedHeadSha: 'b'.repeat(40),
        approvedHeadSha: 'a'.repeat(40),
      })
    ).toBe(false);
  });
});
