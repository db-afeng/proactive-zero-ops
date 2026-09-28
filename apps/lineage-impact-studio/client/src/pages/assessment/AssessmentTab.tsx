import {
  Alert,
  AlertDescription,
  AlertTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Separator,
} from '@databricks/appkit-ui/react';
import { CircleAlert, Database, EyeOff, GitBranch, ShieldCheck } from 'lucide-react';

import type { AssessmentViewV1, LineageSegment } from '@/lib/contracts';

export function AssessmentTab({ assessment }: { assessment: AssessmentViewV1 }) {
  return (
    <div className="space-y-6">
      {assessment.source.freshness !== 'current' ? (
        <Alert className="border-warning/50">
          <CircleAlert className="text-warning-foreground" aria-hidden="true" />
          <AlertTitle>
            {assessment.source.freshness === 'stale' ? 'Assessment is stale' : 'Freshness could not be confirmed'}
          </AlertTitle>
          <AlertDescription>
            Re-run the GitHub assessment before using this impact view to make a change.
          </AlertDescription>
        </Alert>
      ) : null}

      {assessment.disclosure.state !== 'full' ? (
        <Alert>
          <EyeOff aria-hidden="true" />
          <AlertTitle>
            {assessment.disclosure.state === 'partial'
              ? 'Some lineage is restricted'
              : 'Lineage details are restricted'}
          </AlertTitle>
          <AlertDescription>{assessment.disclosure.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby="assessment-summary-title" className="space-y-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden="true" />
              <p className="text-xs font-semibold uppercase tracking-wide">Assessment result</p>
            </div>
            <h1 id="assessment-summary-title" className="text-2xl font-semibold tracking-tight">
              {assessment.status === 'block' ? 'Change is blocked for review' : 'Impact review'}
            </h1>
            <p className="max-w-[72ch] text-base leading-7 text-muted-foreground">{assessment.message}</p>
          </section>

          <Separator />

          <section aria-labelledby="lineage-title" className="space-y-4">
            <div>
              <h2 id="lineage-title" className="text-lg font-semibold">
                Accessible lineage
              </h2>
              <p className="mt-1 max-w-[72ch] text-sm leading-6 text-muted-foreground">
                Ordered paths show only objects your Databricks identity can access. Restricted runs are represented
                without names, types, or counts.
              </p>
            </div>

            {assessment.lineagePaths.length === 0 ? (
              <Empty className="min-h-48 border border-border">
                <EmptyHeader>
                  <EmptyMedia>
                    <GitBranch className="size-5 text-muted-foreground" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No lineage path is available</EmptyTitle>
                  <EmptyDescription>
                    The assessment contains no lineage path that can be shown to this viewer.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-6">
                {assessment.lineagePaths.map((path, pathIndex) => (
                  <LineagePath key={`path-${String(pathIndex + 1)}`} index={pathIndex} segments={path.segments} />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="border-t border-border pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <h2 className="text-sm font-semibold">Review context</h2>
          <dl className="mt-4 divide-y divide-border text-sm">
            <MetadataRow label="Viewer" value={assessment.viewer.displayName} />
            <MetadataRow label="Source" value="GitHub pull request" />
            <MetadataRow label="Assessed" value={formatDateTime(assessment.source.createdAt)} />
            <MetadataRow label="Freshness" value={formatFreshness(assessment.source.freshness)} />
            <MetadataRow label="Base commit" value={<CommitValue sha={assessment.pullRequest.baseSha} />} />
            <MetadataRow label="Head commit" value={<CommitValue sha={assessment.pullRequest.headSha} />} />
            <MetadataRow
              label="Reference"
              value={<code className="block break-all font-mono text-xs">{assessment.reference}</code>}
            />
          </dl>
        </aside>
      </div>
    </div>
  );
}

function LineagePath({ index, segments }: { index: number; segments: LineageSegment[] }) {
  return (
    <section aria-labelledby={`path-${String(index + 1)}-title`}>
      <h3
        id={`path-${String(index + 1)}-title`}
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Path {index + 1}
      </h3>
      <ol className="divide-y divide-border border-y border-border">
        {segments.map((segment, segmentIndex) => (
          <li
            key={`${segment.kind}-${String(segmentIndex)}`}
            className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 py-3"
          >
            <span className="pt-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {String(segmentIndex + 1).padStart(2, '0')}
            </span>
            {segment.kind === 'restricted' ? (
              <div className="flex min-w-0 items-center gap-2 border border-dashed border-border bg-muted/40 px-3 py-2">
                <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium">Restricted segment</span>
              </div>
            ) : (
              <div className="flex min-w-0 items-start gap-2 py-2">
                <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <code className="block break-all font-mono text-sm font-medium">{segment.reference}</code>
                  <p className="mt-1 text-xs text-muted-foreground">{formatAssetType(segment.assetType)}</p>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function MetadataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-3 first:pt-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}

function CommitValue({ sha }: { sha: string }) {
  return (
    <code title={sha} className="break-all font-mono text-xs">
      {sha}
    </code>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatFreshness(value: AssessmentViewV1['source']['freshness']) {
  if (value === 'current') return 'Current';
  if (value === 'stale') return 'Stale';
  return 'Unknown';
}

function formatAssetType(value: Extract<LineageSegment, { kind: 'asset' }>['assetType']) {
  const labels: Record<typeof value, string> = {
    table: 'Table',
    view: 'View',
    materialized_view: 'Materialized view',
    streaming_table: 'Streaming table',
    unknown: 'Data object',
  };
  return labels[value];
}
