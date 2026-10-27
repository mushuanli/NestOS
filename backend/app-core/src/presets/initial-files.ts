import type { IFileSystem } from '@itookit/vfs-core';
import type {FlowInstallations, FlowInstallationReport} from '@itookit/app-contracts/services';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import demo from './digital-twin-demo.json';
import readme from './notes-readme.json';
import { createNestosFlowLibrary } from './flow-library';
import { restoreAndPublishFlow } from './restore-flows';

const noteWrites = new WeakMap<IFileSystem, Promise<boolean>>();
const noteTemplates = [{id: 'note:readme', ...readme}, {id: 'note:demo', ...demo}];

export interface InitialFileEntry { id: string; group: 'notes' | 'flows'; name: string; path: string; exists: boolean; }
export interface InitialFileResult { id: string; status: 'restored' | 'preserved' | 'failed'; error?: string; dependencies?: FlowInstallationReport; }

/** Explicit recovery writes through the active workspace and existing Flow commands. */
export class NestosInitialFiles {
    private readonly flows = createNestosFlowLibrary();
    constructor(private readonly commands: ICommandBus, private readonly notes?: IFileSystem, private readonly installations?: FlowInstallations) {}
    async list(): Promise<InitialFileEntry[]> {
        const entries: InitialFileEntry[] = [];
        if (this.notes) for (const note of noteTemplates) entries.push({ id: note.id, group: 'notes', name: note.name,
            path: `/home/admin/minds/${note.name}`, exists: await this.notes.driver.exists('/' + note.name) });
        for (const flow of this.flows) entries.push({ id: 'flow:' + flow.id, group: 'flows', name: `${flow.id}.flow`,
            path: `/home/admin/flows/${flow.id}.flow`, exists: Boolean(await this.commands.execute(FlowCommand.DraftLoad, { id: flow.id })) });
        return entries;
    }
    async restore(ids: string[]): Promise<InitialFileResult[]> {
        const allowed = new Set([...(this.notes ? noteTemplates.map(note => note.id) : []), ...this.flows.map(flow => 'flow:' + flow.id)]);
        if (!Array.isArray(ids) || ids.some(id => !allowed.has(id))) throw new Error('INITIAL_FILE_UNKNOWN');
        const results: InitialFileResult[] = [];
        for (const id of new Set(ids)) {
            try {
                const note = noteTemplates.find(note => note.id === id);
                const restored = note ? await this.restoreNote(note) : Boolean(await restoreAndPublishFlow(
                    this.commands, this.flows.find(flow => 'flow:' + flow.id === id)!));
                const dependencies = id.startsWith('flow:') ? await this.installations?.ensure(id.slice(5)) : undefined;
                results.push({ id, status: restored ? 'restored' : 'preserved', ...(dependencies ? {dependencies} : {}) });
            } catch (error) { results.push({ id, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
        }
        return results;
    }
    async prepareDependencies(ids: string[]): Promise<FlowInstallationReport[]> {
        const known = new Set(this.flows.map(flow => 'flow:' + flow.id));
        if (!Array.isArray(ids) || ids.some(id => !known.has(id))) throw new Error('INITIAL_FILE_UNKNOWN');
        if (!this.installations) return [];
        return Promise.all([...new Set(ids)].map(id => this.installations!.ensure(id.slice(5))));
    }
    private restoreNote(note: {name: string; content: string}): Promise<boolean> {
        const notes = this.notes!;
        const write = (noteWrites.get(notes) ?? Promise.resolve(false)).catch(() => false).then(() => this.writeMissingNote(note));
        noteWrites.set(notes, write);
        return write.finally(() => { if (noteWrites.get(notes) === write) noteWrites.delete(notes); });
    }
    private async writeMissingNote(note: {name: string; content: string}): Promise<boolean> {
        const driver = this.notes!.driver;
        if (await driver.exists('/' + note.name)) return false;
        try { await driver.createFile({ parentPath: '/', name: note.name, content: note.content }); return true; }
        catch (error) {
            if ((error as { code?: string }).code === 'EEXIST' && await driver.exists('/' + note.name)) return false;
            throw error;
        }
    }
}
