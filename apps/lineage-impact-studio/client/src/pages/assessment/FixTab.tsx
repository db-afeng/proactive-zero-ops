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
  Separator,
  Skeleton,
  Textarea,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Code2,
  ExternalLink,
  FileCode2,
  Github,
  Link2Off,
  LoaderCircle,
  RotateCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';

import { MonacoDiff } from '@/components/MonacoDiff';
import {
  ApiRequestError,
  approvePatch,
  cancelFixSession,
  commitPatch,
  createFixSession,
  disconnectGitHub,
  getCapabilities,
  getFixSession,
  getGitHubStatus,
  getValidatedPatch,
  githubLoginUrl,
} from '@/lib/api';
import type {
  AssessmentViewV3,
  Capabilities,
  CommitOutcome,
  FixSession,
  FixStreamEvent,
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

type StreamState = 'idle' | 'connecting' | 'connected' | 'disconnected';

const GUIDANCE_LIMIT = 1200;

export function FixTab({ assessment, active }: { assessment: AssessmentViewV3; active: boolean }) {
  const [github, setGitHub] = useState<Loadable<GitHubConnection>>({ kind: 'idle' });
  const [capabilities, setCapabilities] = useState<Loadable<Capabilities>>({ kind: 'idle' });
  const [prerequisiteRetry, setPrerequisiteRetry] = useState(0);
  const [guidance, setGuidance] = useState('');
  const [session, setSession] = useState<FixSession>();
  const [patch, setPatch] = useState<Loadable<ValidatedPatch>>({ kind: 'idle' });
  const [selectedPath, setSelectedPath] = useState<string>();
  const [approvedAt, setApprovedAt] = useState<string>();
  const [commitOutcome, setCommitOutcome] = useState<CommitOutcome>();
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
    if (!active || !session?.id || isTerminalSession(session.status)) return;
    const controller = new AbortController();
    void getFixSession(session.id, controller.signal)
      .then((value) => setSession(value))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        handleScopedError(error, setPermissionLost, setStaleHead, setActionError);
      });
    return () => controller.abort();
  }, [active, session?.id, session?.status]);

  const shouldStream = active && session !== undefined && !isTerminalSession(session.status) && !permissionLost;
  const { streamState, reconnect } = useFixStream(session?.id, shouldStream, (updatedSession) =>
    setSession(updatedSession)
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

  const githubConnection = github.kind === 'ready' ? github.value : undefined;
  const omnigent = capabilities.kind === 'ready' ? capabilities.value.omnigent : undefined;
  const prerequisitesLoading =
    github.kind === 'idle' ||
    github.kind === 'loading' ||
    capabilities.kind === 'idle' ||
    capabilities.kind === 'loading';
  const canStart =
    guidance.trim().length > 0 &&
    githubConnection?.connected === true &&
    omnigent?.available === true &&
    assessment.source.freshness === 'current' &&
    !actionPending &&
    !permissionLost;

  async function startSession() {
    if (!canStart) return;
    setActionPending(true);
    setActionError(undefined);
    setStaleHead(false);
    setPermissionLost(false);
    setPatch({ kind: 'idle' });
    setApprovedAt(undefined);
    setCommitOutcome(undefined);
    try {
      const created = await createFixSession(assessment.reference, guidance.trim(), assessment.pullRequest.headSha);
      setSession(created);
    } catch (error) {
      handleScopedError(error, setPermissionLost, setStaleHead, setActionError);
    } finally {
      setActionPending(false);
    }
  }

  async function cancelSession() {
    if (!session) return;
    setActionPending(true);
    setActionError(undefined);
    try {
      setSession(await cancelFixSession(session.id));
    } catch (error) {
      handleScopedError(error, setPermissionLost, setStaleHead, setActionError);
    } finally {
      setActionPending(false);
    }
  }

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

  function resetSession() {
    setSession(undefined);
    setPatch({ kind: 'idle' });
    setSelectedPath(undefined);
    setApprovedAt(undefined);
    setCommitOutcome(undefined);
    setActionError(undefined);
    setPermissionLost(false);
    setStaleHead(false);
  }

  return (
    <section aria-labelledby="fix-title" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="fix-title" className="text-2xl font-semibold tracking-tight">
            Propose a fix
          </h1>
          <p className="mt-1 max-w-[72ch] text-sm leading-6 text-muted-foreground">
            Omnigent receives only evidence authorized for your Databricks identity. Generated code is validated before
            it can be approved or committed.
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
            Your Databricks or GitHub access changed during this review. No service identity result was substituted.
            Reload after access is restored.
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
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
          <div className="space-y-3">
            <label htmlFor="fix-guidance" className="text-sm font-medium">
              Guidance for Omnigent
            </label>
            <Textarea
              id="fix-guidance"
              value={guidance}
              maxLength={GUIDANCE_LIMIT}
              rows={5}
              disabled={!omnigent?.available || permissionLost}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder="Describe the intended behavior, constraints, or preferred implementation approach."
              aria-describedby="fix-guidance-help"
            />
            <div
              id="fix-guidance-help"
              className="flex items-start justify-between gap-4 text-xs text-muted-foreground"
            >
              <p className="max-w-[65ch]">
                Do not include secrets. Repository content and authorized assessment evidence are supplied by the
                server.
              </p>
              <span className="shrink-0 tabular-nums">
                {guidance.length}/{GUIDANCE_LIMIT}
              </span>
            </div>
            <Button
              onClick={() => void startSession()}
              disabled={!canStart}
              aria-describedby={!canStart ? 'fix-start-requirements' : undefined}
            >
              {actionPending ? (
                <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Code2 aria-hidden="true" />
              )}
              Generate fix
            </Button>
            {!canStart ? (
              <p id="fix-start-requirements" className="text-xs text-muted-foreground">
                {startRequirement(
                  prerequisitesLoading,
                  githubConnection,
                  omnigent,
                  assessment.source.freshness,
                  guidance
                )}
              </p>
            ) : null}
          </div>

          <aside className="border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <h2 className="text-sm font-semibold">Safety boundary</h2>
            <ul className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
              <li>Uses an isolated checkout of the assessed PR head.</li>
              <li>Never executes commands supplied by the pull request.</li>
              <li>Rejects protected paths, forks, binary files, and stale heads.</li>
              <li>Creates at most one normal commit after explicit approval.</li>
            </ul>
          </aside>
        </div>
      ) : (
        <div className="space-y-6">
          <SessionProgress
            session={session}
            streamState={streamState}
            actionPending={actionPending}
            onCancel={() => void cancelSession()}
            onReconnect={reconnect}
            onReset={resetSession}
          />

          {session.status === 'complete' ? (
            <PatchArea
              patch={patch}
              selectedPath={selectedPath}
              approvedAt={approvedAt ?? session.approvedAt}
              commitOutcome={commitOutcome}
              actionPending={actionPending}
              permissionLost={permissionLost}
              staleHead={staleHead}
              repository={assessment.pullRequest.repository}
              expectedHeadSha={assessment.pullRequest.headSha}
              onSelectPath={setSelectedPath}
              onApproval={(value) => setApprovedAt(value)}
              onCommitOutcome={setCommitOutcome}
              onActionPending={setActionPending}
              onPermissionLost={setPermissionLost}
              onStaleHead={setStaleHead}
              onError={setActionError}
            />
          ) : null}
        </div>
      )}
    </section>
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
  streamState,
  actionPending,
  onCancel,
  onReconnect,
  onReset,
}: {
  session: FixSession;
  streamState: StreamState;
  actionPending: boolean;
  onCancel: () => void;
  onReconnect: () => void;
  onReset: () => void;
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
        {active ? (
          <Button variant="outline" size="sm" disabled={actionPending} onClick={onCancel}>
            Cancel
          </Button>
        ) : session.status === 'failed' || session.status === 'cancelled' ? (
          <Button variant="outline" size="sm" onClick={onReset}>
            Start over
          </Button>
        ) : null}
      </div>

      {active ? (
        <div className="space-y-2">
          <Progress value={progress} aria-label={`Fix generation ${String(progress)} percent`} />
          <p className="text-xs tabular-nums text-muted-foreground">{progress}% complete</p>
        </div>
      ) : null}

      {streamState === 'disconnected' && active ? (
        <Alert className="border-warning/50">
          <Link2Off className="text-warning-foreground" aria-hidden="true" />
          <AlertTitle>Progress stream disconnected</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>The session is still running. Reconnect to continue receiving live progress.</p>
            <Button variant="outline" size="sm" onClick={onReconnect}>
              <RotateCw aria-hidden="true" />
              Reconnect stream
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
  approvedAt,
  commitOutcome,
  actionPending,
  permissionLost,
  staleHead,
  repository,
  expectedHeadSha,
  onSelectPath,
  onApproval,
  onCommitOutcome,
  onActionPending,
  onPermissionLost,
  onStaleHead,
  onError,
}: {
  patch: Loadable<ValidatedPatch>;
  selectedPath?: string;
  approvedAt?: string;
  commitOutcome?: CommitOutcome;
  actionPending: boolean;
  permissionLost: boolean;
  staleHead: boolean;
  repository: string;
  expectedHeadSha: string;
  onSelectPath: (path: string) => void;
  onApproval: (approvedAt: string) => void;
  onCommitOutcome: (outcome: CommitOutcome) => void;
  onActionPending: (pending: boolean) => void;
  onPermissionLost: (lost: boolean) => void;
  onStaleHead: (stale: boolean) => void;
  onError: (message?: string) => void;
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
    <PatchReview
      patch={patch.value}
      selectedFile={selectedFile}
      approvedAt={approvedAt}
      commitOutcome={commitOutcome}
      actionPending={actionPending}
      permissionLost={permissionLost}
      staleHead={staleHead}
      repository={repository}
      expectedHeadSha={expectedHeadSha}
      onSelectPath={onSelectPath}
      onApproval={onApproval}
      onCommitOutcome={onCommitOutcome}
      onActionPending={onActionPending}
      onPermissionLost={onPermissionLost}
      onStaleHead={onStaleHead}
      onError={onError}
    />
  );
}

function PatchReview({
  patch,
  selectedFile,
  approvedAt,
  commitOutcome,
  actionPending,
  permissionLost,
  staleHead,
  repository,
  expectedHeadSha,
  onSelectPath,
  onApproval,
  onCommitOutcome,
  onActionPending,
  onPermissionLost,
  onStaleHead,
  onError,
}: {
  patch: ValidatedPatch;
  selectedFile: PatchFile;
  approvedAt?: string;
  commitOutcome?: CommitOutcome;
  actionPending: boolean;
  permissionLost: boolean;
  staleHead: boolean;
  repository: string;
  expectedHeadSha: string;
  onSelectPath: (path: string) => void;
  onApproval: (approvedAt: string) => void;
  onCommitOutcome: (outcome: CommitOutcome) => void;
  onActionPending: (pending: boolean) => void;
  onPermissionLost: (lost: boolean) => void;
  onStaleHead: (stale: boolean) => void;
  onError: (message?: string) => void;
}) {
  const theme = useMonacoTheme();
  const isMobile = useIsMobile();
  const validationsPassed = patch.validations.every((item) => item.status === 'passed');

  async function approveOrCommit() {
    onActionPending(true);
    onError(undefined);
    try {
      if (!approvedAt) {
        const result = await approvePatch(patch.sessionId, patch.patchDigest, expectedHeadSha);
        onApproval(result.approvedAt ?? new Date().toISOString());
      } else {
        onCommitOutcome(await commitPatch(patch.sessionId, patch.patchDigest, expectedHeadSha));
      }
    } catch (error) {
      handleScopedError(error, onPermissionLost, onStaleHead, onError);
    } finally {
      onActionPending(false);
    }
  }

  return (
    <div className="space-y-6">
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

      <Separator />

      <section aria-labelledby="approval-title" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h2 id="approval-title" className="text-base font-semibold">
            Approval boundary
          </h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Expected PR head</dt>
              <dd className="mt-1 break-all font-mono text-xs">{expectedHeadSha}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Patch digest</dt>
              <dd className="mt-1 break-all font-mono text-xs">{patch.patchDigest}</dd>
            </div>
          </dl>
          {approvedAt ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Approved {formatDateTime(approvedAt)}
            </p>
          ) : null}
        </div>

        <div className="flex items-end">
          <Button
            onClick={() => void approveOrCommit()}
            disabled={!validationsPassed || actionPending || permissionLost || staleHead || commitOutcome !== undefined}
          >
            {actionPending ? (
              <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
            ) : approvedAt ? (
              <Github aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
            {commitOutcome ? 'Commit recorded' : approvedAt ? 'Commit approved patch' : 'Approve this patch'}
          </Button>
        </div>
      </section>

      {!validationsPassed ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Patch cannot be approved</AlertTitle>
          <AlertDescription>
            Every server-side policy and content validation must pass before approval.
          </AlertDescription>
        </Alert>
      ) : null}

      {commitOutcome ? (
        <Alert className="border-success/40">
          <CheckCircle2 className="text-success" aria-hidden="true" />
          <AlertTitle>{commitOutcome.message ?? 'Commit completed'}</AlertTitle>
          <AlertDescription>
            {commitOutcome.commitSha ? (
              <a
                href={`https://github.com/${repository}/commit/${commitOutcome.commitSha}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {commitOutcome.commitSha}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : (
              commitOutcome.outcome
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
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

function useFixStream(sessionId: string | undefined, shouldStream: boolean, onSession: (session: FixSession) => void) {
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [reconnectToken, setReconnectToken] = useState(0);
  const sessionHandler = useRef(onSession);

  useEffect(() => {
    sessionHandler.current = onSession;
  }, [onSession]);

  useEffect(() => {
    if (!sessionId || !shouldStream) {
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempt = 0;

    function connect() {
      if (disposed || !sessionId) return;
      setStreamState('connecting');
      const url = new URL(`/api/fix-sessions/${encodeURIComponent(sessionId)}/stream`, window.location.href);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);

      socket.addEventListener('open', () => {
        attempt = 0;
        setStreamState('connected');
      });
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as FixStreamEvent;
          if (payload.session?.id === sessionId) sessionHandler.current(payload.session);
        } catch {
          // Ignore malformed stream frames. The authoritative session can still be read over HTTP.
        }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        setStreamState('disconnected');
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        socket?.close();
      });
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [reconnectToken, sessionId, shouldStream]);

  return {
    streamState: !sessionId || !shouldStream ? 'idle' : streamState,
    reconnect: () => setReconnectToken((value) => value + 1),
  };
}

function useMonacoTheme() {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark' ? 'vs-dark' : 'light';
}

function startRequirement(
  loading: boolean,
  github: GitHubConnection | undefined,
  omnigent: Capabilities['omnigent'] | undefined,
  freshness: AssessmentViewV3['source']['freshness'],
  guidance: string
) {
  if (loading) return 'Checking GitHub connection and workspace capabilities.';
  if (freshness !== 'current') return 'A current assessment is required.';
  if (!github?.connected) return 'Connect your GitHub identity to continue.';
  if (!omnigent?.available) return omnigent?.reason ?? 'Omnigent is unavailable.';
  if (!guidance.trim()) return 'Add short guidance for the proposed fix.';
  return 'Fix generation is not available.';
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
    if (error.status === 409) {
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
    complete: 'Review every changed file before recording approval.',
    failed: 'No commit was created.',
    cancelled: 'No commit was created.',
  };
  return messages[status];
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
