import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ScrollArea,
  ScrollBar,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@databricks/appkit-ui/react';
import { AlertCircle, CheckCircle2, ExternalLink, History, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ApiRequestError, getAudit } from '@/lib/api';
import type { AuditRecord } from '@/lib/contracts';

type AuditState =
  | { kind: 'idle' }
  | { kind: 'loading'; reference: string }
  | { kind: 'ready'; reference: string; records: AuditRecord[] }
  | { kind: 'permission-lost'; reference: string }
  | { kind: 'error'; reference: string; message: string };

export function AuditTab({
  reference,
  repository,
  active,
}: {
  reference: string;
  repository: string;
  active: boolean;
}) {
  const [state, setState] = useState<AuditState>({ kind: 'idle' });
  const [retryToken, setRetryToken] = useState(0);
  const loadedReference = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!active || loadedReference.current === reference) return;
    const controller = new AbortController();

    void getAudit(reference, controller.signal)
      .then(({ records }) => {
        loadedReference.current = reference;
        setState({ kind: 'ready', reference, records });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        loadedReference.current = reference;
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          setState({ kind: 'permission-lost', reference });
          return;
        }
        setState({
          kind: 'error',
          reference,
          message: error instanceof Error ? error.message : 'Audit history could not be loaded.',
        });
      });

    return () => controller.abort();
  }, [active, reference, retryToken]);

  const visibleState: AuditState =
    'reference' in state && state.reference === reference ? state : { kind: 'loading', reference };

  return (
    <section aria-labelledby="audit-title" className="space-y-5">
      <div>
        <h1 id="audit-title" className="text-2xl font-semibold tracking-tight">
          Commit audit
        </h1>
        <p className="mt-1 max-w-[72ch] text-sm leading-6 text-muted-foreground">
          Approval and commit outcomes are append-only. Each row binds the acting user to the exact pull-request head
          and approved patch digest.
        </p>
      </div>

      {visibleState.kind === 'loading' ? <AuditLoading /> : null}

      {visibleState.kind === 'permission-lost' ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Audit permission changed</AlertTitle>
          <AlertDescription>
            Your current identity can no longer read this assessment audit. Reload the assessment after access is
            restored.
          </AlertDescription>
        </Alert>
      ) : null}

      {visibleState.kind === 'error' ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Audit history could not be loaded</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{visibleState.message}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                loadedReference.current = undefined;
                setState({ kind: 'loading', reference });
                setRetryToken((value) => value + 1);
              }}
            >
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {visibleState.kind === 'ready' && visibleState.records.length === 0 ? (
        <Empty className="min-h-56 border border-border">
          <EmptyHeader>
            <EmptyMedia>
              <History className="size-5 text-muted-foreground" aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No commit activity</EmptyTitle>
            <EmptyDescription>Approvals and commit attempts for this assessment will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {visibleState.kind === 'ready' && visibleState.records.length > 0 ? (
        <ScrollArea className="w-full border-y border-border">
          <Table className="min-w-[68rem]">
            <TableHeader>
              <TableRow>
                <TableHead>Actor</TableHead>
                <TableHead>Expected head</TableHead>
                <TableHead>Patch digest</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead>Committed</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleState.records.map((record) => (
                <AuditRow key={record.id} record={record} repository={repository} />
              ))}
            </TableBody>
          </Table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      ) : null}
    </section>
  );
}

function AuditRow({ record, repository }: { record: AuditRecord; repository: string }) {
  const succeeded = record.outcome === 'committed' || record.outcome === 'success';
  const pending = record.outcome === 'approved' || record.outcome === 'pending';

  return (
    <TableRow>
      <TableCell className="font-medium">{record.actor}</TableCell>
      <TableCell>
        <CodeValue value={record.expectedHeadSha} />
      </TableCell>
      <TableCell>
        <CodeValue value={record.patchDigest} />
      </TableCell>
      <TableCell className="whitespace-nowrap">{formatDateTime(record.approvedAt)}</TableCell>
      <TableCell className="whitespace-nowrap">
        {record.committedAt ? formatDateTime(record.committedAt) : '—'}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              succeeded
                ? 'rounded-sm border-success/40 bg-success/10 text-success'
                : pending
                  ? 'rounded-sm border-warning/50 bg-warning/15 text-warning-foreground'
                  : 'rounded-sm border-destructive/40 bg-destructive/10 text-destructive'
            }
          >
            {succeeded ? <CheckCircle2 className="size-3" aria-hidden="true" /> : null}
            {record.outcome}
          </Badge>
          {record.commitSha ? (
            <a
              href={`https://github.com/${repository}/commit/${record.commitSha}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {shortHash(record.commitSha)}
              <ExternalLink className="size-3" aria-hidden="true" />
              <span className="sr-only">Open commit</span>
            </a>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CodeValue({ value }: { value: string }) {
  return (
    <code title={value} className="block max-w-56 break-all font-mono text-xs">
      {value}
    </code>
  );
}

function AuditLoading() {
  return (
    <div className="space-y-2 border-y border-border py-3" aria-busy="true">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <span className="sr-only">Loading audit history</span>
    </div>
  );
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
