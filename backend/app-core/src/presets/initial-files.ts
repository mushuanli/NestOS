import {t, createModuleLogger, randomUUID} from '@itookit/common';
const log = createModuleLogger('initial-files');
import {studyFiles, writeMissingStudyFile} from './study-files';
import type { IFileSystem } from '@itookit/vfs-core';
import type {FlowInstallations, FlowInstallationReport} from '@itookit/app-contracts/services';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import demo from './digital-twin-demo.json';
import readme from './notes-readme.json';
import flowGuide from './flow-format-guide.json';
import { createNestosFlowLibrary } from './flow-library';
import { restoreAndPublishFlow } from './restore-flows';

const noteWrites = new WeakMap<IFileSystem, Promise<boolean>>();
const noteTemplates = [{id: 'note:readme', ...readme}, {id: 'note:demo', ...demo}, {id: 'note:flow-format', ...flowGuide}, ...studyFiles];

export interface InitialFileEntry { id: string; group: 'notes' | 'flows' | 'kanban'; name: string; path: string; exists: boolean; overwrite?: boolean; }
export interface InitialFileResult { id: string; status: 'restored' | 'preserved' | 'failed'; error?: string; dependencies?: FlowInstallationReport; }

export interface InitialResourceProvider {
    list(): Promise<InitialFileEntry[]>;
    restore(id: string): Promise<boolean>;
}

/** Explicit recovery writes through the active workspace and existing Flow commands. */
export class NestosInitialFiles {
    private readonly flows = createNestosFlowLibrary();
    constructor(private readonly commands: ICommandBus, private readonly notes?: IFileSystem, private readonly installations?: FlowInstallations, private readonly resources?: InitialResourceProvider) {}
    async list(): Promise<InitialFileEntry[]> {
        const entries: InitialFileEntry[] = [];
        if (this.notes) for (const note of noteTemplates) entries.push({ id: note.id, group: 'notes', name: note.id === 'note:study-prompts' ? t('initialFiles.studyPrompts') : note.name,
            overwrite: note.id === 'note:study-prompts', path: `/home/admin/notes/${note.name}`, exists: await this.notes.driver.exists('/' + note.name) });
        for (const flow of this.flows) entries.push({ id: 'flow:' + flow.id, group: 'flows', name: `${flow.id}.flow`,
            path: `/home/admin/flows/${flow.id}.flow`, exists: Boolean(await this.commands.execute(FlowCommand.DraftLoad, { id: flow.id })) });
        if (this.resources) entries.push(...await this.resources.list());
        return entries;
    }
    async restore(ids: string[]): Promise<InitialFileResult[]> {
        const allowed = new Set([...(this.notes ? noteTemplates.map(note => note.id) : []), ...this.flows.map(flow => 'flow:' + flow.id), ...((await this.resources?.list()) ?? []).map(entry => entry.id)]);
        if (!Array.isArray(ids) || ids.some(id => !allowed.has(id))) throw new Error('INITIAL_FILE_UNKNOWN');
        const results: InitialFileResult[] = [];
        for (const id of new Set(ids)) {
            const operationId = randomUUID(), started = Date.now();
            try {
                const note = noteTemplates.find(note => note.id === id);
                const flow = this.flows.find(flow => 'flow:' + flow.id === id);
                const restored = note ? await this.restoreNote(note) : flow ? Boolean(await restoreAndPublishFlow(this.commands, flow, true)) : await this.resources!.restore(id);
                const dependencies = id.startsWith('flow:') ? await this.installations?.ensure(id.slice(5)) : undefined;
                results.push({ id, status: restored ? 'restored' : 'preserved', ...(dependencies ? {dependencies} : {}) });
                log.info('initial-files.restore', {operationId, id, stage: 'persist', result: restored ? 'restored' : 'preserved', durationMs: Date.now() - started});
            } catch (error) {
                const raw = (error as {code?: string})?.code, code = raw && /^[A-Z_0-9]+$/.test(raw) ? raw : 'INITIAL_FILE_RESTORE_FAILED';
                log.warn('initial-files.restore', {operationId, id, stage: 'persist', result: 'failure', code, durationMs: Date.now() - started});
                results.push({ id, status: 'failed', error: error instanceof Error ? error.message : String(error) });
            }
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
        if (note.name === '.nestos/cloze/prompts.yaml') {
            const path = '/' + note.name;
            if (await this.notes!.driver.exists(path)) await this.notes!.driver.writeContent(path, note.content);
            else await this.notes!.driver.createFile({parentPath: '/.nestos/cloze', name: 'prompts.yaml', content: note.content, recursive: true});
            return true;
        }
        return writeMissingStudyFile(this.notes!, note);
    }
}
