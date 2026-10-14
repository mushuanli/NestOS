import { expect, it } from 'vitest';
import { favoriteKey, moveFavorites, reconcileSessions, withoutDeletedFiles } from '../src/projects/favorites/policy';
import type { ProjectFavorite } from '../src/projects/favorites';

const file = (id: string, path: string, title: string, nodeType: 'file' | 'directory' = 'file'): ProjectFavorite =>
    ({ id, title, target: { kind: 'file', path, nodeType } });
const session = (id: string, sessionId: string, title: string): ProjectFavorite =>
    ({ id, title, target: { kind: 'session', sessionId } });

it('drops only the deleted subtree and keeps session shortcuts', () => {
    const items = [file('a', '/workspace/docs', 'docs', 'directory'), file('b', '/workspace/docs/note.md', 'note'),
        file('c', '/workspace/docs2', 'docs2', 'directory'), session('d', 's1', 'Chat')];
    expect(withoutDeletedFiles(items, ['/workspace/docs'])).toEqual([items[2], items[3]]);
    expect(withoutDeletedFiles(items, ['/workspace/other'])).toEqual(items);
});

it('rewrites moved subtrees, renames the moved entry and collapses duplicates', () => {
    const items = [file('a', '/workspace/docs', 'docs', 'directory'), file('b', '/workspace/docs/note.md', 'note'),
        file('c', '/workspace/archive/note.md', 'note')];
    const moved = moveFavorites(items, [{ oldPath: '/workspace/docs', newPath: '/workspace/archive/docs' }]);
    expect(moved.map(item => item.target)).toEqual([
        { kind: 'file', path: '/workspace/archive/docs', nodeType: 'directory' },
        { kind: 'file', path: '/workspace/archive/docs/note.md', nodeType: 'file' },
        { kind: 'file', path: '/workspace/archive/note.md', nodeType: 'file' },
    ]);
    // A renamed file gets a fresh display title; a renamed directory keeps its own name.
    const renamed = moveFavorites([file('a', '/workspace/old.md', 'old')], [{ oldPath: '/workspace/old.md', newPath: '/workspace/new.md' }]);
    expect(renamed[0].title).toBe('new');
    const collapsed = moveFavorites([file('a', '/workspace/docs/note.md', 'note'), file('b', '/workspace/docs2/note.md', 'note')],
        [{ oldPath: '/workspace/docs2/note.md', newPath: '/workspace/docs/note.md' }]);
    expect(collapsed.map(item => item.id)).toEqual(['a']);
});

it('reconciles session titles and drops sessions that left the project', () => {
    const items = [session('a', 'kept', 'Old title'), session('b', 'gone', 'Deleted'), file('c', '/workspace/note', 'Note')];
    expect(reconcileSessions(items, new Map([['kept', 'New title']]))).toEqual([
        session('a', 'kept', 'New title'), items[2]]);
});

it('keys file and session targets distinctly', () => {
    expect(favoriteKey({ kind: 'file', path: '/workspace/a', nodeType: 'file' })).toBe('file:/workspace/a');
    expect(favoriteKey({ kind: 'session', sessionId: 's' })).toBe('session:s');
});
