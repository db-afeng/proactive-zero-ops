import type { GitHubAppClient } from '../integrations/github';
import { GitHubIntegrationError } from '../integrations/github/errors';
import type { GitHubUserCredential, LineageImpactRepository } from '../persistence/repository';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

type CredentialRepository = Pick<LineageImpactRepository, 'loadGitHubCredential' | 'updateGitHubCredential'>;
type RefreshClient = Pick<GitHubAppClient, 'refreshUserToken'>;

/** Keeps expiring GitHub App user tokens usable without exposing them to the browser. */
export class GitHubCredentialService {
  readonly #refreshes = new Map<string, Promise<GitHubUserCredential>>();

  constructor(
    private readonly repository: CredentialRepository,
    private readonly github: RefreshClient
  ) {}

  async loadActive(actorSubject: string, now = new Date()): Promise<GitHubUserCredential | null> {
    const credential = await this.repository.loadGitHubCredential(actorSubject);
    if (credential === null || !needsRefresh(credential, now)) return credential;

    const inFlight = this.#refreshes.get(actorSubject);
    if (inFlight !== undefined) return inFlight;

    const refresh = this.#refresh(actorSubject, credential, now);
    this.#refreshes.set(actorSubject, refresh);
    try {
      return await refresh;
    } finally {
      if (this.#refreshes.get(actorSubject) === refresh) this.#refreshes.delete(actorSubject);
    }
  }

  async #refresh(actorSubject: string, credential: GitHubUserCredential, now: Date): Promise<GitHubUserCredential> {
    if (
      credential.refreshToken === null ||
      (credential.refreshTokenExpiresAt !== null &&
        Date.parse(credential.refreshTokenExpiresAt) <= now.getTime() + ACCESS_TOKEN_REFRESH_SKEW_MS)
    ) {
      throw new GitHubIntegrationError('unauthorized');
    }

    let refreshed: GitHubUserCredential;
    try {
      refreshed = await this.github.refreshUserToken({ refreshToken: credential.refreshToken, now });
    } catch (error) {
      if (error instanceof GitHubIntegrationError && !error.retryable) {
        throw new GitHubIntegrationError('unauthorized');
      }
      throw error;
    }

    const stored = await this.repository.updateGitHubCredential({ actorSubject, credential: refreshed, now });
    if (!stored) throw new GitHubIntegrationError('unauthorized');
    return refreshed;
  }
}

function needsRefresh(credential: GitHubUserCredential, now: Date): boolean {
  return (
    credential.expiresAt !== null && Date.parse(credential.expiresAt) <= now.getTime() + ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}
