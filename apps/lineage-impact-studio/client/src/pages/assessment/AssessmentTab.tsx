import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';
import { Check, ChevronDown, CircleAlert, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ScrollFadeArea } from '@/components/ScrollFadeArea';
import { getAssessmentUsage } from '@/lib/api';
import type { AssessmentViewV3 } from '@/lib/contracts';

import { ImpactGraph } from './ImpactGraph';
import { ImpactInspector } from './ImpactInspector';
import { ImpactList } from './ImpactList';
import type { UsageLoadState } from './usage-model';

type ImpactScope = 'direct' | 'all';

export function AssessmentTab({ assessment }: { assessment: AssessmentViewV3 }) {
  const [scope, setScope] = useState<ImpactScope>('all');
  const [showContext, setShowContext] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageLoadState>({ kind: 'loading' });
  const [usageRetryToken, setUsageRetryToken] = useState(0);

  useEffect(() => {
    if (assessment.detailState === 'legacy') return;
    const controller = new AbortController();
    void getAssessmentUsage(assessment.reference, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setUsage(
          result.assessmentReference === assessment.reference ? { kind: 'ready', usage: result } : { kind: 'error' }
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsage({ kind: 'error' });
      });
    return () => controller.abort();
  }, [assessment.detailState, assessment.reference, usageRetryToken]);

  function selectGraphElement(id: string) {
    setSelectedId(id);
    const asset = assessment.graph.nodes.find((node) => node.id === id)?.asset;
    setExpandedAsset(
      asset !== undefined && assessment.impacts.some((impact) => impact.targetAsset === asset) ? asset : null
    );
  }

  function expandAsset(asset: string, open: boolean) {
    setExpandedAsset(open ? asset : null);
    setSelectedId(null);
  }

  const visible = useMemo(() => {
    const nodes = assessment.graph.nodes.filter((node) => {
      if (scope === 'direct' && node.role === 'transitive_impact') return false;
      if (!showContext && node.role === 'context') return false;
      return true;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: assessment.graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      impacts: assessment.impacts.filter(
        (impact) => nodeIds.has(`impact-${impact.id}`) && (scope === 'all' || impact.relation === 'direct')
      ),
    };
  }, [assessment, scope, showContext]);

  if (assessment.detailState === 'legacy') return <LegacyAssessment assessment={assessment} />;

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      {assessment.source.freshness !== 'current' ? (
        <Alert className="m-4 shrink-0 border-warning/50 md:mx-6">
          <CircleAlert className="text-warning" aria-hidden="true" />
          <AlertTitle>
            {assessment.source.freshness === 'stale' ? 'Assessment is stale' : 'Freshness could not be confirmed'}
          </AlertTitle>
          <AlertDescription>Re-run the assessment before relying on this impact decision.</AlertDescription>
        </Alert>
      ) : null}

      <section
        aria-labelledby="assessment-summary-title"
        className="shrink-0 border-b border-border px-4 py-3 md:px-6 lg:grid lg:min-h-44 lg:grid-cols-[minmax(0,1fr)_26.5rem]"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={assessment.status === 'block' || assessment.status === 'error' ? 'destructive' : 'outline'}
              className="px-2.5"
            >
              {assessment.status.toUpperCase()}
            </Badge>
            <Badge variant="outline" className="px-2.5 font-normal">
              {formatSeverity(assessment.severity)} severity
            </Badge>
            {assessment.disclosure.state !== 'full' ? (
              <>
                <Badge variant="outline" className="px-2.5 font-normal">
                  {assessment.disclosure.state === 'partial' ? 'Partial lineage' : 'Restricted lineage'}
                </Badge>
                <span className="sr-only">
                  {assessment.disclosure.state === 'partial'
                    ? 'Some lineage is restricted'
                    : 'Lineage details are restricted'}
                </span>
              </>
            ) : null}
          </div>
          <h1
            id="assessment-summary-title"
            className="mt-3 max-w-[58rem] font-mono text-2xl font-semibold leading-tight tracking-tight"
          >
            {assessment.headline}
          </h1>

          <dl className="mt-3 flex flex-wrap gap-x-10 gap-y-3 text-sm">
            <SummaryFact label="Discovery certainty" value={formatDiscovery(assessment.confidence.discovery)} />
            <SummaryFact
              label="Freshness"
              value={`${formatFreshness(assessment.source.freshness)} · ${formatDateTime(assessment.source.createdAt)}`}
            />
          </dl>
        </div>

        <div className="mt-5 border-l-2 border-foreground pl-4 lg:ml-8 lg:mt-0 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recommended action</p>
          <p className="mt-2 text-sm leading-6">{assessment.recommendedAction}</p>
        </div>
      </section>

      <div className="lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_26.5rem]">
        <ScrollFadeArea
          className="min-w-0"
          viewportClassName="space-y-6 px-4 py-4 md:px-6 lg:py-3"
          ariaLabel="Assessment impact content"
          testId="assessment-scroll-region"
        >
          <section aria-labelledby="impact-map-title" className="space-y-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 id="impact-map-title" className="text-base font-semibold">
                Causal impact map
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={scope}
                  onValueChange={(value) => {
                    if (value === 'direct' || value === 'all') setScope(value);
                  }}
                >
                  <SelectTrigger className="w-44" aria-label="Impact scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Direct + transitive</SelectItem>
                    <SelectItem value="direct">Direct breaks only</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={showContext}
                  onClick={() => setShowContext((value) => !value)}
                >
                  <span className="flex size-3.5 items-center justify-center rounded-[2px] border border-border">
                    {showContext ? <Check className="size-3" aria-hidden="true" /> : null}
                  </span>
                  {showContext ? 'Hide context' : 'Show context'}
                </Button>
              </div>
            </div>

            {visible.nodes.length === 0 ? (
              <Empty className="min-h-52 border border-border">
                <EmptyHeader>
                  <EmptyTitle>No verified causal graph is available</EmptyTitle>
                  <EmptyDescription>
                    Re-run the assessment if this change should have downstream consumers.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="hidden md:block">
                  <ImpactGraph
                    nodes={visible.nodes}
                    edges={visible.edges}
                    impacts={assessment.impacts}
                    changes={assessment.changes}
                    usage={usage}
                    selectedId={selectedId}
                    onSelect={selectGraphElement}
                  />
                </div>
                <p className="text-sm text-muted-foreground md:hidden">Select an impact below to open its evidence.</p>
              </>
            )}
          </section>

          <section aria-labelledby="impact-list-title" className="space-y-3">
            <h2 id="impact-list-title" className="text-base font-semibold">
              Impact list
            </h2>
            <ImpactList
              impacts={visible.impacts}
              usage={usage}
              selectedId={selectedId}
              expandedAsset={expandedAsset}
              onSelect={selectGraphElement}
              onExpandAsset={expandAsset}
              onRetryUsage={() => {
                setUsage({ kind: 'loading' });
                setUsageRetryToken((value) => value + 1);
              }}
            />
          </section>

          <ReviewContext assessment={assessment} />
        </ScrollFadeArea>

        <ImpactInspector
          assessment={assessment}
          usage={usage}
          selectedId={selectedId}
          onSelect={selectGraphElement}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  );
}

function LegacyAssessment({ assessment }: { assessment: AssessmentViewV3 }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6">
      <Alert>
        <RotateCw aria-hidden="true" />
        <AlertTitle>{assessment.headline}</AlertTitle>
        <AlertDescription className="mt-2 space-y-2">
          <p>{assessment.recommendedAction}</p>
          <p>No lineage or explanation was reconstructed from legacy free-form evidence.</p>
        </AlertDescription>
      </Alert>
      <ReviewContext assessment={assessment} />
    </div>
  );
}

function ReviewContext({ assessment }: { assessment: AssessmentViewV3 }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="px-0" type="button">
          <ChevronDown aria-hidden="true" />
          Review context
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-3 grid gap-x-8 gap-y-4 border-t border-border pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Metadata label="Viewer" value={assessment.viewer.displayName} />
          <Metadata label="Assessed" value={formatDateTime(assessment.source.createdAt)} />
          <Metadata label="Repository" value={assessment.pullRequest.repository} mono />
          <Metadata label="Base commit" value={assessment.pullRequest.baseSha} mono />
          <Metadata label="Head commit" value={assessment.pullRequest.headSha} mono />
          <Metadata label="Assessment reference" value={assessment.reference} mono />
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

function Metadata({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all font-medium ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function formatSeverity(value: AssessmentViewV3['severity']) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDiscovery(value: AssessmentViewV3['confidence']['discovery']) {
  if (value === 'complete') return 'Complete';
  if (value === 'incomplete') return 'Incomplete';
  return 'Unknown';
}

function formatFreshness(value: AssessmentViewV3['source']['freshness']) {
  if (value === 'current') return 'Current';
  if (value === 'stale') return 'Stale';
  return 'Unknown';
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
