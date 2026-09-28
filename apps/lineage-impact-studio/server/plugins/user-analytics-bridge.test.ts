import { sql } from '@databricks/appkit';
import { describe, expect, it, vi } from 'vitest';

import { userAnalyticsBridge } from './user-analytics-bridge';

describe('userAnalyticsBridge', () => {
  it('keeps its receiver when AppKit wraps the exported query function', async () => {
    const query = vi.fn().mockResolvedValue({ data: [] });
    const definition = userAnalyticsBridge({ delegate: { query } });
    const plugin = new definition.plugin(definition.config);
    const detachedQuery = plugin.exports().query;
    const parameters = { assets_json: sql.string('[]') };

    await expect(detachedQuery('SELECT 1', parameters)).resolves.toEqual({ data: [] });
    expect(query).toHaveBeenCalledWith('SELECT 1', parameters);
  });

  it('fails closed until the bound analytics delegate is ready', async () => {
    const definition = userAnalyticsBridge();
    const plugin = new definition.plugin(definition.config);

    await expect(plugin.exports().query('SELECT 1', { assets_json: sql.string('[]') })).rejects.toThrow(
      'Analytics query delegate is not ready'
    );
  });
});
