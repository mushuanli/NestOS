import yaml from 'js-yaml';
import type {IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import prompts from './study-prompts.json';
import notes from './study-notes.json';
const log = createModuleLogger('study-files');
const receipt = '/.nestos/cloze/examples-v1.installed';
export const studyFiles = [...notes, {id: 'note:study-prompts', name: '.nestos/cloze/prompts.yaml', content: yaml.dump(prompts, {lineWidth: -1, noRefs: true})}];

/** Create-only recovery preserves user edits, including configured prompt collections. */
export async function writeMissingStudyFile(fs: IFileSystem, file: {name: string; content: string}): Promise<boolean> {
    const path = '/' + file.name;
    if (await fs.driver.exists(path)) return false;
    const split = path.lastIndexOf('/');
    let content = file.content;
    if (file.name === '.nestos/cloze/prompts.yaml' && await fs.driver.exists('/.nestos/cloze/prompt.md')) {
        const legacy = await fs.driver.readContent('/.nestos/cloze/prompt.md', {encoding: 'utf-8'});
        content = yaml.dump([{id: 'legacy', name: 'Saved prompt', content: String(legacy)}, ...prompts], {lineWidth: -1, noRefs: true});
    }
    try {await fs.driver.createFile({parentPath: path.slice(0, split) || '/', name: path.slice(split + 1), content, recursive: true}); return true;}
    catch (error) {if ((error as {code?: string}).code === 'EEXIST' && await fs.driver.exists(path)) return false; throw error;}
}

/** A receipt prevents ordinary restarts from recreating examples that users deleted. */
export async function seedStudyFiles(fs: IFileSystem): Promise<void> {
    const operationId = randomUUID(), started = Date.now(); let index = 0, created = 0;
    try {
        const installed = await fs.driver.exists(receipt);
        const pending = installed ? [studyFiles[studyFiles.length - 1]] : studyFiles;
        for (const file of pending) {if (await writeMissingStudyFile(fs, file)) created++; index++;}
        await writeMissingStudyFile(fs, {name: receipt.slice(1), content: '1'});
        log.info('study.examples.seed', {operationId, stage: 'complete', result: 'success', created, durationMs: Date.now() - started});
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.error('study.examples.seed', {operationId, stage: 'create', result: 'failure', index,
            code: typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : 'STUDY_EXAMPLES_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
