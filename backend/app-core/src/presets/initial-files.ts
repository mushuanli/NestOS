import type { IFileSystem } from '@itookit/vfs-core';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import demo from './digital-twin-demo.json';
import { createMindosFlowLibrary } from './flow-library';
import { essayReviewDraft } from './default-flows';
import { restoreAndPublishFlow } from './restore-flows';

const noteWrites = new WeakMap<IFileSystem, Promise<boolean>>();

export interface InitialFileEntry { id: string; group: 'notes' | 'flows'; name: string; path: string; exists: boolean; }
export interface InitialFileResult { id: string; status: 'restored' | 'preserved' | 'failed'; error?: string; }

/** Explicit recovery writes through the active workspace and existing Flow commands. */
export class MindosInitialFiles {
    private readonly flows = [...createMindosFlowLibrary(), essayReviewDraft()];
    constructor(private readonly commands: ICommandBus, private readonly notes?: IFileSystem) {}
    async list(): Promise<InitialFileEntry[]> {
        const entries: InitialFileEntry[] = [];
        if (this.notes) entries.push({ id: 'note:demo', group: 'notes', name: demo.name,
            path: `/home/admin/minds/${demo.name}`, exists: await this.notes.driver.exists('/' + demo.name) });
        for (const flow of this.flows) entries.push({ id: 'flow:' + flow.id, group: 'flows', name: `${flow.id}.flow`,
            path: `/home/admin/flows/${flow.id}.flow`, exists: Boolean(await this.commands.execute(FlowCommand.DraftLoad, { id: flow.id })) });
        return entries;
    }
    async restore(ids: string[]): Promise<InitialFileResult[]> {
        const allowed = new Set([...(this.notes ? ['note:demo'] : []), ...this.flows.map(flow => 'flow:' + flow.id)]);
        if (!Array.isArray(ids) || ids.some(id => !allowed.has(id))) throw new Error('INITIAL_FILE_UNKNOWN');
        const results: InitialFileResult[] = [];
        for (const id of new Set(ids)) {
            try {
                const restored = id === 'note:demo' ? await this.restoreNote() : Boolean(await restoreAndPublishFlow(
                    this.commands, this.flows.find(flow => 'flow:' + flow.id === id)!));
                results.push({ id, status: restored ? 'restored' : 'preserved' });
            } catch (error) { results.push({ id, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
        }
        return results;
    }
    private restoreNote(): Promise<boolean> {
        const notes = this.notes!;
        const write = (noteWrites.get(notes) ?? Promise.resolve(false)).catch(() => false).then(() => this.writeMissingNote());
        noteWrites.set(notes, write);
        return write.finally(() => { if (noteWrites.get(notes) === write) noteWrites.delete(notes); });
    }
    private async writeMissingNote(): Promise<boolean> {
        const driver = this.notes!.driver;
        if (await driver.exists('/' + demo.name)) return false;
        try { await driver.createFile({ parentPath: '/', name: demo.name, content: demo.content }); return true; }
        catch (error) {
            if ((error as { code?: string }).code === 'EEXIST' && await driver.exists('/' + demo.name)) return false;
            throw error;
        }
    }
}
