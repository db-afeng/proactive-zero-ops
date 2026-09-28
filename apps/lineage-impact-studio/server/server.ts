import { READ_ACTIONS, analytics, createApp, files, lakebase, server } from '@databricks/appkit';

import { userAnalyticsBridge, type AnalyticsQueryDelegate } from './plugins/user-analytics-bridge';
import { setupStudioRoutes } from './routes/studio-routes';
import type { VolumeReader } from './services/restricted-envelope-reader';

const analyticsDelegate: AnalyticsQueryDelegate = {};

createApp({
  plugins: [
    analytics(),
    userAnalyticsBridge({ delegate: analyticsDelegate }),
    files({
      volumes: {
        files: {
          auth: 'service-principal',
          maxReadSize: 8 * 1024 * 1024,
          policy: (action, _resource, user) => user.isServicePrincipal === true && READ_ACTIONS.has(action),
        },
      },
    }),
    lakebase(),
    server(),
  ],
  async onPluginsReady(appkit) {
    analyticsDelegate.query = appkit.analytics.query;
    const filesExport: unknown = Reflect.get(appkit, 'files');
    if (typeof filesExport !== 'function') throw new Error('Files plugin is not available');
    const volume: unknown = Reflect.apply(filesExport, undefined, ['files']);
    if (!isVolumeReader(volume)) throw new Error('Restricted assessment Volume is not available');
    await setupStudioRoutes({
      analytics: appkit.userAnalyticsBridge,
      volume,
      lakebase: appkit.lakebase,
      server: appkit.server,
    });
  },
}).catch(console.error);

function isVolumeReader(value: unknown): value is VolumeReader {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'read') === 'function';
}
