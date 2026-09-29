import { describe, expect, it, vi } from 'vitest';

import { authorizeAssets } from './asset-authorization';

function asset(index: number) {
  return { reference: `catalog.schema.asset_${String(index)}`, assetType: 'unknown' as const };
}

function accessError() {
  return Object.assign(new Error('redacted'), { errorCode: 'INSUFFICIENT_PRIVILEGES' });
}

describe('authorizeAssets', () => {
  it('probes a successful batch with parameterized identifiers and no names in SQL text', async () => {
    const assets = [asset(0), asset(1)];
    const query = vi.fn().mockResolvedValue({ data: [] });

    const decisions = await authorizeAssets({ executor: { query }, assets });

    expect([...decisions.values()]).toEqual([
      { authorized: true, assetType: 'unknown' },
      { authorized: true, assetType: 'unknown' },
    ]);
    expect(query).toHaveBeenCalledOnce();
    const [statement, parameters] = query.mock.calls[0] as [string, Record<string, { value?: string }>];
    expect(statement).toContain('IDENTIFIER(:asset_0)');
    expect(statement).toContain('WHERE FALSE');
    expect(statement).not.toContain(assets[0]?.reference);
    expect(statement).not.toContain(assets[1]?.reference);
    expect(parameters.asset_0?.value).toBe(assets[0]?.reference);
    expect(parameters.asset_1?.value).toBe(assets[1]?.reference);
  });

  it('recursively splits access failures until a denied asset is isolated', async () => {
    const assets = [asset(0), asset(1), asset(2), asset(3)];
    const query = vi.fn((_statement: string, parameters: Record<string, { value?: string }>) => {
      const references = Object.values(parameters).map((parameter) => parameter.value);
      if (references.includes(assets[2]?.reference)) return Promise.reject(accessError());
      return Promise.resolve({ data: [] });
    });

    const decisions = await authorizeAssets({ executor: { query }, assets });

    expect(decisions.get(assets[0].reference)?.authorized).toBe(true);
    expect(decisions.get(assets[1].reference)?.authorized).toBe(true);
    expect(decisions.get(assets[2].reference)?.authorized).toBe(false);
    expect(decisions.get(assets[3].reference)?.authorized).toBe(true);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('fails closed without splitting an unknown warehouse failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const assets = [asset(0), asset(1)];
    const query = vi.fn().mockRejectedValue(new Error('sensitive transient detail'));

    const decisions = await authorizeAssets({ executor: { query }, assets });

    expect([...decisions.values()].every((decision) => !decision.authorized)).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive transient detail');
    warning.mockRestore();
  });

  it('aborts timed-out probes and leaves their assets denied', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const query = vi.fn(
      (
        _statement: string,
        _parameters: Record<string, { value?: string }>,
        _formatParameters?: Record<string, unknown>,
        signal?: AbortSignal
      ) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })
    );

    const authorization = authorizeAssets({ executor: { query }, assets: [asset(0)] });
    await vi.advanceTimersByTimeAsync(15_000);
    const decisions = await authorization;

    expect(decisions.get(asset(0).reference)?.authorized).toBe(false);
    expect(query.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    warning.mockRestore();
    vi.useRealTimers();
  });

  it('caps authorization at 64 statements and leaves over-budget assets denied', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const assets = Array.from({ length: 65 }, (_, index) => asset(index));
    const query = vi.fn().mockRejectedValue(accessError());

    const decisions = await authorizeAssets({ executor: { query }, assets });

    expect(query).toHaveBeenCalledTimes(64);
    expect([...decisions.values()].every((decision) => !decision.authorized)).toBe(true);
    expect(warning).toHaveBeenCalledWith('[lineage-impact-studio] Asset access probe budget exhausted');
    warning.mockRestore();
  });

  it('runs no more than four probe statements concurrently', async () => {
    const assets = Array.from({ length: 160 }, (_, index) => asset(index));
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const query = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { data: [] };
    });

    const authorization = authorizeAssets({ executor: { query }, assets });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(4));
    while (query.mock.calls.length < 5) {
      releases.splice(0).forEach((release) => release());
      await Promise.resolve();
    }
    releases.splice(0).forEach((release) => release());
    await authorization;

    expect(maximum).toBe(4);
  });
});
