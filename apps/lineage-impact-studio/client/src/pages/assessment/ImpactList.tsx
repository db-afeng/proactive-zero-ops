import { Badge, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@databricks/appkit-ui/react';
import { ChevronRight } from 'lucide-react';

import type { AssessmentImpact } from '@/lib/contracts';

import { isVerifiedBreak, reasonText, targetLabel } from './impact-copy';

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
    <ol className="divide-y divide-border border-y border-border" aria-label="Downstream impacts">
      {impacts.map((impact) => {
        const nodeId = `impact-${impact.id}`;
        const selected = selectedId === nodeId;
        return (
          <li key={impact.id}>
            <button
              type="button"
              className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-1 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? 'bg-muted/50' : 'hover:bg-muted/30'}`}
              aria-pressed={selected}
              aria-label={`Inspect ${impact.relation} impact on ${targetLabel(impact)}`}
              onClick={() => onSelect(nodeId)}
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <code className="break-all font-mono text-sm font-medium">{targetLabel(impact)}</code>
                  <Badge variant={impact.relation === 'direct' && isVerifiedBreak(impact) ? 'destructive' : 'outline'}>
                    {impact.relation === 'transitive'
                      ? 'Transitive impact'
                      : isVerifiedBreak(impact)
                        ? 'Direct break'
                        : 'Supporting context'}
                  </Badge>
                </span>
                <span className="mt-1.5 block text-sm leading-6 text-muted-foreground">{reasonText(impact)}</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
