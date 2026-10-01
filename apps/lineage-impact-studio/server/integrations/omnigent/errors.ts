export type OmnigentIntegrationErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'git_credential_unavailable'
  | 'git_credential_access_denied'
  | 'git_credential_missing'
  | 'git_credential_ambiguous'
  | 'request_failed';

/** A sanitized error which never carries response bodies, prompts, or credentials. */
export class OmnigentIntegrationError extends Error {
  override readonly name = 'OmnigentIntegrationError';

  constructor(
    readonly code: OmnigentIntegrationErrorCode,
    readonly status: number | null = null,
    readonly retryable = false
  ) {
    super(messageFor(code));
  }
}

function messageFor(code: OmnigentIntegrationErrorCode): string {
  switch (code) {
    case 'invalid_configuration':
      return 'Omnigent integration is not configured safely';
    case 'invalid_request':
      return 'Omnigent rejected the fix request';
    case 'unauthorized':
      return 'Omnigent authentication is no longer valid';
    case 'forbidden':
      return 'Omnigent denied this operation';
    case 'not_found':
      return 'Omnigent session was not found';
    case 'conflict':
      return 'Omnigent could not apply the requested session transition';
    case 'rate_limited':
      return 'Omnigent rate limit was reached';
    case 'unavailable':
      return 'Omnigent is temporarily unavailable';
    case 'invalid_response':
      return 'Omnigent returned an invalid response';
    case 'git_credential_unavailable':
      return 'Databricks could not prepare private repository access for Omnigent';
    case 'git_credential_access_denied':
      return 'The app cannot read your Databricks Git credentials. Check its workspace authorization and try again.';
    case 'git_credential_missing':
      return 'Add a GitHub Git credential to your Databricks workspace before starting a manual fix.';
    case 'git_credential_ambiguous':
      return 'Set one GitHub Git credential as your workspace default before starting a manual fix.';
    case 'request_failed':
      return 'Omnigent request failed';
  }
}
