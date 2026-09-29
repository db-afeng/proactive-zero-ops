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
  Separator,
} from '@databricks/appkit-ui/react';
import { ChevronDown, CircleAlert, EyeOff, Info, Layers3, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AssessmentViewV3 } from '@/lib/contracts';

import { ImpactGraph } from './ImpactGraph';
import { ImpactInspector } from './ImpactInspector';
import { ImpactList } from './ImpactList';

type ImpactScope = 'direct' | 'all';

export function AssessmentTab({ assessment }: { assessment: AssessmentViewV3 }) {
  const [scope, setScope] = useState<ImpactScope>('all');
  const [showContext, setShowContext] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    <div className="space-y-8">
      {assessment.source.freshness !== 'current' ? (
        <Alert className="border-warning/50">
          <CircleAlert className="text-warning-foreground" aria-hidden="true" />
          <AlertTitle>
            {assessment.source.freshness === 'stale' ? 'Assessment is stale' : 'Freshness could not be confirmed'}
          </AlertTitle>
          <AlertDescription>Re-run the assessment before relying on this impact decision.</AlertDescription>
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

      <section aria-labelledby="assessment-summary-title" className="space-y-5">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={assessment.status === 'block' || assessment.status === 'error' ? 'destructive' : 'outline'}>
              {assessment.status.toUpperCase()}
            </Badge>
            <Badge variant="outline">{formatSeverity(assessment.severity)} severity</Badge>
          </div>
          <h1
            id="assessment-summary-title"
            className="max-w-[72ch] text-2xl font-semibold leading-tight tracking-tight"
          >
            {assessment.headline}
          </h1>
        </div>

        <Alert className="max-w-[75ch] border-border">
          <Info aria-hidden="true" />
          <AlertTitle>Recommended action</AlertTitle>
          <AlertDescription className="text-sm leading-6">{assessment.recommendedAction}</AlertDescription>
        </Alert>

        <dl className="grid max-w-4xl gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <SummaryFact label="Discovery certainty" value={formatDiscovery(assessment.confidence.discovery)} />
          <SummaryFact
            label="Interpretation confidence"
            value={formatConfidence(assessment.confidence.interpretation)}
          />
          <SummaryFact label="Freshness" value={formatFreshness(assessment.source.freshness)} />
          <SummaryFact label="Evidence origin" value={formatOrigin(assessment.source.evidenceOrigin)} />
        </dl>
      </section>

      <Separator />

      <section aria-labelledby="impact-map-title" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="impact-map-title" className="text-lg font-semibold">
              Causal impact map
            </h2>
            <p className="mt-1 max-w-[72ch] text-sm leading-6 text-muted-foreground">
              Only changed columns and deterministically grounded blocking paths are shown. Select an item to see why it
              breaks and how to remediate it.
            </p>
          </div>
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
              <Layers3 aria-hidden="true" />
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
            <div className="md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:gap-6">
              <div className="hidden md:block">
                <ImpactGraph
                  nodes={visible.nodes}
                  edges={visible.edges}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
              <ImpactInspector
                assessment={assessment}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onClose={() => setSelectedId(null)}
              />
            </div>

            <p className="text-sm text-muted-foreground md:hidden">Select an impact below to open its evidence.</p>
          </>
        )}
      </section>

      <section aria-labelledby="impact-list-title" className="space-y-3">
        <div>
          <h2 id="impact-list-title" className="text-lg font-semibold">
            Impact list
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Keyboard-accessible view synchronized with the graph.</p>
        </div>
        <ImpactList impacts={visible.impacts} selectedId={selectedId} onSelect={setSelectedId} />
      </section>

      <Separator />

      <ReviewContext assessment={assessment} />
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
    <div className="border-l border-border pl-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
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

function formatConfidence(value: number | null) {
  return value === null ? 'Unavailable' : `${String(Math.round(value * 100))}%`;
}

function formatFreshness(value: AssessmentViewV3['source']['freshness']) {
  if (value === 'current') return 'Current';
  if (value === 'stale') return 'Stale';
  return 'Unknown';
}

function formatOrigin(value: AssessmentViewV3['source']['evidenceOrigin']) {
  if (value === 'observed_lineage') return 'Observed lineage';
  if (value === 'proposed_code') return 'Proposed code';
  if (value === 'mixed') return 'Observed + proposed';
  return 'Unavailable';
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
