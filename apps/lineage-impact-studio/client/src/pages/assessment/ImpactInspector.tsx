import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { AlertCircle, ExternalLink, Github, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ScrollFadeArea } from '@/components/ScrollFadeArea';
import { CodeIdentifier, IdentifierText } from '@/components/CodeIdentifier';
import { assessmentIdentifiers } from '@/components/assessment-identifiers';
import { ApiRequestError, getSourceEvidence, githubLoginUrl } from '@/lib/api';
import type { AssessmentGraphEdge, AssessmentImpact, AssessmentViewV3, SourceEvidenceView } from '@/lib/contracts';

import { DatasetSample } from './DatasetSample';
import { isVerifiedBreak, operationLabel, reasonText, targetLabel } from './impact-copy';
import { formatSparkSql, tokenizeSql } from './sql-code';
import { assetUsage, formatCount, formatObservedCount, USAGE_KINDS, type UsageLoadState } from './usage-model';

type SourceState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; evidence: SourceEvidenceView }
  | { kind: 'error'; code?: string; message: string };

export function ImpactInspector({
  assessment,
  usage,
  selectedId,
  onSelect,
  onClose,
}: {
  assessment: AssessmentViewV3;
  usage: UsageLoadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const content = (
    <InspectorContent
      key={selectedId ?? 'none'}
      assessment={assessment}
      usage={usage}
      selectedId={selectedId}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
  if (mobile) {
    return (
      <Sheet open={selectedId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="max-h-[86vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Impact evidence</SheetTitle>
            <SheetDescription>Why this node or relationship is affected and what to fix.</SheetDescription>
          </SheetHeader>
          <div className="-mx-4 mt-5">{content}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside className="hidden min-h-0 border-l border-border bg-background lg:block" aria-label="Impact evidence">
      <ScrollFadeArea className="h-full" ariaLabel="Impact evidence details" testId="impact-inspector-scroll-region">
        {content}
      </ScrollFadeArea>
    </aside>
  );
}

function InspectorContent({
  assessment,
  usage,
  selectedId,
  onSelect,
  onClose,
}: {
  assessment: AssessmentViewV3;
  usage: UsageLoadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<SourceState>({ kind: 'idle' });
  const identifiers = assessmentIdentifiers(assessment);

  if (selectedId === null) {
    return (
      <div className="p-6">
        <h3 className="text-sm font-semibold">Select an impact</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose a graph element or impact-list row to inspect its operation, evidence, and remediation.
        </p>
      </div>
    );
  }

  const node = assessment.graph.nodes.find((candidate) => candidate.id === selectedId);
  const edge = assessment.graph.edges.find((candidate) => candidate.id === selectedId);
  const impact =
    node?.impactId === undefined ? undefined : assessment.impacts.find((item) => item.id === node.impactId);
  const change =
    node?.changeId === undefined ? undefined : assessment.changes.find((item) => item.id === node.changeId);

  if (node?.role === 'restricted') {
    return (
      <div>
        <InspectorHeading badge="Restricted" title="Lineage details are hidden" onClose={onClose} />
        <div className="p-6">
          <p className="text-sm leading-6 text-muted-foreground">
            Your Databricks identity cannot view this lineage run. No asset names, columns, types, or counts are
            exposed.
          </p>
        </div>
      </div>
    );
  }

  if (edge !== undefined) return <EdgeDetails edge={edge} onSelect={onSelect} onClose={onClose} />;
  if (impact !== undefined) {
    return (
      <div>
        <InspectorHeading
          badge={
            impact.relation === 'transitive'
              ? 'Transitive impact'
              : isVerifiedBreak(impact)
                ? 'Direct break'
                : 'Supporting context'
          }
          destructive={impact.relation === 'direct' && isVerifiedBreak(impact)}
          title={targetLabel(impact)}
          subtitle={impact.targetAsset}
          identifier
          onClose={onClose}
        />
        <div className="space-y-5 p-6">
          <p className="text-sm leading-6">{reasonText(impact)}</p>
          <Separator />
          <dl className="space-y-2 text-sm">
            <Detail label="Operation" value={operationLabel(impact.operation)} />
            <Detail
              label="Referenced column"
              value={impact.targetColumn ?? 'Table-level consumer'}
              identifier={impact.targetColumn !== null}
            />
            <Detail label="Impact" value={impact.relation === 'direct' ? 'Direct' : 'Transitive'} />
            <Detail
              label="Evidence"
              value={impact.evidenceLevel === 'definition' ? 'Parsed definition' : 'Verified lineage'}
            />
          </dl>
          <UsageSummary asset={impact.targetAsset} usage={usage} />
          <Remediation impact={impact} />
          <DatasetSample asset={impact.targetAsset} column={impact.targetColumn} kind="impacted" />
          <SourceEvidence assessment={assessment} selectedId={impact.id} source={source} setSource={setSource} />
        </div>
      </div>
    );
  }

  if (change !== undefined) {
    return (
      <div>
        <InspectorHeading
          badge="Proposed change"
          title={change.column}
          subtitle={change.asset}
          identifier
          warning
          onClose={onClose}
        />
        <div className="space-y-5 p-6">
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The output contract changes from {change.beforeType} to {change.afterType}.
          </p>
          <Separator />
          <dl className="space-y-2 text-sm">
            <Detail label="Before" value={change.beforeType} />
            <Detail label="After" value={change.afterType} />
            <Detail label="Change kind" value={change.changeKind} />
          </dl>
          {assessment.impacts.some((impact) => impact.targetAsset === change.asset) ? (
            <UsageSummary asset={change.asset} usage={usage} />
          ) : null}
          <div className="border-l-2 border-foreground pl-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended fix</p>
            <p className="mt-1 text-sm leading-6">
              <IdentifierText text={assessment.recommendedAction} identifiers={identifiers} />
            </p>
          </div>
          <DatasetSample asset={change.asset} column={change.column} kind="changed" />
          <SourceEvidence assessment={assessment} selectedId={change.id} source={source} setSource={setSource} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <Alert>
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Evidence is unavailable</AlertTitle>
        <AlertDescription>Select another graph element.</AlertDescription>
      </Alert>
    </div>
  );
}

function UsageSummary({ asset, usage }: { asset: string; usage: UsageLoadState }) {
  const details = assetUsage(usage, asset);
  const types =
    details === undefined
      ? []
      : USAGE_KINDS.filter(({ kind }) => details.byType[kind] > 0).map(
          ({ kind, plural }) => `${plural} ${formatObservedCount(details.byType[kind], details.complete)}`
        );
  return (
    <section className="space-y-1.5 border-y border-border py-4" aria-label={`Observed usage of ${asset}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Observed consumers</h4>
      {usage.kind === 'loading' ? (
        <div className="space-y-2" role="status" aria-label="Loading observed usage">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-36 max-w-full" />
        </div>
      ) : details === undefined ? (
        <Alert>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Usage unavailable</AlertTitle>
          <AlertDescription>Visible objects observed in the last 30 days could not be loaded.</AlertDescription>
        </Alert>
      ) : details.complete && details.count === 0 ? (
        <Empty className="min-h-24 p-2">
          <EmptyHeader>
            <EmptyTitle>No observed consumers</EmptyTitle>
            <EmptyDescription>No visible objects observed in the last 30 days used this table.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="text-sm font-semibold">
            {details.complete
              ? `${formatCount(details.count)} distinct observed consumers`
              : `Lower bound: ${formatCount(details.count)} observed consumers`}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatObservedCount(details.directCount, details.complete)} direct ·{' '}
            {formatObservedCount(details.indirectCount, details.complete)} indirect
          </p>
          {!details.complete ? (
            <p className="text-xs text-muted-foreground">Coverage incomplete; accessible objects only.</p>
          ) : null}
          {types.length > 0 ? <p className="text-xs text-muted-foreground">{types.join(' · ')}</p> : null}
          <p className="text-xs text-muted-foreground">Counts include visible objects observed in the last 30 days.</p>
          <p className="text-xs text-muted-foreground">
            Linked objects are listed under this table in the Impact list.
          </p>
        </>
      )}
    </section>
  );
}

function InspectorHeading({
  badge,
  destructive = false,
  warning = false,
  title,
  subtitle,
  identifier = false,
  onClose,
}: {
  badge: string;
  destructive?: boolean;
  warning?: boolean;
  title: string;
  subtitle?: string;
  identifier?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="relative border-b border-border p-6 pr-12">
      <Badge
        variant={destructive ? 'destructive' : 'outline'}
        className={warning ? 'border-warning/50 bg-warning/10 text-warning' : undefined}
      >
        {badge}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-4 top-4 hidden lg:inline-flex"
        aria-label="Close impact evidence"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
      <h3 className="mt-3 break-all text-sm font-semibold">{identifier ? <CodeIdentifier value={title} /> : title}</h3>
      {subtitle === undefined ? null : (
        <p className="mt-1 truncate text-xs leading-5 text-muted-foreground" title={subtitle}>
          {identifier ? <CodeIdentifier value={subtitle} /> : subtitle}
        </p>
      )}
    </div>
  );
}

function EdgeDetails({
  edge,
  onSelect,
  onClose,
}: {
  edge: AssessmentGraphEdge;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const authorizedMapping = edge.sourceAsset !== null && edge.targetAsset !== null;
  return (
    <div>
      <InspectorHeading badge="Lineage evidence" title="Verified dependency" onClose={onClose} />
      <div className="space-y-5 p-6">
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This relationship grounds the causal path between the selected change and downstream impact.
        </p>
        <Separator />
        <dl className="space-y-2 text-sm">
          {authorizedMapping ? (
            <>
              <Detail
                label="Source mapping"
                value={`${edge.sourceAsset}${edge.sourceColumn === null ? '' : `.${edge.sourceColumn}`}`}
                identifier
              />
              <Detail
                label="Target mapping"
                value={`${edge.targetAsset}${edge.targetColumn === null ? '' : `.${edge.targetColumn}`}`}
                identifier
              />
            </>
          ) : null}
          <Detail label="Origin" value={formatOrigin(edge.origin)} />
          <Detail
            label="Specificity"
            value={edge.evidenceLevel === 'table' ? 'Table only — less specific' : edge.evidenceLevel}
          />
          <Detail
            label="Last observed"
            value={edge.lastObservedAt === null ? 'Not observed; proposed code' : formatDateTime(edge.lastObservedAt)}
          />
        </dl>
        {authorizedMapping && edge.target.startsWith('impact-') ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onSelect(edge.target)}>
            Open downstream sample
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SourceEvidence({
  assessment,
  selectedId,
  source,
  setSource,
}: {
  assessment: AssessmentViewV3;
  selectedId: string;
  source: SourceState;
  setSource: (value: SourceState) => void;
}) {
  const selectedChange =
    source.kind === 'ready' ? source.evidence.changes.find((item) => item.id === selectedId) : undefined;
  const selectedImpact =
    source.kind === 'ready' ? source.evidence.impacts.find((item) => item.id === selectedId) : undefined;
  const expression = selectedImpact?.targetExpression;
  const identifiers = assessmentIdentifiers(assessment);

  if (source.kind === 'idle') {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setSource({ kind: 'loading' });
          void getSourceEvidence(assessment.reference)
            .then((evidence) => setSource({ kind: 'ready', evidence }))
            .catch((error: unknown) =>
              setSource({
                kind: 'error',
                code: error instanceof ApiRequestError ? error.code : undefined,
                message: error instanceof Error ? error.message : 'Source evidence could not be loaded.',
              })
            );
        }}
      >
        <Github aria-hidden="true" />
        Authorize exact source evidence
      </Button>
    );
  }
  if (source.kind === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Verifying repository access and pull request revisions…
      </p>
    );
  }
  if (source.kind === 'error') {
    const disconnected = source.code === 'GITHUB_DISCONNECTED';
    return (
      <Alert variant={source.code === 'STALE_PULL_REQUEST' ? 'destructive' : 'default'}>
        <AlertCircle aria-hidden="true" />
        <AlertTitle>
          {source.code === 'STALE_PULL_REQUEST' ? 'Pull request has changed' : 'Source evidence is locked'}
        </AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{source.message}</p>
          {disconnected ? (
            <Button asChild size="sm" variant="outline">
              <a href={githubLoginUrl(`${window.location.pathname}${window.location.hash}`)}>Connect GitHub</a>
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Authorized source</p>
        <a
          href={source.evidence.pullRequestFilesUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
        >
          PR files <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
      {selectedChange !== undefined ? (
        <div className="space-y-3">
          {selectedChange.filePath !== null ? (
            <div className="flex items-start justify-between gap-3">
              <code className="block break-all text-xs">{selectedChange.filePath}</code>
              {selectedChange.diffUrl !== null ? (
                <a
                  href={selectedChange.diffUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-medium underline underline-offset-4"
                >
                  Open diff <ExternalLink className="size-3" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          ) : null}
          <Expression label="Before" value={selectedChange.beforeExpression} identifiers={identifiers} />
          <Expression label="After" value={selectedChange.afterExpression} identifiers={identifiers} />
        </div>
      ) : null}
      {selectedImpact !== undefined ? (
        <Expression label="Downstream expression" value={expression ?? null} identifiers={identifiers} />
      ) : null}
      {selectedChange === undefined && selectedImpact === undefined ? (
        <p className="text-sm text-muted-foreground">No exact expression is available for this item.</p>
      ) : null}
    </div>
  );
}

function Expression({ label, value, identifiers }: { label: string; value: string | null; identifiers: string[] }) {
  const formatted = value === null ? 'Not available' : formatSparkSql(value);
  const tokens = value === null ? [{ value: formatted, kind: 'plain' as const }] : tokenizeSql(formatted);
  const knownIdentifiers = new Set(identifiers.map((identifier) => identifier.toLowerCase()));
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        {value === null ? null : (
          <Badge variant="outline" className="font-mono text-[11px] font-normal">
            SQL
          </Badge>
        )}
      </div>
      <pre
        className="sql-code mt-1 max-h-56 overflow-auto border border-border p-3 font-mono text-xs leading-5"
        aria-label={value === null ? label : `${label} SQL`}
        data-language={value === null ? undefined : 'spark-sql'}
        tabIndex={value === null ? undefined : 0}
      >
        <code>
          {tokens.map((token, index) => {
            const name = token.value.replace(/^([`"])(.*)\1$/, '$2').toLowerCase();
            const identifier = token.kind === 'identifier' || knownIdentifiers.has(name);
            return (
              <span
                key={`${String(index)}-${token.value}`}
                className={identifier ? 'identifier-code' : `sql-token-${token.kind}`}
              >
                {token.value}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

function Remediation({ impact }: { impact: AssessmentImpact }) {
  const messages: Record<AssessmentImpact['remediation'], string> = {
    restore_contract:
      'Restore the previous output contract and move formatting to a separate presentation column or layer.',
    add_compatibility_column:
      'Keep the existing column compatible and add the new representation under a separate column name.',
    update_consumers: 'Update every verified direct consumer to handle the new contract, then re-run the assessment.',
    reassess: 'Resolve the evidence limitation and re-run the assessment before merging.',
  };
  return (
    <div className="border-l-2 border-foreground pl-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended fix</p>
      <p className="mt-1 text-sm leading-6">{messages[impact.remediation]}</p>
    </div>
  );
}

function Detail({ label, value, identifier = false }: { label: string; value: string; identifier?: boolean }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{identifier ? <CodeIdentifier value={value} /> : value}</dd>
    </div>
  );
}

function formatOrigin(value: AssessmentGraphEdge['origin']) {
  if (value === 'observed_lineage') return 'Observed lineage';
  if (value === 'proposed_code') return 'Proposed-code lineage';
  if (value === 'unknown') return 'Restricted evidence';
  return 'Observed and proposed-code lineage';
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}
