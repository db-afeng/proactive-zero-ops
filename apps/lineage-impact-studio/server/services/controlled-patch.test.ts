import { describe, expect, it } from 'vitest';

import type { CommitGateInput } from '../security/patch-policy';
import { buildControlledPatch, reviewFilesFromControlledPatch, type FixFileSnapshot } from './controlled-patch';

const gate: CommitGateInput = {
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

describe('controlled Omnigent patch serialization', () => {
  it.each<[string, FixFileSnapshot, object]>([
    [
      'addition',
      { path: 'src/new.sql', before: null, after: 'select 1\n' },
      { status: 'added', original: '', modified: 'select 1\n' },
    ],
    [
      'modification',
      { path: 'src/model.sql', before: 'select 1\n', after: 'select 2\n' },
      { status: 'modified', original: 'select 1\n', modified: 'select 2\n' },
    ],
    [
      'deletion',
      { path: 'src/old.sql', before: 'select 1\n', after: null },
      { status: 'deleted', original: 'select 1\n', modified: '' },
    ],
    [
      'new trailing newline',
      { path: 'src/newline.sql', before: 'select 1', after: 'select 1\n' },
      { status: 'modified', original: 'select 1', modified: 'select 1\n' },
    ],
    [
      'removed trailing newline',
      { path: 'src/no-newline.sql', before: 'select 1\n', after: 'select 1' },
      { status: 'modified', original: 'select 1\n', modified: 'select 1' },
    ],
  ])('round-trips a full-file %s', (_label, snapshot, expected) => {
    const patch = buildControlledPatch(gate, [snapshot]);
    const review = reviewFilesFromControlledPatch(patch.bytes, patch.files);

    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject(expected);
    expect(patch.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects duplicate and protected paths before persistence', () => {
    expect(() =>
      buildControlledPatch(gate, [
        { path: 'src/model.sql', before: 'one\n', after: 'two\n' },
        { path: 'src/model.sql', before: 'two\n', after: 'three\n' },
      ])
    ).toThrow('duplicate_file');
    expect(() =>
      buildControlledPatch(gate, [{ path: '.github/workflows/release.yml', before: 'one\n', after: 'two\n' }])
    ).toThrow();
  });
});
