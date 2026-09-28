import { Plugin, toPlugin, type BasePluginConfig, type PluginManifest } from '@databricks/appkit';

import type { UserAnalyticsExecutor } from '../services/asset-authorization';

export interface AnalyticsQueryDelegate {
  query?: UserAnalyticsExecutor['query'];
}

interface UserAnalyticsBridgeConfig extends BasePluginConfig {
  delegate?: AnalyticsQueryDelegate;
}

/**
 * Preserve AppKit's OBO execution context while calling the bound analytics export.
 *
 * AppKit 0.57.0 loses the AnalyticsPlugin receiver when wrapping its public
 * `query` export with `asUser()`. This bridge's arrow export retains its receiver,
 * enters the normal AppKit user context, and then invokes the already-bound
 * analytics query function.
 */
class UserAnalyticsBridgePlugin extends Plugin<UserAnalyticsBridgeConfig> {
  static manifest = {
    name: 'userAnalyticsBridge',
    displayName: 'User Analytics Bridge',
    description: 'Runs the bound analytics query export in AppKit user context.',
    hidden: true,
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<'userAnalyticsBridge'>;

  override exports() {
    return {
      query: async (...args: Parameters<UserAnalyticsExecutor['query']>) => {
        const query = this.config.delegate?.query;
        if (query === undefined) throw new Error('Analytics query delegate is not ready');
        return await query(...args);
      },
    };
  }
}

export const userAnalyticsBridge = toPlugin(UserAnalyticsBridgePlugin);
