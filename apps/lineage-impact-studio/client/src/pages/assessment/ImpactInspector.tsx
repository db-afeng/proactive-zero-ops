import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@databricks/appkit-ui/react';
import { AlertCircle, ExternalLink, Github, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ApiRequestError, getSourceEvidence, githubLoginUrl } from '@/lib/api';
import type { AssessmentGraphEdge, AssessmentImpact, AssessmentViewV2, SourceEvidenceView } from '@/lib/contracts';

import { isVerifiedBreak, operationLabel, reasonText, targetLabel } from './impact-copy';

type SourceState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; evidence: SourceEvidenceView }
  | { kind: 'error'; code?: string; message: string };

export function ImpactInspector({
  assessment,
  selectedId,
  onClose,
}: {
  assessment: AssessmentViewV2;
  selectedId: string | null;
  onClose: () => void;
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const content = <InspectorContent key={selectedId ?? 'none'} assessment={assessment} selectedId={selectedId} />;
  if (mobile) {
    return (
      <Sheet open={selectedId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="max-h-[86vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Impact evidence</SheetTitle>
            <SheetDescription>Why this node or relationship is affected and what to fix.</SheetDescription>
          </SheetHeader>
          <div className="mt-5">{content}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return <aside className="min-h-[32rem] border-l border-border pl-6">{content}</aside>;
}

function InspectorContent({ assessment, selectedId }: { assessment: AssessmentViewV2; selectedId: string | null }) {
  const [source, setSource] = useState<SourceState>({ kind: 'idle' });

  if (selectedId === null) {
    return (
      <div className="pt-2">
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
      <div className="space-y-3 pt-2">
        <Badge variant="outline">Restricted</Badge>
        <h3 className="text-base font-semibold">Lineage details are hidden</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Your Databricks identity cannot view this lineage run. No asset names, columns, types, or counts are exposed.
        </p>
      </div>
    );
  }

  if (edge !== undefined) return <EdgeDetails edge={edge} />;
  if (impact !== undefined) {
    return (
      <div className="space-y-5 pt-2">
        <div>
          <Badge variant={impact.relation === 'direct' && isVerifiedBreak(impact) ? 'destructive' : 'outline'}>
            {impact.relation === 'transitive'
              ? 'Transitive impact'
              : isVerifiedBreak(impact)
                ? 'Direct break'
                : 'Supporting context'}
          </Badge>
          <h3 className="mt-3 break-all font-mono text-sm font-semibold">{targetLabel(impact)}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{reasonText(impact)}</p>
        </div>
        <Separator />
        <dl className="space-y-3 text-sm">
          <Detail label="Operation" value={operationLabel(impact.operation)} />
          <Detail label="Referenced column" value={impact.targetColumn ?? 'Table-level consumer'} mono />
          <Detail label="Impact" value={impact.relation === 'direct' ? 'Direct' : 'Transitive'} />
          <Detail
            label="Evidence"
            value={impact.evidenceLevel === 'definition' ? 'Parsed definition' : 'Verified lineage'}
          />
        </dl>
        <Remediation impact={impact} />
        <SourceEvidence assessment={assessment} selectedId={impact.id} source={source} setSource={setSource} />
      </div>
    );
  }

  if (change !== undefined) {
    return (
      <div className="space-y-5 pt-2">
        <div>
          <Badge className="border-warning/50 bg-warning/10 text-warning-foreground" variant="outline">
            Proposed change
          </Badge>
          <h3 className="mt-3 break-all font-mono text-sm font-semibold">{`${change.asset}.${change.column}`}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The output contract changes from {change.beforeType} to {change.afterType}.
          </p>
        </div>
        <Separator />
        <dl className="space-y-3 text-sm">
          <Detail label="Before" value={change.beforeType} />
          <Detail label="After" value={change.afterType} />
          <Detail label="Change kind" value={change.changeKind} />
        </dl>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended fix</p>
          <p className="mt-1 text-sm leading-6">{assessment.recommendedAction}</p>
        </div>
        <SourceEvidence assessment={assessment} selectedId={change.id} source={source} setSource={setSource} />
      </div>
    );
  }

  return (
    <Alert>
      <AlertCircle aria-hidden="true" />
      <AlertTitle>Evidence is unavailable</AlertTitle>
      <AlertDescription>Select another graph element.</AlertDescription>
    </Alert>
  );
}

function EdgeDetails({ edge }: { edge: AssessmentGraphEdge }) {
  return (
    <div className="space-y-5 pt-2">
      <div>
        <Badge variant="outline">Lineage evidence</Badge>
        <h3 className="mt-3 text-base font-semibold">Verified dependency</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This relationship grounds the causal path between the selected change and downstream impact.
        </p>
      </div>
      <Separator />
      <dl className="space-y-3 text-sm">
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
    </div>
  );
}

function SourceEvidence({
  assessment,
  selectedId,
  source,
  setSource,
}: {
  assessment: AssessmentViewV2;
  selectedId: string;
  source: SourceState;
  setSource: (value: SourceState) => void;
}) {
  const selectedChange =
    source.kind === 'ready' ? source.evidence.changes.find((item) => item.id === selectedId) : undefined;
  const selectedImpact =
    source.kind === 'ready' ? source.evidence.impacts.find((item) => item.id === selectedId) : undefined;
  const expression = selectedImpact?.targetExpression;

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
          <Expression label="Before" value={selectedChange.beforeExpression} />
          <Expression label="After" value={selectedChange.afterExpression} />
        </div>
      ) : null}
      {selectedImpact !== undefined ? <Expression label="Downstream expression" value={expression ?? null} /> : null}
      {selectedChange === undefined && selectedImpact === undefined ? (
        <p className="text-sm text-muted-foreground">No exact expression is available for this item.</p>
      ) : null}
    </div>
  );
}

function Expression({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted/30 p-3 font-mono text-xs leading-5">
        {value ?? 'Not available'}
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
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended fix</p>
      <p className="mt-1 text-sm leading-6">{messages[impact.remediation]}</p>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words font-medium ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
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
