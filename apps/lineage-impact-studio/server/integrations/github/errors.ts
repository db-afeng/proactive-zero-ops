export type GitHubIntegrationErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'oauth_exchange_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'not_found'
  | 'invalid_response'
  | 'repository_mismatch'
  | 'fork_not_supported'
  | 'pull_request_closed'
  | 'base_changed'
  | 'head_changed'
  | 'read_not_permitted'
  | 'write_not_permitted'
  | 'unsafe_change'
  | 'conflict'
  | 'request_failed';

/** A deliberately sanitized error that never includes response bodies or credentials. */
export class GitHubIntegrationError extends Error {
  override readonly name = 'GitHubIntegrationError';

  constructor(
    readonly code: GitHubIntegrationErrorCode,
    readonly retryable = false
  ) {
    super(errorMessage(code));
  }
}

function errorMessage(code: GitHubIntegrationErrorCode): string {
  switch (code) {
    case 'invalid_configuration':
      return 'GitHub integration is not configured safely';
    case 'invalid_request':
      return 'GitHub request is invalid';
    case 'oauth_exchange_failed':
      return 'GitHub authorization could not be completed';
    case 'unauthorized':
      return 'GitHub authorization is no longer valid';
    case 'forbidden':
      return 'GitHub denied this operation';
    case 'rate_limited':
      return 'GitHub rate limit was reached';
    case 'not_found':
      return 'GitHub resource was not found';
    case 'invalid_response':
      return 'GitHub returned an invalid response';
    case 'repository_mismatch':
      return 'Pull request does not belong to the configured repository';
    case 'fork_not_supported':
      return 'Fork pull requests are not supported';
    case 'pull_request_closed':
      return 'Pull request is no longer open';
    case 'base_changed':
      return 'Pull request base changed';
    case 'head_changed':
      return 'Pull request head changed';
    case 'read_not_permitted':
      return 'GitHub identity cannot read this repository';
    case 'write_not_permitted':
      return 'GitHub identity cannot write to this pull request';
    case 'unsafe_change':
      return 'Proposed change did not pass repository safety checks';
    case 'conflict':
      return 'GitHub rejected the commit because the branch changed';
    case 'request_failed':
      return 'GitHub request failed';
  }
}
