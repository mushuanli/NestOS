import previousDefaults from './fixtures/kanban-default-prompts-v1.json';
import defaults from '../src/presets/kanban-development-prompts.json';
import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {developmentPolicy} from '../src/presets/kanban-development-policy';
import {publishPromptBundle, hasMarkdownSection} from '../src/run/prompt-bundle';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs); await journal.open();
    return {fs, journal};
}
it('resolves project overrides, freezes original contents and verifies remote publication on recovery', async () => {
    const {fs, journal} = await fixture();
    await fs.driver.createFile({parentPath: '/workspace/_nestos/kanban/policies/development', name: 'task.md', content: '# Project task', recursive: true});
    const first = await developmentPolicy(journal, fs, fs, 'attempt', {commit: 'changes', modules: 'libraries/editor'});
    expect(first.prompts.files.find(file => file.name === 'task.md')).toMatchObject({content: '# Project task', source: expect.stringContaining('project:')});
    expect(first.prompts.files.find(file => file.name === 'decision.md')?.source).toContain('nestos:');
    const directory = '/workspace/work/_nestos/kanban';
    const digest = await publishPromptBundle(fs, directory, first.prompts, {commit: first.commit});
    await fs.driver.writeContent('/workspace/_nestos/kanban/policies/development/task.md', 'New task');
    const restored = await developmentPolicy(journal, fs, fs, 'attempt', {commit: 'worktree'});
    expect(restored).toEqual(first);
    expect(await publishPromptBundle(fs, directory, restored.prompts, {commit: restored.commit})).toBe(digest);
    await fs.driver.writeContent(directory + '/prompts/task.md', 'Tampered');
    await expect(publishPromptBundle(fs, directory, restored.prompts, {commit: restored.commit})).rejects.toMatchObject({code: 'PROMPT_SNAPSHOT_CHANGED'});
});
it('defaults to uncommitted changes and rejects invalid paths and options', async () => {
    const {fs, journal} = await fixture();
    expect((await developmentPolicy(journal, fs, fs, 'default')).commit).toBe('changes');
    await expect(developmentPolicy(journal, fs, fs, 'bad-profile', {profile: '../escape'})).rejects.toMatchObject({code: 'DEVELOPMENT_POLICY_INVALID'});
    await expect(developmentPolicy(journal, fs, fs, 'bad-module', {modules: '../other'})).rejects.toMatchObject({code: 'MODULE_PATH_INVALID'});
    await expect(developmentPolicy(journal, fs, fs, 'bad-mode', {commit: 'push'})).rejects.toMatchObject({code: 'DEVELOPMENT_POLICY_INVALID'});
});
it('publishes the manifest only after all files and rejects oversized authoring content', async () => {
    const {fs, journal} = await fixture();
    await fs.driver.createFile({parentPath: '/workspace/_nestos/kanban/policies/development', name: 'task.md', content: 'x'.repeat(65537), recursive: true});
    await expect(developmentPolicy(journal, fs, fs, 'large')).rejects.toMatchObject({code: 'PROMPT_FILE_INVALID'});
    expect(await fs.driver.exists('/workspace/work/_nestos/kanban/manifest.json')).toBe(false);
});

it('ignores lifecycle headings inside fenced Markdown examples', () => {
    expect(hasMarkdownSection('```md\n## postload.cancelled\n```', 'postload.cancelled')).toBe(false);
    expect(hasMarkdownSection('```md\n## fake\n```\n## postload.cancelled\nSummary', 'postload.cancelled')).toBe(true);
});

it('upgrades only unchanged shipped defaults for new attempts and preserves user prompt edits',async()=>{
    const {fs,journal}=await fixture();
    for(const name of ['decision.md','task.md'] as const)await fs.driver.createFile({parentPath:'/var/lib/kanban/policies/development',name,content:previousDefaults[name],recursive:true});
    const policy=await developmentPolicy(journal,fs,fs,'upgraded');
    expect(policy.prompts.files.find(file=>file.name==='decision.md')?.content).toBe(defaults['decision.md']);
    expect(policy.prompts.files.find(file=>file.name==='task.md')?.content).toBe(defaults['task.md']);
    await fs.driver.writeContent('/var/lib/kanban/policies/development/decision.md','User planning policy');
    expect((await developmentPolicy(journal,fs,fs,'custom')).prompts.files.find(file=>file.name==='decision.md')?.content).toBe('User planning policy');
    expect(await developmentPolicy(journal,fs,fs,'upgraded')).toEqual(policy);
});
it('freezes project pre/post overrides and global status hooks and publishes them with the manifest',async()=>{
    const {fs,journal}=await fixture();
    const global='/var/lib/kanban/policies/development',local='/workspace/_nestos/kanban/policies/development';
    for(const [parentPath,name,content] of [[global,'task-pre.md','Global pre'],[local,'task-pre.md','Project pre'],[local,'task-post.md','Project post'],[global,'task-succ.md','Global success']])
        await fs.driver.createFile({parentPath,name,content,recursive:true});
    const policy=await developmentPolicy(journal,fs,fs,'hooks');
    expect(policy.prompts.files.find(file=>file.name==='task-pre.md')?.content).toBe('Project pre');
    expect(policy.prompts.files.find(file=>file.name==='task-succ.md')?.content).toBe('Global success');
    await publishPromptBundle(fs,'/workspace/frozen',policy.prompts,{});
    expect(await fs.driver.exists('/workspace/frozen/prompts/task-post.md')).toBe(true);
    await fs.driver.writeContent(local+'/task-pre.md','Later edit');
    expect(await developmentPolicy(journal,fs,fs,'hooks')).toEqual(policy);
});
