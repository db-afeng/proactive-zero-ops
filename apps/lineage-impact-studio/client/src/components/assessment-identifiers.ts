import type { AssessmentViewV3 } from '@/lib/contracts';

export function assessmentIdentifiers(assessment: AssessmentViewV3): string[] {
  const names = new Set<string>();
  const add = (asset: string | null | undefined, column?: string | null) => {
    if (asset === null || asset === undefined) return;
    const short = asset.split('.').at(-1) ?? asset;
    names.add(asset);
    names.add(short);
    if (column !== null && column !== undefined) {
      names.add(column);
      names.add(`${short}.${column}`);
      names.add(`${asset}.${column}`);
    }
  };
  for (const change of assessment.changes) add(change.asset, change.column);
  for (const impact of assessment.impacts) add(impact.targetAsset, impact.targetColumn);
  for (const node of assessment.graph.nodes) add(node.asset, node.column);
  for (const edge of assessment.graph.edges) {
    add(edge.sourceAsset, edge.sourceColumn);
    add(edge.targetAsset, edge.targetColumn);
  }
  return [...names].sort((a, b) => b.length - a.length);
}
