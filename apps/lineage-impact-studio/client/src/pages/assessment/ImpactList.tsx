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
  Skeleton,
} from '@databricks/appkit-ui/react';
import { AlertCircle, ChevronDown, ExternalLink, RotateCw } from 'lucide-react';

import type { AssessmentImpact, AssessmentUsageObject, UsageObjectKind } from '@/lib/contracts';

import { isVerifiedBreak, operationLabel, targetLabel } from './impact-copy';
import {
  assetUsage,
  formatCount,
  formatObservedCount,
  formatObservedDate,
  shortAsset,
  usageCount,
  USAGE_KINDS,
  type UsageLoadState,
} from './usage-model';

export function ImpactList({
  impacts,
  usage,
  selectedId,
  expandedAsset,
  onSelect,
  onExpandAsset,
  onRetryUsage,
}: {
  impacts: AssessmentImpact[];
  usage: UsageLoadState;
  selectedId: string | null;
  expandedAsset: string | null;
  onSelect: (id: string) => void;
  onExpandAsset: (asset: string, open: boolean) => void;
  onRetryUsage: () => void;
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

  const groups = new Map<string, AssessmentImpact[]>();
  for (const impact of impacts) {
    const group = groups.get(impact.targetAsset) ?? [];
    group.push(impact);
    groups.set(impact.targetAsset, group);
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
      <ol className="divide-y divide-border" aria-label="Affected tables">
        {[...groups].map(([asset, tableImpacts]) => {
          const count = usageCount(usage, asset);
          const expanded = expandedAsset === asset;
          return (
            <li key={asset}>
              <Collapsible open={expanded} onOpenChange={(open) => onExpandAsset(asset, open)}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 bg-muted/15 px-3 py-2.5 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${expanded ? 'Hide' : 'Show'} observed consumers of ${asset}`}
                  >
                    <ChevronDown
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <code className="block truncate font-mono text-sm font-semibold" title={asset}>
                        {shortAsset(asset)}
                      </code>
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={asset}>
                        {asset}
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded-sm border border-border bg-background px-2 py-1 text-xs font-medium tabular-nums"
                      aria-label={count.label}
                      title={count.label}
                    >
                      {count.status === 'loading' ? (
                        <>
                          <Skeleton className="h-3.5 w-20" />
                          <span className="sr-only">Loading usage</span>
                        </>
                      ) : count.status === 'unavailable' ? (
                        'Usage unavailable'
                      ) : count.status === 'partial' ? (
                        `${count.text} consumers · lower bound`
                      ) : (
                        `${count.text} consumers`
                      )}
                    </span>
                  </button>
                </CollapsibleTrigger>

                <ol className="divide-y divide-border border-t border-border" aria-label={`Impacts on ${asset}`}>
                  {tableImpacts.map((impact) => {
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

                <CollapsibleContent className="border-t border-border bg-muted/10">
                  <ConsumerDetails asset={asset} usage={usage} onRetry={onRetryUsage} />
                </CollapsibleContent>
              </Collapsible>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ConsumerDetails({ asset, usage, onRetry }: { asset: string; usage: UsageLoadState; onRetry: () => void }) {
  if (usage.kind === 'loading') {
    return (
      <div className="space-y-3 px-4 py-4" role="status" aria-label="Loading observed consumers">
        <Skeleton className="h-4 w-56 max-w-full" />
        <Skeleton className="h-3 w-72 max-w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const details = assetUsage(usage, asset);
  if (usage.kind === 'error' || details === undefined) {
    return (
      <Alert className="m-4 w-auto">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Usage unavailable</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>Visible objects observed in the last 30 days could not be loaded for this table.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Retry usage
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const windowLabel =
    usage.usage.observedFrom === usage.usage.observedThrough
      ? formatObservedDate(usage.usage.observedFrom)
      : `${formatObservedDate(usage.usage.observedFrom)} – ${formatObservedDate(usage.usage.observedThrough)}`;
  if (details.complete && details.count === 0) {
    return (
      <Empty className="min-h-32 border-0">
        <EmptyHeader>
          <EmptyTitle>No observed consumers</EmptyTitle>
          <EmptyDescription>
            No visible objects observed in the last 30 days used this table ({windowLabel}).
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const directObjects = details.objects.filter((object) => object.relation === 'direct');
  const indirectObjects = details.objects.filter((object) => object.relation === 'indirect');

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {details.complete
            ? `${formatCount(details.count)} distinct observed consumers`
            : `Lower bound: ${formatCount(details.count)} distinct observed consumers`}
        </p>
        <p className="text-muted-foreground">
          {formatObservedCount(details.directCount, details.complete)} direct ·{' '}
          {formatObservedCount(details.indirectCount, details.complete)} indirect · Observed {windowLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          Counts include visible objects observed in the last 30 days, regardless of impact scope.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-4">
        {USAGE_KINDS.map(({ kind, plural }) => (
          <div key={kind} className="flex items-center justify-between gap-2">
            <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <img src={CONSUMER_ICONS[kind]} alt="" aria-hidden="true" className="size-4 shrink-0" />
              {plural}
            </dt>
            <dd className="font-mono font-semibold tabular-nums">
              {formatObservedCount(details.byType[kind], details.complete)}
            </dd>
          </div>
        ))}
      </dl>

      {!details.complete ? (
        <p className="text-sm text-muted-foreground">
          Some consumer details could not be verified with your access. All counts marked + are lower bounds. Only
          accessible observed objects are listed.
        </p>
      ) : null}

      <div className="space-y-4" role="group" aria-label={`Observed consumers of ${asset}`}>
        <ConsumerLinkSection
          asset={asset}
          relation="direct"
          count={details.directCount}
          complete={details.complete}
          objects={directObjects}
        />
        <ConsumerLinkSection
          asset={asset}
          relation="indirect"
          count={details.indirectCount}
          complete={details.complete}
          objects={indirectObjects}
        />
      </div>
    </div>
  );
}

function ConsumerLinkSection({
  asset,
  relation,
  count,
  complete,
  objects,
}: {
  asset: string;
  relation: 'direct' | 'indirect';
  count: number;
  complete: boolean;
  objects: AssessmentUsageObject[];
}) {
  const title = relation === 'direct' ? 'Direct consumers' : 'Indirect consumers';
  return (
    <section className="space-y-2" aria-label={`${title} of ${asset}`}>
      <h4 className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatObservedCount(count, complete)}
        </span>
      </h4>
      {objects.length === 0 ? (
        <p className="text-xs text-muted-foreground">No accessible links in this section.</p>
      ) : (
        <ol className="divide-y divide-border border-t border-border" aria-label={`${title} links for ${asset}`}>
          {objects.map((object) => (
            <li key={`${object.kind}:${object.url}`} className="py-2.5 last:pb-0">
              <ConsumerLink object={object} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ConsumerLink({ object }: { object: AssessmentUsageObject }) {
  const kind = USAGE_KINDS.find((entry) => entry.kind === object.kind)?.singular ?? object.kind;
  const titleAlreadyIncludesKind = new RegExp(`^${kind}\\b`, 'i').test(object.title);
  const linkLabel = titleAlreadyIncludesKind ? object.title : `${kind} ${object.title}`;
  const access = { read: 'Reads', write: 'Writes', read_write: 'Reads and writes' }[object.accessMode];
  const viaAssets = [...new Set(object.viaAssets)];
  return (
    <div className="flex items-start gap-2.5">
      <img src={CONSUMER_ICONS[object.kind]} alt="" aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <a
          href={object.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 break-all text-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${linkLabel} in Databricks`}
        >
          {object.title}
          <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
        </a>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{kind}</span>
          <span>{access}</span>
          <span>Last seen {formatObservedDate(object.lastObservedAt)}</span>
        </p>
        {viaAssets.length > 0 ? (
          <p className="break-all text-xs text-muted-foreground">Via {viaAssets.join(', ')}</p>
        ) : null}
      </div>
    </div>
  );
}

const CONSUMER_ICONS: Record<UsageObjectKind, string> = {
  query: '/consumer-icons/query.svg',
  dashboard: '/consumer-icons/dashboard.svg',
  genie: '/consumer-icons/genie.svg',
  notebook: '/consumer-icons/notebook.svg',
  pipeline: '/consumer-icons/pipeline.svg',
  job: '/consumer-icons/job.svg',
  alert: '/consumer-icons/alert.svg',
};
