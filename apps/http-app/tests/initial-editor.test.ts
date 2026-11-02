import {expect, it} from 'vitest';
import {initialView} from '../src/client/initial-view';

it.each(['/', '/folder:x1', '/folder:x1/@conversations', '/folder:x1/@favorites', '/folder:x1/@files/a.md', '/s1/tasks'])(
    'does not preload the chat editor for directory or task route %s', resource => {
        const view = initialView('#/workbench/' + encodeURIComponent(resource));
        expect(view.editor).toBeUndefined(); expect(view.request).toBeDefined();
    });
it.each(['s1?branch=main', 'draft:66fc56b1-76c5-4067-9876-52259d99795c', '/folder:x1/@new'])(
    'preloads chat for conversation route %s', resource => {
        expect(initialView('#/workbench/' + encodeURIComponent(resource)).editor).toBe('chat');
    });
it('retains flow preloading and skips chat on the workspace landing page', () => {
    expect(initialView('#/flows').editor).toBe('flows');
    expect(initialView('#/workbench').editor).toBeUndefined();
});
