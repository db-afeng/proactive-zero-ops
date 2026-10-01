import type { AssessmentAssetUsage, AssessmentUsageV1, UsageObjectKind } from '@/lib/contracts';

export type UsageLoadState = { kind: 'loading' } | { kind: 'ready'; usage: AssessmentUsageV1 } | { kind: 'error' };

export const USAGE_KINDS: ReadonlyArray<{ kind: UsageObjectKind; singular: string; plural: string }> = [
  { kind: 'query', singular: 'Query', plural: 'Queries' },
  { kind: 'dashboard', singular: 'Dashboard', plural: 'Dashboards' },
  { kind: 'genie', singular: 'Genie room', plural: 'Genie rooms' },
  { kind: 'notebook', singular: 'Notebook', plural: 'Notebooks' },
  { kind: 'pipeline', singular: 'Pipeline', plural: 'Pipelines' },
  { kind: 'job', singular: 'Job', plural: 'Jobs' },
  { kind: 'alert', singular: 'Alert', plural: 'Alerts' },
];

export function assetUsage(state: UsageLoadState, asset: string): AssessmentAssetUsage | undefined {
  return state.kind === 'ready' ? state.usage.assets.find((entry) => entry.asset === asset) : undefined;
}

export interface UsageCountDisplay {
  text: string;
  label: string;
  status: 'loading' | 'unavailable' | 'partial' | 'complete';
}

export function usageCount(state: UsageLoadState, asset: string): UsageCountDisplay {
  if (state.kind === 'loading')
    return {
      text: '…',
      label: `Loading visible objects observed in the last 30 days for ${asset}`,
      status: 'loading',
    };
  if (state.kind === 'error') {
    return {
      text: '—',
      label: `Usage of ${asset} is unavailable; visible objects observed in the last 30 days could not be loaded`,
      status: 'unavailable',
    };
  }

  const usage = assetUsage(state, asset);
  if (usage === undefined) {
    return {
      text: '—',
      label: `Usage of ${asset} is unavailable; visible objects observed in the last 30 days could not be loaded`,
      status: 'unavailable',
    };
  }
  if (!usage.complete && usage.count === 0) {
    return {
      text: '0+',
      label: `Lower bound: 0 distinct observed consumers of ${asset}; visible objects observed in the last 30 days; coverage is incomplete`,
      status: 'partial',
    };
  }
  if (!usage.complete) {
    return {
      text: `${formatCount(usage.count)}+`,
      label: `Lower bound: ${formatCount(usage.count)} distinct observed consumers of ${asset}; visible objects observed in the last 30 days; coverage is incomplete`,
      status: 'partial',
    };
  }
  return {
    text: formatCount(usage.count),
    label: `${formatCount(usage.count)} distinct observed consumers of ${asset}; visible objects observed in the last 30 days`,
    status: 'complete',
  };
}

export function formatCount(count: number): string {
  return new Intl.NumberFormat('en-AU').format(count);
}

export function formatObservedCount(count: number, complete: boolean): string {
  return `${formatCount(count)}${complete ? '' : '+'}`;
}

export function shortAsset(asset: string): string {
  return asset.split('.').at(-1) ?? asset;
}

export function formatObservedDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(value)
  );
}
