import { describe, expect, it } from 'vitest';

import { GitHubIntegrationError } from '../integrations/github/errors';
import { PersistenceError } from '../persistence/repository';
import { OboAuthorizationError } from '../security/obo';
import { isFailedAssessmentStatus, oauthCallbackFailureCode } from './studio-routes';

describe('OAuth callback diagnostics', () => {
  it('reports only allowlisted failure codes', () => {
    expect(oauthCallbackFailureCode(new OboAuthorizationError())).toBe('obo_required');
    expect(oauthCallbackFailureCode(new GitHubIntegrationError('oauth_exchange_failed'))).toBe(
      'github_oauth_exchange_failed'
    );
    expect(oauthCallbackFailureCode(new PersistenceError('invalid_oauth_attempt'))).toBe(
      'persistence_invalid_oauth_attempt'
    );
    expect(oauthCallbackFailureCode(new Error('invalid_oauth_callback'))).toBe('invalid_callback');
    expect(oauthCallbackFailureCode(new Error('contains-sensitive-details'))).toBe('unexpected');
  });
});

describe('automatic fix assessment status gate', () => {
  it.each(['block', 'error'] as const)('accepts failed assessment status %s', (status) => {
    expect(isFailedAssessmentStatus(status)).toBe(true);
  });

  it.each(['pass', 'warn'] as const)('rejects non-failing assessment status %s', (status) => {
    expect(isFailedAssessmentStatus(status)).toBe(false);
  });
});
