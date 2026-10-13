import { expect, it, vi } from 'vitest';
import type { ApplicationPort, ApplicationEvent } from '@itookit/app-core/application/contracts';
import { ApplicationConfigurationClient } from '../src/application/configuration-port';

it('projects typed configuration operations and releases event subscriptions', async () => {
    let listener: ((event: ApplicationEvent) => void) | undefined;
    const query = vi.fn(async () => []), command = vi.fn(async () => undefined), release = vi.fn();
    const application = { query, command, subscribe: (next: (event: ApplicationEvent) => void) => { listener = next; return release; } } as unknown as ApplicationPort;
    const port = new ApplicationConfigurationClient(application), changed = vi.fn(), unsubscribe = port.subscribe(changed);
    await port.read('queryCosts', undefined);
    expect(query).toHaveBeenCalledWith('configuration', { operation: 'queryCosts', args: [] });
    await port.execute('deleteAgent', 'agent');
    expect(command).toHaveBeenCalledWith('configuration', { operation: 'deleteAgent', args: ['agent'] });
    listener?.({ kind: 'invalidate', scope: 'files', revision: 1 }); expect(changed).not.toHaveBeenCalled();
    listener?.({ kind: 'invalidate', scope: 'configuration', revision: 2 }); expect(changed).toHaveBeenCalledOnce();
    unsubscribe(); expect(release).toHaveBeenCalledOnce();
});
