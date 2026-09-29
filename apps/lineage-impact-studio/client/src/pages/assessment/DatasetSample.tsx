import { sql } from '@databricks/appkit-ui/js';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { AlertCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { findHighlightedColumn, parseSampleRows, sampleErrorKind, type SampleRow } from './dataset-sample-model';

type SampleKind = 'changed' | 'impacted';

export function DatasetSample({ asset, column, kind }: { asset: string; column: string | null; kind: SampleKind }) {
  const [sampleLimit, setSampleLimit] = useState(5);
  const parameters = useMemo(
    () => ({ asset_reference: sql.string(asset), sample_limit: sql.number(sampleLimit) }),
    [asset, sampleLimit]
  );
  const { data, loading, error } = useAnalyticsQuery('dataset_sample', parameters);
  const parsed = useMemo(() => parseSampleRows(data), [data]);
  const oversized = isOversizedError(error) || parsed.kind === 'oversized';

  useEffect(() => {
    if (!oversized || sampleLimit === 1) return;
    const retry = window.setTimeout(() => setSampleLimit(1), 0);
    return () => window.clearTimeout(retry);
  }, [oversized, sampleLimit]);

  return (
    <section className="space-y-3" aria-labelledby="dataset-sample-title">
      <div>
        <h4 id="dataset-sample-title" className="text-sm font-semibold">
          Current dataset sample
        </h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Up to {String(sampleLimit)} unordered row{sampleLimit === 1 ? '' : 's'} from the currently deployed asset.
          This is not proposed pull-request output.
        </p>
      </div>

      {loading || (oversized && sampleLimit > 1) ? <SampleSkeleton /> : null}
      {!loading && error !== null && !oversized ? <SampleError error={error} /> : null}
      {!loading && oversized && sampleLimit === 1 ? (
        <StateAlert title="Sample is too large">
          Even one row exceeds the safe interactive response size. Query a narrower projection in Databricks.
        </StateAlert>
      ) : null}
      {!loading && error === null && parsed.kind === 'malformed' ? (
        <StateAlert title="Sample response could not be read">
          The warehouse returned malformed row data. No sample values are shown.
        </StateAlert>
      ) : null}
      {!loading && error === null && parsed.kind === 'ready' && parsed.rows.length === 0 ? (
        <Empty className="min-h-36 border border-border">
          <EmptyHeader>
            <EmptyTitle>No current rows</EmptyTitle>
            <EmptyDescription>The authorized asset is empty.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!loading && error === null && parsed.kind === 'ready' && parsed.rows.length > 0 ? (
        <SampleTable
          rows={parsed.rows}
          columns={parsed.columns}
          columnTypes={parsed.columnTypes}
          highlightedColumn={column}
          kind={kind}
        />
      ) : null}
    </section>
  );
}

function SampleTable({
  rows,
  columns,
  columnTypes,
  highlightedColumn,
  kind,
}: {
  rows: SampleRow[];
  columns: string[];
  columnTypes: Record<string, string>;
  highlightedColumn: string | null;
  kind: SampleKind;
}) {
  const matchedColumn = findHighlightedColumn(columns, highlightedColumn);

  return (
    <div className="space-y-3">
      {highlightedColumn !== null && matchedColumn === null ? (
        <StateAlert title="Affected column is not present">
          The current deployed schema does not include the affected column. Other authorized values remain visible.
        </StateAlert>
      ) : null}
      <div className="overflow-x-auto border border-border">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              {columns.map((column) => {
                const highlighted = column === matchedColumn;
                return (
                  <TableHead key={column} className={highlighted ? highlightClass(kind) : undefined}>
                    <span className="flex flex-col items-start gap-1 whitespace-nowrap py-1">
                      <span className="inline-flex items-center gap-2">
                        {column}
                        {highlighted ? (
                          <Badge
                            variant={kind === 'impacted' ? 'destructive' : 'outline'}
                            className={kind === 'changed' ? 'border-warning/50 text-warning' : undefined}
                          >
                            {kind === 'changed' ? 'Changed' : 'Impacted'}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="font-mono text-[11px] font-normal text-muted-foreground">
                        {columnTypes[column]}
                      </span>
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={sampleRowKey(row, rowIndex)}>
                {columns.map((column) => (
                  <TableCell
                    key={column}
                    className={`max-w-64 whitespace-nowrap font-mono text-xs ${column === matchedColumn ? highlightClass(kind) : ''}`}
                    title={formatCell(row[column])}
                  >
                    <span className="block max-w-60 truncate">{formatCell(row[column])}</span>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SampleSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading current dataset sample">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-4/5" />
    </div>
  );
}

function SampleError({ error }: { error: string }) {
  if (sampleErrorKind(error) === 'permission') {
    return (
      <StateAlert title="Sample access is no longer available">
        Your current Databricks identity could not read this asset. Permission changes apply immediately, so no sample
        values are shown.
      </StateAlert>
    );
  }
  return (
    <StateAlert title="Sample could not be loaded">
      The warehouse query failed safely. No sample values are shown; try selecting the asset again.
    </StateAlert>
  );
}

function StateAlert({ title, children }: { title: string; children: string }) {
  return (
    <Alert>
      <AlertCircle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function isOversizedError(error: string | null): boolean {
  return error !== null && sampleErrorKind(error) === 'oversized';
}

function highlightClass(kind: SampleKind): string {
  return kind === 'changed' ? 'bg-warning/10' : 'bg-destructive/10';
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unavailable]';
  }
}

function sampleRowKey(row: SampleRow, index: number): string {
  return `${String(index)}:${Object.entries(row)
    .map(([key, value]) => `${key}=${formatCell(value)}`)
    .join('|')}`;
}
