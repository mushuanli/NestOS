import yaml from 'js-yaml';
import type {StudyPromptOptions} from '@itookit/mdxeditor';
import type {IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
const path = '/.nestos/cloze/prompt.md';
const listPath = '/.nestos/cloze/prompts.yaml';
const log = createModuleLogger('study-prompt');
/** Notes profile policy. Independent mdxeditor only sees load/save capabilities. */
export function createStudyPromptStore(fs: IFileSystem): NonNullable<StudyPromptOptions['store']> {
    return {list: async signal => {
        if (!await fs.driver.exists(listPath)) return undefined;
        const raw = await fs.driver.readContent(listPath, {encoding: 'utf-8', signal});
        let value: unknown;
        try {value = yaml.load(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));}
        catch {throw Object.assign(new Error('Invalid prompt YAML'), {code: 'INVALID_PROMPT_LIST'});}
        if (!Array.isArray(value) || value.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.content !== 'string')
            || new Set(value.map(item => item.id)).size !== value.length) throw Object.assign(new Error('Invalid prompt list'), {code: 'INVALID_PROMPT_LIST'});
        return value;
    }, saveList: async prompts => writePrompt(fs, listPath, yaml.dump(prompts, {lineWidth: -1, noRefs: true})), load: async signal => {
        if (!await fs.driver.exists(path)) return undefined;
        const raw = await fs.driver.readContent(path, {encoding: 'utf-8', signal});
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    }, save: async prompt => writePrompt(fs, path, prompt)};
}
async function writePrompt(fs: IFileSystem, path: string, prompt: string): Promise<void> {
        const operationId = randomUUID(), started = Date.now(); let stage = 'check';
        try {
            if (await fs.driver.exists(path)) {stage = 'write'; await fs.driver.writeContent(path, prompt);}
            else {
                stage = 'create';
                try {await fs.driver.createFile({parentPath: '/.nestos/cloze', name: path.slice(path.lastIndexOf('/') + 1), content: prompt, recursive: true});}
                catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error; stage = 'write'; await fs.driver.writeContent(path, prompt);}
            }
            log.info('study.prompt.save', {operationId, stage: 'complete', result: 'success', size: prompt.length, durationMs: Date.now() - started});
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? raw : 'STUDY_PROMPT_SAVE_FAILED';
            log.error('study.prompt.save', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw error;
        }
}
