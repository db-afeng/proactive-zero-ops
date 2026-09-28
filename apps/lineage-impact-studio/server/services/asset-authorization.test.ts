import { describe, expect, it, vi } from 'vitest';

import { authorizeAssets } from './asset-authorization';

const assets = [
  { reference: 'catalog.schema.allowed', assetType: 'unknown' as const },
  { reference: 'catalog.schema.hidden', assetType: 'unknown' as const },
];

describe('authorizeAssets', () => {
  it('binds all identifiers as a JSON parameter and returns a complete matrix', async () => {
    const query = vi.fn().mockResolvedValue({
      data: [
        {
          ordinal: '0',
          asset_reference: 'catalog.schema.allowed',
          can_select: 'true',
          asset_type: 'MATERIALIZED_VIEW',
        },
        {
          ordinal: '1',
          asset_reference: 'catalog.schema.hidden',
          can_select: 'false',
          asset_type: 'UNKNOWN',
        },
      ],
    });

    const decisions = await authorizeAssets({ executor: { query }, queryText: 'SELECT ...', assets });
    expect(decisions.get('catalog.schema.allowed')).toEqual({
      authorized: true,
      assetType: 'materialized_view',
    });
    expect(decisions.get('catalog.schema.hidden')?.authorized).toBe(false);
    expect(query).toHaveBeenCalledOnce();
    const parameters = query.mock.calls[0]?.[1] as { assets_json?: { value?: string } };
    expect(parameters.assets_json).toBeDefined();
  });

  it('fails closed when the access matrix is incomplete or reordered', async () => {
    await expect(
      authorizeAssets({
        executor: {
          query: vi.fn().mockResolvedValue({
            data: [
              {
                ordinal: 1,
                asset_reference: 'catalog.schema.allowed',
                can_select: true,
                asset_type: 'TABLE',
              },
            ],
          }),
        },
        queryText: 'SELECT ...',
        assets,
      })
    ).rejects.toThrow('could not be verified');
  });
});
