import { afterEach, expect, it, vi } from 'vitest';
import { windowSessionLeaseToken } from '../src/session-owner';

const KEY = 'mindos.session-owner-token';

/** Minimal storage double: one instance stands for one window. */
function windowStorage(seed?: string): Storage {
    const data = new Map<string, string>(seed ? [[KEY, seed]] : []);
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); },
        removeItem: (key: string) => { data.delete(key); },
        clear: () => data.clear(),
        key: () => null,
        length: 0,
    } as unknown as Storage;
}

afterEach(() => { vi.unstubAllGlobals(); });

it('reuses one lease token per window so a reload keeps its Session leases', () => {
    vi.stubGlobal('sessionStorage', windowStorage());
    const token = windowSessionLeaseToken();
    expect(token).toBeTruthy();
    expect(windowSessionLeaseToken()).toBe(token);
    // A second window has its own storage and therefore its own token.
    vi.stubGlobal('sessionStorage', windowStorage());
    expect(windowSessionLeaseToken()).not.toBe(token);
    // An existing token from the same window is adopted instead of replaced.
    vi.stubGlobal('sessionStorage', windowStorage('kept-token'));
    expect(windowSessionLeaseToken()).toBe('kept-token');
});

it('falls back to a fresh token when window storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); } });
    const blocked = windowSessionLeaseToken();
    expect(blocked).toBeTruthy();
    vi.stubGlobal('sessionStorage', undefined);
    expect(windowSessionLeaseToken()).toBeTruthy();
});
