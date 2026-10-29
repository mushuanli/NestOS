import { expect, it } from 'vitest';
import { WS_AGENTS, WS_EMAILS, WS_NOTES, WS_PRIVATE, WS_PROJECTS, WS_WORKBENCH } from '../src/workspaces';

it('enables spaced-repetition clozes for the notes workspace only', () => {
    expect(WS_NOTES.plugins).toEqual(['cloze:cloze']);
    for (const workspace of [WS_WORKBENCH, WS_AGENTS, WS_PROJECTS, WS_EMAILS, WS_PRIVATE]) {
        expect(workspace.plugins ?? []).not.toContain('cloze:cloze');
    }
});

it('keeps notes on the shared standard editor with Markdown files', () => {
    expect(WS_NOTES.type).toBe('standard');
    expect(WS_NOTES.supportedFileTypes).toEqual(['mind']);
});
