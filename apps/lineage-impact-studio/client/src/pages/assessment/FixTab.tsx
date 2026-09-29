import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Progress,
  ScrollArea,
  Skeleton,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Clipboard,
  ExternalLink,
  FileCode2,
  Github,
  Link2Off,
  RotateCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';

import { MonacoDiff } from '@/components/MonacoDiff';
import {
  ApiRequestError,
  disconnectGitHub,
  getAssessmentFixSession,
  getCapabilities,
  getFixSession,
  getGitHubStatus,
  getValidatedPatch,
  githubLoginUrl,
} from '@/lib/api';
import type {
  AssessmentViewV3,
  Capabilities,
  FixSession,
  GitHubConnection,
  PatchFile,
  PatchValidation,
  ValidatedPatch,
} from '@/lib/contracts';

type Loadable<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'error'; message: string };

type ProgressUpdateState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export function FixTab({ assessment, active }: { assessment: AssessmentViewV3; active: boolean }) {
  const [github, setGitHub] = useState<Loadable<GitHubConnection>>({ kind: 'idle' });
  const [capabilities, setCapabilities] = useState<Loadable<Capabilities>>({ kind: 'idle' });
  const [prerequisiteRetry, setPrerequisiteRetry] = useState(0);
  const [sessionLookup, setSessionLookup] = useState<Loadable<FixSession | null>>({ kind: 'idle' });
  const [sessionLookupRetry, setSessionLookupRetry] = useState(0);
  const [session, setSession] = useState<FixSession>();
  const [patch, setPatch] = useState<Loadable<ValidatedPatch>>({ kind: 'idle' });
  const [selectedPath, setSelectedPath] = useState<string>();
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [permissionLost, setPermissionLost] = useState(false);
  const [staleHead, setStaleHead] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setGitHub({ kind: 'loading' });
    setCapabilities({ kind: 'loading' });

    void getGitHubStatus(controller.signal)
      .then((value) => setGitHub({ kind: 'ready', value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setGitHub({
          kind: 'error',
          message: error instanceof Error ? error.message : 'GitHub status could not be loaded.',
        });
      });

    void getCapabilities(controller.signal)
      .then((value) => setCapabilities({ kind: 'ready', value }))
      .catch(() => {
        if (controller.signal.aborted) return;
        setCapabilities({
          kind: 'ready',
          value: {
            omnigent: {
              available: false,
              reason: 'Fix generation is not available in this workspace.',
            },
          },
        });
      });

    return () => controller.abort();
  }, [active, prerequisiteRetry]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setSessionLookup({ kind: 'loading' });
    void getAssessmentFixSession(assessment.reference, controller.signal)
      .then((value) => {
        setSession(value ?? undefined);
        setSessionLookup({ kind: 'ready', value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSessionLookup({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The automatic fix status could not be loaded.',
        });
      });
    return () => controller.abort();
  }, [active, assessment.reference, assessment.pullRequest.headSha, sessionLookupRetry]);

  const shouldPoll = active && session !== undefined && !isTerminalSession(session.status) && !permissionLost;
  const { updateState, retry } = useFixPolling(
    session?.id,
    shouldPoll,
    (updatedSession) => setSession(updatedSession),
    (error) => handleScopedError(error, setPermissionLost, setStaleHead, setActionError)
  );

  useEffect(() => {
    if (!active || session?.status !== 'complete') return;
    const controller = new AbortController();
    setPatch({ kind: 'loading' });
    void getValidatedPatch(session.id, controller.signal)
      .then((value) => {
        setPatch({ kind: 'ready', value });
        setSelectedPath((current) =>
          current && value.files.some((file) => file.path === current) ? current : value.files[0]?.path
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        handleScopedError(error, setPermissionLost, setStaleHead, (message) =>
          setPatch({
            kind: 'error',
            message: message ?? 'The validated patch could not be loaded.',
          })
        );
      });
    return () => controller.abort();
  }, [active, session?.id, session?.status]);

  const omnigent = capabilities.kind === 'ready' ? capabilities.value.omnigent : undefined;
  async function disconnect() {
    setActionPending(true);
    setActionError(undefined);
    try {
      const status = await disconnectGitHub();
      setGitHub({ kind: 'ready', value: status });
    } catch (error) {
      handleScopedError(error, setPermissionLost, setStaleHead, setActionError);
    } finally {
      setActionPending(false);
    }
  }

  return (
    <section aria-labelledby="fix-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="fix-title" className="text-2xl font-semibold tracking-tight">
            Propose a fix
          </h1>
          <p className="mt-1 max-w-[72ch] text-sm leading-6 text-muted-foreground">
            A failed GitHub check starts Omnigent automatically in the app service principal&apos;s isolated sandbox.
            Generated changes are validated and committed to a separate proposal branch before they appear here.
          </p>
        </div>
        <GitHubConnectionControl
          state={github}
          assessment={assessment}
          disabled={actionPending}
          onDisconnect={() => void disconnect()}
          onRetry={() => setPrerequisiteRetry((value) => value + 1)}
        />
      </div>

      {assessment.source.freshness !== 'current' || staleHead ? (
        <Alert className="border-warning/50">
          <CircleAlert className="text-warning-foreground" aria-hidden="true" />
          <AlertTitle>Pull request head must be reassessed</AlertTitle>
          <AlertDescription>
            The assessed head is no longer current. Re-run the GitHub assessment before generating or committing a fix.
          </AlertDescription>
        </Alert>
      ) : null}

      {permissionLost ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Permission changed</AlertTitle>
          <AlertDescription>
            Your Databricks or GitHub access changed during this review. The app service principal can run Omnigent, but
            it cannot replace your assessment or GitHub authorization. Reload after access is restored.
          </AlertDescription>
        </Alert>
      ) : null}

      {omnigent?.available === false ? (
        <Alert>
          <Ban aria-hidden="true" />
          <AlertTitle>Fix generation is unavailable</AlertTitle>
          <AlertDescription>{omnigent.reason ?? 'Omnigent is not available in this workspace.'}</AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Action could not be completed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {!session ? (
        <AutomaticFixLookup state={sessionLookup} onRetry={() => setSessionLookupRetry((value) => value + 1)} />
      ) : (
        <div className="space-y-6">
          <SessionProgress session={session} updateState={updateState} onRetry={retry} />

          {session.status === 'complete' ? (
            <PatchArea
              patch={patch}
              selectedPath={selectedPath}
              repository={assessment.pullRequest.repository}
              onSelectPath={setSelectedPath}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function AutomaticFixLookup({ state, onRetry }: { state: Loadable<FixSession | null>; onRetry: () => void }) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <Card aria-busy="true" className="shadow-none">
        <CardHeader>
          <CardTitle>Loading automatic fix</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <span className="sr-only">Looking for the fix started by the failed GitHub check</span>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'error') {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Automatic fix status could not be loaded</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{state.message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Empty className="min-h-56 border border-border">
      <EmptyHeader>
        <EmptyMedia>
          <CircleDashed className="size-5 text-muted-foreground" aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Waiting for the failed GitHub check</EmptyTitle>
        <EmptyDescription>
          A blocking downstream-impact check starts the isolated Omnigent proposal automatically.
        </EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        Check again
      </Button>
    </Empty>
  );
}

function GitHubConnectionControl({
  state,
  assessment,
  disabled,
  onDisconnect,
  onRetry,
}: {
  state: Loadable<GitHubConnection>;
  assessment: AssessmentViewV3;
  disabled: boolean;
  onDisconnect: () => void;
  onRetry: () => void;
}) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <Skeleton className="h-8 w-40" />;
  }

  if (state.kind === 'error') {
    return (
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        Retry GitHub status
      </Button>
    );
  }

  if (!state.value.connected) {
    const returnTo = `/assessments/${encodeURIComponent(assessment.reference)}#fix`;
    return (
      <Button asChild variant="outline" size="sm">
        <a href={githubLoginUrl(returnTo)}>
          <Github aria-hidden="true" />
          Connect GitHub
        </a>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <Github className="size-4 text-muted-foreground" aria-hidden="true" />
      <span>
        Connected as <strong>{state.value.login ?? 'GitHub user'}</strong>
      </span>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onDisconnect}>
        Disconnect
      </Button>
    </div>
  );
}

function SessionProgress({
  session,
  updateState,
  onRetry,
}: {
  session: FixSession;
  updateState: ProgressUpdateState;
  onRetry: () => void;
}) {
  const progress = session.progress ?? defaultProgress(session.status);
  const active = !isTerminalSession(session.status);

  return (
    <section aria-labelledby="session-progress-title" className="space-y-4 border-y border-border py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="session-progress-title" className="text-base font-semibold">
            {sessionStatusTitle(session.status)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.message ?? sessionStatusMessage(session.status)}
          </p>
        </div>
      </div>

      {active ? (
        <div className="space-y-2">
          <Progress value={progress} aria-label={`Fix generation ${String(progress)} percent`} />
          <p className="text-xs tabular-nums text-muted-foreground">{progress}% complete</p>
        </div>
      ) : null}

      {updateState === 'disconnected' && active ? (
        <Alert className="border-warning/50">
          <Link2Off className="text-warning-foreground" aria-hidden="true" />
          <AlertTitle>Progress updates paused</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>The session may still be running. Retry to resume status updates.</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCw aria-hidden="true" />
              Retry updates
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {session.status === 'failed' ? (
        <Alert variant="destructive">
          <XCircle aria-hidden="true" />
          <AlertTitle>Omnigent could not produce a valid fix</AlertTitle>
          <AlertDescription>{session.error ?? 'No patch was retained.'}</AlertDescription>
        </Alert>
      ) : null}

      {session.status === 'cancelled' ? (
        <Alert>
          <Ban aria-hidden="true" />
          <AlertTitle>Fix generation cancelled</AlertTitle>
          <AlertDescription>No patch from this session can be approved or committed.</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function PatchArea({
  patch,
  selectedPath,
  repository,
  onSelectPath,
}: {
  patch: Loadable<ValidatedPatch>;
  selectedPath?: string;
  repository: string;
  onSelectPath: (path: string) => void;
}) {
  if (patch.kind === 'idle' || patch.kind === 'loading') {
    return (
      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]" aria-busy="true">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-[34rem] w-full" />
        <span className="sr-only">Loading validated patch</span>
      </div>
    );
  }

  if (patch.kind === 'error') {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Validated patch could not be loaded</AlertTitle>
        <AlertDescription>{patch.message}</AlertDescription>
      </Alert>
    );
  }

  if (patch.value.files.length === 0) {
    return (
      <Empty className="min-h-56 border border-border">
        <EmptyHeader>
          <EmptyMedia>
            <FileCode2 className="size-5 text-muted-foreground" aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No source changes proposed</EmptyTitle>
          <EmptyDescription>Omnigent completed without producing a patch that can be reviewed.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const selectedFile = patch.value.files.find((file) => file.path === selectedPath) ?? patch.value.files[0];

  return (
    <PatchReview patch={patch.value} selectedFile={selectedFile} repository={repository} onSelectPath={onSelectPath} />
  );
}

function PatchReview({
  patch,
  selectedFile,
  repository,
  onSelectPath,
}: {
  patch: ValidatedPatch;
  selectedFile: PatchFile;
  repository: string;
  onSelectPath: (path: string) => void;
}) {
  const theme = useMonacoTheme();
  const isMobile = useIsMobile();

  return (
    <div className="space-y-6">
      <ProposalSummary proposal={patch.proposal} repository={repository} baseSha={patch.baseSha} />
      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-5">
          <section aria-labelledby="changed-files-title">
            <h2 id="changed-files-title" className="text-sm font-semibold">
              Changed files ({patch.files.length})
            </h2>
            <ScrollArea className="mt-2 h-56 border-y border-border">
              <div className="divide-y divide-border">
                {patch.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    aria-pressed={file.path === selectedFile.path}
                    onClick={() => onSelectPath(file.path)}
                    className="block w-full px-2 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-muted"
                  >
                    <span className="block break-all font-mono text-xs font-medium">{file.path}</span>
                    <span className="mt-1 flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{file.status}</span>
                      <span className="text-success">+{file.additions}</span>
                      <span className="text-destructive">−{file.deletions}</span>
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </section>

          <section aria-labelledby="validation-title">
            <h2 id="validation-title" className="text-sm font-semibold">
              Server validation
            </h2>
            <div className="mt-2 divide-y divide-border border-y border-border">
              {patch.validations.map((validation) => (
                <ValidationRow key={validation.name} validation={validation} />
              ))}
            </div>
          </section>
        </aside>

        <Card className="min-w-0 overflow-hidden rounded-md shadow-none">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="break-all font-mono text-sm">{selectedFile.path}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <MonacoDiff
              key={selectedFile.path}
              language={selectedFile.language}
              original={selectedFile.original}
              modified={selectedFile.modified}
              theme={theme}
              sideBySide={!isMobile}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProposalSummary({
  proposal,
  repository,
  baseSha,
}: {
  proposal: ValidatedPatch['proposal'];
  repository: string;
  baseSha: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  if (proposal === null) {
    return (
      <Alert className="border-warning/50">
        <CircleAlert className="text-warning-foreground" aria-hidden="true" />
        <AlertTitle>Proposal commit is not available</AlertTitle>
        <AlertDescription>
          The validated diff is available, but its isolated Git branch was not recorded.
        </AlertDescription>
      </Alert>
    );
  }

  const command = `git cherry-pick ${proposal.commitSha}`;

  async function copyCommand() {
    setCopyState('idle');
    try {
      if (!copyWithSelection(command)) await copyWithClipboardApi(command);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return (
    <Card className="border-success/40 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
          Isolated proposal ready
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Omnigent based this commit on the assessed PR head and published it without changing the PR branch.
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Proposal branch</dt>
            <dd className="mt-1 break-all font-mono text-xs">{proposal.branch}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Proposal commit</dt>
            <dd className="mt-1">
              <a
                href={proposal.commitUrl ?? `https://github.com/${repository}/commit/${proposal.commitSha}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {proposal.commitSha.slice(0, 12)}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Based on PR head</dt>
            <dd className="mt-1 break-all font-mono text-xs">{baseSha.slice(0, 12)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <code className="max-w-full overflow-x-auto rounded-sm bg-muted px-2.5 py-1.5 text-xs">{command}</code>
          <Button variant="outline" size="sm" onClick={() => void copyCommand()}>
            <Clipboard aria-hidden="true" />
            {copyState === 'copied' ? 'Copied' : 'Copy cherry-pick command'}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {copyState === 'copied'
              ? 'Cherry-pick command copied to clipboard.'
              : copyState === 'error'
                ? 'Clipboard access failed. Copy the command manually.'
                : ''}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function copyWithSelection(value: string): boolean {
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  field.style.top = '0';
  document.body.append(field);
  field.focus({ preventScroll: true });
  field.select();
  field.setSelectionRange(0, value.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    field.remove();
  }
  return copied;
}

async function copyWithClipboardApi(value: string): Promise<void> {
  if (navigator.clipboard === undefined) throw new Error('Clipboard API is unavailable.');

  await Promise.race([
    navigator.clipboard.writeText(value),
    new Promise<never>((_resolve, reject) => {
      window.setTimeout(() => reject(new Error('Clipboard write timed out.')), 1_500);
    }),
  ]);
}

function ValidationRow({ validation }: { validation: PatchValidation }) {
  const icon =
    validation.status === 'passed' ? (
      <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
    ) : validation.status === 'failed' ? (
      <XCircle className="size-4 text-destructive" aria-hidden="true" />
    ) : (
      <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div className="flex items-start gap-2 py-3 text-sm">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>
        <p className="font-medium">{validation.name}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{validation.message}</p>
      </div>
    </div>
  );
}

function useFixPolling(
  sessionId: string | undefined,
  shouldPoll: boolean,
  onSession: (session: FixSession) => void,
  onError: (error: unknown) => void
) {
  const [updateState, setUpdateState] = useState<ProgressUpdateState>('idle');
  const [retryToken, setRetryToken] = useState(0);
  const sessionHandler = useRef(onSession);
  const errorHandler = useRef(onError);

  useEffect(() => {
    sessionHandler.current = onSession;
    errorHandler.current = onError;
  }, [onError, onSession]);

  useEffect(() => {
    if (!sessionId || !shouldPoll) return;

    let disposed = false;
    let controller: AbortController | undefined;
    let pollTimer: number | undefined;

    async function poll() {
      if (disposed || !sessionId) return;
      setUpdateState('connecting');
      controller = new AbortController();
      try {
        const updated = await getFixSession(sessionId, controller.signal);
        if (disposed) return;
        setUpdateState('connected');
        sessionHandler.current(updated);
        if (!isTerminalSession(updated.status)) pollTimer = window.setTimeout(() => void poll(), 4_000);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setUpdateState('disconnected');
        errorHandler.current(error);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      controller?.abort();
    };
  }, [retryToken, sessionId, shouldPoll]);

  return {
    updateState: !sessionId || !shouldPoll ? 'idle' : updateState,
    retry: () => setRetryToken((value) => value + 1),
  };
}

function useMonacoTheme() {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark' ? 'vs-dark' : 'light';
}

function handleScopedError(
  error: unknown,
  setPermissionLost: (value: boolean) => void,
  setStaleHead: (value: boolean) => void,
  setMessage: (message?: string) => void
) {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      setPermissionLost(true);
      return;
    }
    if (error.status === 409 && (error.code === 'STALE_PULL_REQUEST' || error.code === 'STALE_HEAD')) {
      setStaleHead(true);
      return;
    }
  }
  setMessage(error instanceof Error ? error.message : 'The request could not be completed.');
}

function isTerminalSession(status: FixSession['status']) {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function defaultProgress(status: FixSession['status']) {
  if (status === 'queued') return 8;
  if (status === 'running') return 55;
  if (status === 'validating') return 86;
  if (status === 'complete') return 100;
  return 0;
}

function sessionStatusTitle(status: FixSession['status']) {
  const labels: Record<FixSession['status'], string> = {
    queued: 'Fix request queued',
    running: 'Omnigent is proposing a fix',
    validating: 'Validating proposed changes',
    complete: 'Validated patch ready',
    failed: 'Fix generation failed',
    cancelled: 'Fix generation cancelled',
  };
  return labels[status];
}

function sessionStatusMessage(status: FixSession['status']) {
  const messages: Record<FixSession['status'], string> = {
    queued: 'Waiting for an isolated workspace.',
    running: 'Review will be available only after server-side validation.',
    validating: 'Checking protected paths, content types, and patch integrity.',
    complete: 'The isolated proposal commit and validated diff are ready to inspect.',
    failed: 'Re-run the GitHub check to start a fresh automatic proposal.',
    cancelled: 'No commit was created.',
  };
  return messages[status];
}
