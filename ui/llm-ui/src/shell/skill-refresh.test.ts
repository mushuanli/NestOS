import { expect, it, vi } from 'vitest';
import type { SessionSkillControls } from '@itookit/tools/contracts';
import { bindSkillRefresh } from './skill-refresh';
import type { SkillInfo } from '../domain/types';

const skill = (id: string): SkillInfo => ({
    id, name: id, description: '', loaded: true, enabled: true, definitionEnabled: true, toolCount: 0,
});

/** Minimal controls double: records listeners so tests can fire catalog changes by hand. */
function fakeControls(list: SessionSkillControls['list']) {
    const listeners: Array<() => void> = [];
    const off = vi.fn();
    const onChange = vi.fn(async (_sessionId: string, listener: () => void) => {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); off(); };
    });
    return { controls: { list, onChange } as unknown as SessionSkillControls, fire: () => listeners.forEach(l => l()), off, onChange };
}

it('renders the current catalog on bind and again on every change notification', async () => {
    const list = vi.fn(async () => [skill('review')]);
    const { controls, fire } = fakeControls(list);
    const rendered: SkillInfo[][] = [];
    const { dispose } = bindSkillRefresh(controls, 'session', skills => rendered.push(skills));
    await vi.waitFor(() => expect(rendered).toEqual([[skill('review')]]));

    list.mockResolvedValue([skill('review'), skill('debug')]);
    fire();
    await vi.waitFor(() => expect(rendered).toHaveLength(2));
    expect(rendered[1].map(s => s.id)).toEqual(['review', 'debug']);
    expect(list).toHaveBeenCalledTimes(2);

    // Disposal detaches the Session subscription, so later changes cost nothing.
    dispose();
    fire();
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(2);
});

it('detaches a subscription that resolves after disposal and ignores a late catalog fetch', async () => {
    let releaseList!: (skills: SkillInfo[]) => void;
    const list = vi.fn(() => new Promise<SkillInfo[]>(resolve => { releaseList = resolve; }));
    const { controls, off, onChange } = fakeControls(list);
    const rendered: SkillInfo[][] = [];
    const { dispose } = bindSkillRefresh(controls, 'session', skills => rendered.push(skills));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    dispose();
    releaseList([skill('review')]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1));
    expect(rendered).toEqual([]);
});

it('keeps the panel usable when listing or subscribing fails', async () => {
    const list = vi.fn(async () => { throw new Error('no scope'); });
    const onChange = vi.fn(async () => { throw new Error('no scope'); });
    const controls = { list, onChange } as unknown as SessionSkillControls;
    const rendered: SkillInfo[][] = [];
    expect(() => bindSkillRefresh(controls, 'session', skills => rendered.push(skills)).dispose()).not.toThrow();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(rendered).toEqual([]);
});

it('survives a host that throws synchronously instead of rejecting', async () => {
    const controls = {
        list: () => { throw new Error('no scope'); },
        onChange: () => { throw new Error('no scope'); },
    } as unknown as SessionSkillControls;
    const rendered: SkillInfo[][] = [];
    const { dispose } = bindSkillRefresh(controls, 'session', skills => rendered.push(skills));
    await Promise.resolve().then(() => Promise.resolve());
    expect(rendered).toEqual([]);
    expect(dispose).not.toThrow();
});


it('discards an obsolete response and reloads after changes during a request', async () => {
    let finish!: (skills: SkillInfo[]) => void;
    const list = vi.fn().mockImplementationOnce(() => new Promise<SkillInfo[]>(resolve => { finish = resolve; }))
        .mockResolvedValue([skill('new')]);
    const { controls, fire } = fakeControls(list);
    const rendered: SkillInfo[][] = [];
    const binding = bindSkillRefresh(controls, 's', skills => rendered.push(skills));
    try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        fire(); binding.refresh();
        finish([skill('old')]);
        await vi.waitFor(() => expect(rendered).toEqual([[skill('new')]]));
        expect(list).toHaveBeenCalledTimes(2);
    } finally { binding.dispose(); }
});
