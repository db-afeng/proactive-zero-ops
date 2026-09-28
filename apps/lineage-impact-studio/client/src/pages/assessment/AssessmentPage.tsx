import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
import {
  AlertCircle,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  GitPullRequestArrow,
  OctagonX,
  RotateCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';

import { ApiRequestError, getAssessment } from '@/lib/api';
import type { AssessmentStatus, AssessmentViewV1 } from '@/lib/contracts';

import { AssessmentTab } from './AssessmentTab';
import { AuditTab } from './AuditTab';
import { FixTab } from './FixTab';

type WorkbenchTab = 'assessment' | 'fix' | 'audit';
type AssessmentLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; assessment: AssessmentViewV1 }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

const STATUS_PRESENTATION: Record<
  AssessmentStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    className: string;
  }
> = {
  pass: {
    label: 'PASS',
    icon: CheckCircle2,
    className: 'border-success/40 bg-success/10 text-success',
  },
  warn: {
    label: 'WARN',
    icon: CircleAlert,
    className: 'border-warning/50 bg-warning/15 text-warning-foreground',
  },
  block: {
    label: 'BLOCK',
    icon: OctagonX,
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
  error: {
    label: 'ERROR',
    icon: AlertCircle,
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
};

export function AssessmentPage() {
  const { reference = '' } = useParams();
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<AssessmentLoadState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    void getAssessment(reference, controller.signal)
      .then((assessment) => {
        setState({ kind: 'ready', assessment });
        document.title = `${assessment.pullRequest.repository} #${assessment.pullRequest.number} · Lineage Impact Studio`;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ApiRequestError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.status === 404 ||
            error.code === 'ASSESSMENT_UNAVAILABLE')
        ) {
          setState({ kind: 'unavailable' });
          document.title = 'Assessment unavailable · Lineage Impact Studio';
          return;
        }
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The assessment could not be loaded.',
        });
      });

    return () => controller.abort();
  }, [reference, retryToken]);

  if (state.kind === 'ready' && state.assessment.reference !== reference) {
    return <AssessmentLoading />;
  }
  if (state.kind === 'loading') return <AssessmentLoading />;
  if (state.kind === 'unavailable') return <AssessmentUnavailable />;
  if (state.kind === 'error') {
    return (
      <AssessmentFailure
        message={state.message}
        onRetry={() => {
          setState({ kind: 'loading' });
          setRetryToken((value) => value + 1);
        }}
      />
    );
  }

  return <AssessmentWorkbench key={state.assessment.reference} assessment={state.assessment} />;
}

function AssessmentWorkbench({ assessment }: { assessment: AssessmentViewV1 }) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>(() => tabFromHash());
  const status = STATUS_PRESENTATION[assessment.status];
  const StatusIcon = status.icon;
  const pullRequestUrl = `https://github.com/${assessment.pullRequest.repository}/pull/${assessment.pullRequest.number}`;

  function changeTab(value: string) {
    if (!isWorkbenchTab(value)) return;
    setActiveTab(value);
    window.history.replaceState(null, '', `${window.location.pathname}#${value}`);
  }

  return (
    <Tabs value={activeTab} onValueChange={changeTab} className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto max-w-[88rem] px-4 pt-3 md:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <GitPullRequestArrow className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="truncate text-sm font-semibold">Lineage Impact Studio</p>
            </div>
            <span className="hidden text-muted-foreground sm:inline" aria-hidden="true">
              /
            </span>
            <a
              href={pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-sm font-medium underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{assessment.pullRequest.repository}</span>
              <span className="shrink-0">#{assessment.pullRequest.number}</span>
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
            <Badge variant="outline" className={`gap-1 rounded-sm ${status.className}`}>
              <StatusIcon className="size-3" aria-hidden="true" />
              {status.label}
            </Badge>
            <p className="ml-auto hidden max-w-80 truncate font-mono text-xs text-muted-foreground lg:block">
              Reference {assessment.reference}
            </p>
            <p className="w-full break-all font-mono text-xs text-muted-foreground lg:hidden">
              Reference {assessment.reference}
            </p>
          </div>
          <TabsList aria-label="Assessment workbench" className="h-9 bg-transparent p-0">
            <TabsTrigger value="assessment" className="rounded-sm px-3">
              Assessment
            </TabsTrigger>
            <TabsTrigger value="fix" className="rounded-sm px-3">
              Fix
            </TabsTrigger>
            <TabsTrigger value="audit" className="rounded-sm px-3">
              Audit
            </TabsTrigger>
          </TabsList>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[88rem] px-4 py-5 md:px-6 md:py-7">
        <TabsContent value="assessment" className="mt-0 focus-visible:outline-none">
          <AssessmentTab assessment={assessment} />
        </TabsContent>
        <TabsContent value="fix" className="mt-0 focus-visible:outline-none">
          <FixTab assessment={assessment} active={activeTab === 'fix'} />
        </TabsContent>
        <TabsContent value="audit" className="mt-0 focus-visible:outline-none">
          <AuditTab
            reference={assessment.reference}
            repository={assessment.pullRequest.repository}
            active={activeTab === 'audit'}
          />
        </TabsContent>
      </main>
    </Tabs>
  );
}

function AssessmentLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground" aria-busy="true">
      <header className="border-b border-border px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-[88rem] items-center gap-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-6 w-16" />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[88rem] gap-8 px-4 py-8 md:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </main>
      <span className="sr-only">Loading assessment</span>
    </div>
  );
}

function AssessmentUnavailable() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 md:px-6">
        <p className="text-sm font-semibold">Lineage Impact Studio</p>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 items-center px-4 py-16">
        <Alert>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>This assessment is unavailable.</AlertTitle>
          <AlertDescription>
            Verify the link in the pull request comment or ask the assessment owner for a new link.
          </AlertDescription>
        </Alert>
      </main>
    </div>
  );
}

function AssessmentFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 md:px-6">
        <p className="text-sm font-semibold">Lineage Impact Studio</p>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 items-center px-4 py-16">
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Assessment could not be loaded</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{message}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    </div>
  );
}

function tabFromHash(): WorkbenchTab {
  const hash = window.location.hash.slice(1);
  return isWorkbenchTab(hash) ? hash : 'assessment';
}

function isWorkbenchTab(value: string): value is WorkbenchTab {
  return value === 'assessment' || value === 'fix' || value === 'audit';
}
