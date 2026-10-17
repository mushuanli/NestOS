import { expect, it, vi } from 'vitest';
import type { OcrService } from '@itookit/app-contracts/services';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { OcrAccess } from '../src/configuration/ocr-access';

function fixture(load?: () => Promise<OcrService>) {
    const stopAgent = vi.fn(), stopOcr = vi.fn(), subscribe = vi.fn(() => stopOcr), onChange = vi.fn(() => stopAgent);
    const service = { subscribe } as unknown as OcrService, create = vi.fn(load ?? (async () => service));
    return { access: new OcrAccess(create, { onChange } as unknown as IAgentManagementService), create, subscribe, stopAgent, stopOcr, onChange, service };
}
it('keeps subscription local until first use and shares one remote subscription', async () => {
    const f = fixture(), first = vi.fn(), second = vi.fn(), stopFirst = f.access.subscribe(first);
    expect(f.create).not.toHaveBeenCalled(); expect(f.subscribe).not.toHaveBeenCalled();
    await Promise.all([f.access.get(), f.access.get()]);
    const stopSecond = f.access.subscribe(second);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.onChange).toHaveBeenCalledOnce();
    const notify = f.subscribe.mock.calls[0] as unknown as [() => void]; notify[0]();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    stopFirst(); expect(f.stopOcr).not.toHaveBeenCalled(); expect(f.stopAgent).not.toHaveBeenCalled();
    stopSecond(); expect(f.stopOcr).toHaveBeenCalledOnce(); await f.access.close();
});
it('does not bind a remote listener after an in-flight access has been unsubscribed', async () => {
    let finish!: (service: OcrService) => void;
    const f = fixture(() => new Promise(resolve => { finish = resolve; })), stop = f.access.subscribe(vi.fn());
    const pending = f.access.get(); await Promise.resolve(); stop(); finish(f.service); await pending;
    expect(f.subscribe).not.toHaveBeenCalled(); await f.access.close();
});
it('closes both configuration and agent subscriptions even without consumer cleanup', async () => {
    const f = fixture(); const stop = f.access.subscribe(vi.fn()); await f.access.get();
    await f.access.close(); stop(); await f.access.close();
    expect(f.stopOcr).toHaveBeenCalledOnce(); expect(f.stopAgent).toHaveBeenCalledOnce();
    f.access.subscribe(vi.fn()); expect(f.onChange).toHaveBeenCalledOnce();
    await expect(f.access.get()).rejects.toMatchObject({ code: 'EIO' });
});

it('keeps independent OCR consumers notified when one observer throws', async () => {
    const f = fixture(), second = vi.fn(), log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        f.access.subscribe(() => {throw new Error('Broken observer');}); f.access.subscribe(second);
        const [notify] = f.onChange.mock.calls[0] as unknown as [() => void]; notify();
        expect(second).toHaveBeenCalledOnce(); expect(f.onChange).toHaveBeenCalledOnce();
    } finally {await f.access.close(); log.mockRestore();}
});
