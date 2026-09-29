import type { AssessmentImpact } from '@/lib/contracts';

export function targetLabel(impact: AssessmentImpact) {
  return impact.targetColumn === null ? impact.targetAsset : `${impact.targetAsset}.${impact.targetColumn}`;
}

export function reasonText(impact: AssessmentImpact) {
  switch (impact.reason) {
    case 'incompatible_type':
      return `${operationLabel(impact.operation)} still expects the previous type contract.`;
    case 'missing_column':
      return 'This consumer still references a column that the change removes.';
    case 'renamed_column':
      return 'This consumer still references the previous column name.';
    case 'incompatible_operation':
      return `The proposed value is incompatible with this ${operationLabel(impact.operation)}.`;
    case 'semantic_change':
      return 'The value remains available, but its meaning changes for this consumer.';
    case 'upstream_failure':
      return 'A verified upstream break can prevent this transitive consumer from updating.';
    case 'manual_review':
      return 'The available evidence is not specific enough to determine compatibility automatically.';
  }
}

export function operationLabel(operation: AssessmentImpact['operation']) {
  const labels: Record<AssessmentImpact['operation'], string> = {
    arithmetic: 'numeric arithmetic',
    aggregate: 'aggregation',
    comparison: 'comparison',
    filter: 'filter',
    join: 'join',
    cast: 'cast',
    constraint: 'constraint',
    pass_through: 'pass-through use',
    unknown: 'operation',
  };
  return labels[operation];
}

export function isVerifiedBreak(impact: AssessmentImpact) {
  return impact.reason !== 'semantic_change' && impact.reason !== 'manual_review';
}
