import {readFile} from 'node:fs/promises';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import type {CommandOptions} from './commands';

type Service = NonNullable<ApplicationClient['services']['kanban']>;

/** Frozen requests retain their operation IDs and revisions across transport failures. */
export async function kanbanCommand(client: ApplicationClient, args: string[], options: CommandOptions): Promise<unknown> {
    const service = client.services.kanban;
    if (!service) throw Object.assign(new Error('Kanban is unavailable on this host'), {code: 'ECAPABILITY'});
    const [action, boardId, itemId] = args;
    if (action === 'list') return service.catalog();
    if (action === 'principal') return service.currentPrincipal();
    if (action === 'resources' && service.recordResources) return service.recordResources();
    if (action === 'create') return service.create(await jsonFile<Parameters<Service['create']>[0]>(options.file));
    if (action === 'targets') {
        if (!service.automationCatalog) throw Object.assign(new Error('Kanban automation requires a newer host'), {code: 'ECAPABILITY'});
        return service.automationCatalog();
    }
    if (!boardId) throw new Error('Missing board id');
    if (action === 'show') return service.read(boardId);
    if (action === 'workflow') return service.workflow(boardId);
    if (action === 'records') return service.records(boardId);
    if (action === 'events') return service.events(boardId, itemId ? integer(itemId) : undefined);
    if (action === 'execute') return service.execute(boardId, await jsonFile<Parameters<Service['execute']>[1]>(options.file));
    if (action === 'analysis' && itemId && service.analysisStatus) return service.analysisStatus(boardId, itemId);
    if (action === 'item' && itemId) return service.item(boardId, itemId);
    if (action === 'record' && itemId) return service.record(boardId, itemId);
    if (action === 'runs' && itemId && service.recordExecutions) return service.recordExecutions(boardId, itemId);
    if (action === 'run' && service.runRecord) return service.runRecord(boardId, await jsonFile<Parameters<NonNullable<Service['runRecord']>>[1]>(options.file));
    throw new Error('kanban requires list/principal/create/targets/show/workflow/records/events/execute/item/record');
}

export async function jsonFile<T>(path?: string): Promise<T> {
    if (!path) throw new Error('Missing --file JSON request');
    const bytes = await readFile(path);
    if (bytes.byteLength > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be a JSON object');
    return value as T;
}
function integer(value: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid event sequence');
    return number;
}
