import {
  RepositoryPathSchema,
  validatePatchCandidate,
  type ChangedFileDescriptor,
  type CommitGateInput,
  type ValidatedPatch,
} from '../security/patch-policy';

export interface FixFileSnapshot {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ReviewPatchFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  original: string;
  modified: string;
  language: string;
}

/**
 * Builds a deliberately simple full-file unified diff. Omnigent supplies the
 * before/after snapshots; this server, not the agent, owns patch serialization.
 */
export function buildControlledPatch(gate: CommitGateInput, rawFiles: FixFileSnapshot[]): ValidatedPatch {
  if (rawFiles.length === 0 || rawFiles.length > 50) throw new Error('unsupported_file_count');
  const seen = new Set<string>();
  const descriptors: ChangedFileDescriptor[] = [];
  const sections: string[] = [];

  for (const raw of rawFiles) {
    const path = RepositoryPathSchema.parse(raw.path);
    if (seen.has(path)) throw new Error('duplicate_file');
    seen.add(path);
    if (raw.before === null && raw.after === null) throw new Error('empty_change');
    if (raw.before !== null && raw.after !== null && raw.before === raw.after) throw new Error('unchanged_file');
    const descriptor: ChangedFileDescriptor = {
      beforePath: raw.before === null ? null : path,
      afterPath: raw.after === null ? null : path,
      binary: false,
      generated: false,
      beforeType: raw.before === null ? 'absent' : 'regular',
      afterType: raw.after === null ? 'absent' : 'regular',
    };
    descriptors.push(descriptor);
    sections.push(renderSection(path, raw.before, raw.after));
  }

  return validatePatchCandidate({ gate, files: descriptors, patch: `${sections.join('')}\n` });
}

/** Rehydrates the controlled full-file diff for the browser review surface. */
export function reviewFilesFromControlledPatch(
  bytes: Uint8Array,
  descriptors: ChangedFileDescriptor[]
): ReviewPatchFile[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sections = splitSections(text);
  if (sections.length !== descriptors.length) throw new Error('invalid_controlled_patch');
  const descriptorByPath = new Map(
    descriptors.map((descriptor) => [descriptor.afterPath ?? descriptor.beforePath, descriptor] as const)
  );
  const files: ReviewPatchFile[] = [];
  for (const section of sections) {
    const descriptor = descriptorByPath.get(section.path);
    if (descriptor === undefined) throw new Error('invalid_controlled_patch');
    const original = renderContent(section.beforeLines, section.beforeEndsWithNewline);
    const modified = renderContent(section.afterLines, section.afterEndsWithNewline);
    files.push({
      path: section.path,
      status: descriptor.beforePath === null ? 'added' : descriptor.afterPath === null ? 'deleted' : 'modified',
      additions: contentLineCount(modified),
      deletions: contentLineCount(original),
      original,
      modified,
      language: languageForPath(section.path),
    });
  }
  return files;
}

function renderSection(path: string, before: string | null, after: string | null): string {
  const beforeContent = splitContent(before ?? '');
  const afterContent = splitContent(after ?? '');
  const encodedAfterLines = [...afterContent.lines];
  // The commit applier initializes target newline state from the original.
  // An empty final addition preserves a newly introduced trailing newline.
  if (before !== null && !beforeContent.endsWithNewline && afterContent.endsWithNewline) {
    encodedAfterLines.push('');
  }
  const oldStart = beforeContent.lines.length === 0 ? 0 : 1;
  const newStart = encodedAfterLines.length === 0 ? 0 : 1;
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
    `@@ -${String(oldStart)},${String(beforeContent.lines.length)} +${String(newStart)},${String(encodedAfterLines.length)} @@`,
  ];
  for (const line of beforeContent.lines) lines.push(`-${line}`);
  if (before !== null && before.length > 0 && !beforeContent.endsWithNewline) {
    lines.push('\\ No newline at end of file');
  }
  for (const line of encodedAfterLines) lines.push(`+${line}`);
  if (after !== null && after.length > 0 && !afterContent.endsWithNewline) {
    lines.push('\\ No newline at end of file');
  }
  return `${lines.join('\n')}\n`;
}

function splitContent(value: string): { lines: string[]; endsWithNewline: boolean } {
  if (value.length === 0) return { lines: [], endsWithNewline: false };
  const endsWithNewline = value.endsWith('\n');
  const lines = value.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

interface ParsedControlledSection {
  path: string;
  beforeLines: string[];
  afterLines: string[];
  beforeEndsWithNewline: boolean;
  afterEndsWithNewline: boolean;
}

function splitSections(text: string): ParsedControlledSection[] {
  const rawSections = text.split(/(?=^diff --git )/mu).filter((section) => section.trim().length > 0);
  return rawSections.map((raw) => {
    const lines = raw.split('\n');
    const oldHeader = lines.find((line) => line.startsWith('--- '));
    const newHeader = lines.find((line) => line.startsWith('+++ '));
    if (oldHeader === undefined || newHeader === undefined) throw new Error('invalid_controlled_patch');
    const beforePath = controlledHeaderPath(oldHeader.slice(4), 'a/');
    const afterPath = controlledHeaderPath(newHeader.slice(4), 'b/');
    const path = afterPath ?? beforePath;
    if (path === null) throw new Error('invalid_controlled_patch');
    const hunkIndex = lines.findIndex((line) => line.startsWith('@@ '));
    if (hunkIndex < 0) throw new Error('invalid_controlled_patch');
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    let beforeEndsWithNewline = beforePath !== null;
    let afterEndsWithNewline = afterPath !== null;
    let lastPrefix: '-' | '+' | null = null;
    for (const line of lines.slice(hunkIndex + 1)) {
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('-')) {
        beforeLines.push(line.slice(1));
        lastPrefix = '-';
      } else if (line.startsWith('+')) {
        afterLines.push(line.slice(1));
        lastPrefix = '+';
      } else if (line === '\\ No newline at end of file') {
        if (lastPrefix === '-') beforeEndsWithNewline = false;
        if (lastPrefix === '+') afterEndsWithNewline = false;
      } else if (line.length > 0) {
        throw new Error('invalid_controlled_patch');
      }
    }
    // Remove the serializer's newline-transition sentinel.
    if (!beforeEndsWithNewline && afterEndsWithNewline && afterLines[afterLines.length - 1] === '') afterLines.pop();
    if (beforeLines.length === 0) beforeEndsWithNewline = false;
    if (afterLines.length === 0) afterEndsWithNewline = false;
    return { path, beforeLines, afterLines, beforeEndsWithNewline, afterEndsWithNewline };
  });
}

function controlledHeaderPath(value: string, prefix: 'a/' | 'b/'): string | null {
  if (value === '/dev/null') return null;
  if (!value.startsWith(prefix)) throw new Error('invalid_controlled_patch');
  return RepositoryPathSchema.parse(value.slice(prefix.length));
}

function renderContent(lines: string[], endsWithNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`;
}

function contentLineCount(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split('\n').length;
  return value.endsWith('\n') ? lines - 1 : lines;
}

function languageForPath(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  const languages: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scala: 'scala',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return languages[extension] ?? 'plaintext';
}
