import { Badge, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@databricks/appkit-ui/react';

import type { AssessmentImpact } from '@/lib/contracts';

import { isVerifiedBreak, operationLabel, targetLabel } from './impact-copy';

export function ImpactList({
  impacts,
  selectedId,
  onSelect,
}: {
  impacts: AssessmentImpact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (impacts.length === 0) {
    return (
      <Empty className="min-h-36 border border-border">
        <EmptyHeader>
          <EmptyTitle>No causal impacts to show</EmptyTitle>
          <EmptyDescription>No verified blocking path is available for this view.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-hidden rounded-sm border border-border">
      <div
        className="hidden grid-cols-[7rem_minmax(16rem,1fr)_11rem_10rem] gap-3 border-b border-border bg-muted/25 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid"
        aria-hidden="true"
      >
        <span>Relation</span>
        <span>Target</span>
        <span>Operation</span>
        <span>Evidence</span>
      </div>
      <ol className="divide-y divide-border" aria-label="Downstream impacts">
        {impacts.map((impact) => {
          const nodeId = `impact-${impact.id}`;
          const selected = selectedId === nodeId;
          return (
            <li key={impact.id}>
              <button
                type="button"
                className={`grid w-full gap-2 border-l-2 px-3 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[7rem_minmax(16rem,1fr)_11rem_10rem] md:items-center md:gap-3 ${selected ? 'impact-row-selected' : 'border-l-transparent hover:bg-muted/30'}`}
                aria-pressed={selected}
                aria-label={`Inspect ${impact.relation} impact on ${targetLabel(impact)}`}
                onClick={() => onSelect(nodeId)}
              >
                <span>
                  <Badge variant="outline" className="font-normal">
                    {impact.relation === 'transitive' ? 'Transitive' : 'Direct'}
                  </Badge>
                </span>
                <code className="min-w-0 break-all font-mono text-sm font-medium">{targetLabel(impact)}</code>
                <span className="text-muted-foreground md:text-foreground">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Operation:</span>
                  {operationLabel(impact.operation)}
                </span>
                <span className="text-muted-foreground md:text-foreground">
                  <span className="mr-1 text-xs text-muted-foreground md:hidden">Evidence:</span>
                  {impact.evidenceLevel === 'definition'
                    ? 'Parsed definition'
                    : isVerifiedBreak(impact)
                      ? 'Verified definition'
                      : 'Verified lineage'}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
