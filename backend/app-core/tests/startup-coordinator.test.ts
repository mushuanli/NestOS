import { describe, expect, it, vi } from 'vitest';
import { StartupCoordinator } from '../src/runtime/startup-coordinator';
import { applicationStartupPolicy } from '../src/runtime/startup-policy';

function harness(concurrency = 2) {
    const report = vi.fn();
    const coordinator = new StartupCoordinator({ trace: (_label, run) => run(), report }, concurrency);
    return { coordinator, report };
}

function deferred() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

describe('startup coordination', () => {
    it('shares first-use readiness and preserves initialization failures', async () => {
        const { coordinator } = harness();
        const failure = new Error('unavailable');
        const action = vi.fn().mockRejectedValue(failure);
        const ready = coordinator.task('resource', action);
        const first = ready();
        expect(ready()).toBe(first);
        await expect(first).rejects.toBe(failure);
        await expect(ready()).rejects.toBe(failure);
        expect(action).toHaveBeenCalledOnce();
        await coordinator.close();
    });

    it('bounds deferred concurrency, isolates failures and activates once', async () => {
        const { coordinator, report } = harness();
        const gate = deferred();
        const first = vi.fn(() => gate.promise);
        const failure = new Error('failed');
        const last = vi.fn(async () => {});
        coordinator.schedule('after-ready', 'first', first);
        coordinator.schedule('after-ready', 'failed', async () => { await gate.promise; throw failure; });
        coordinator.schedule('after-ready', 'last', last);
        expect(first).not.toHaveBeenCalled();
        coordinator.activate(); coordinator.activate();
        await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
        expect(last).not.toHaveBeenCalled();
        gate.release();
        await vi.waitFor(() => expect(last).toHaveBeenCalledOnce());
        expect(report).toHaveBeenCalledWith('failed', failure);
        await coordinator.close();
    });

    it('drains accepted work and prevents deferred tasks from starting during close', async () => {
        const { coordinator } = harness(1);
        const gate = deferred();
        const started = vi.fn(() => gate.promise);
        const skipped = vi.fn(async () => {});
        coordinator.schedule('after-ready', 'running', started);
        coordinator.schedule('after-ready', 'skipped', skipped);
        coordinator.activate();
        await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
        const closing = coordinator.close();
        expect(coordinator.close()).toBe(closing);
        let closed = false; void closing.then(() => { closed = true; });
        await Promise.resolve(); expect(closed).toBe(false);
        gate.release(); await closing;
        expect(skipped).not.toHaveBeenCalled();
        await expect(coordinator.task('late', skipped)()).rejects.toThrow('closed');
    });

    it('blocks required tasks while background tasks leave the caller ready', async () => {
        const { coordinator } = harness();
        const gate = deferred();
        expect(coordinator.schedule('background', 'background', () => gate.promise)).toBeUndefined();
        const required = coordinator.schedule('before-ready', 'required', () => gate.promise);
        expect(required).toBeInstanceOf(Promise);
        gate.release(); await required; await coordinator.close();
    });

    it('drains accepted work that awaits its already initialized dependency after close begins', async () => {
        const {coordinator, report} = harness(), gate = deferred(), initialize = vi.fn(async () => 'ready');
        const dependency = coordinator.task('dependency', initialize), first = dependency(); await first;
        const work = coordinator.task('accepted work', async () => {await gate.promise; return dependency();})();
        const closing = coordinator.close(); gate.release();
        expect(await work).toBe('ready'); await closing;
        expect(dependency()).toBe(first); expect(initialize).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled();
        await expect(coordinator.task('new work', async () => {})()).rejects.toThrow('closed');
    });

    it('retains the original initialization failure for a dependency read during shutdown', async () => {
        const {coordinator} = harness(), failure = new Error('Original initialization failed');
        const dependency = coordinator.task('dependency', async () => {throw failure;});
        await expect(dependency()).rejects.toBe(failure); await coordinator.close();
        await expect(dependency()).rejects.toBe(failure);
    });

    it('selects host policy without performing initialization', () => {
        expect(applicationStartupPolicy('interactive')).toMatchObject({ projects: 'on-demand', agents: 'after-ready' });
        expect(applicationStartupPolicy()).toMatchObject({ projects: 'before-ready', invocations: 'before-ready' });
        expect(applicationStartupPolicy('server')).toMatchObject({ llm: 'before-ready', mcp: 'before-ready', skills: 'before-ready',
            agents: 'before-ready', projects: 'before-ready', drafts: 'before-ready', invocations: 'before-ready', workers: 'before-ready' });
        expect(() => harness(0)).toThrow(RangeError);
    });
});
