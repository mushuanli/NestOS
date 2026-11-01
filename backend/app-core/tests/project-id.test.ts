import {expect, it} from 'vitest';
import {allocateProjectId, validateProjectId} from '../src/projects/project-id';
it('allocates readable IDs with case-insensitive suffixes and rejects invalid explicit IDs', () => {
    expect(allocateProjectId('Notes', ['NOTES', 'notes-2'])).toBe('notes-3');
    expect(allocateProjectId('中文', [])).toBe('project');
    expect(allocateProjectId('Name', [], 'notes_2026')).toBe('notes_2026');
    for (const id of ['', '../notes', '-notes', 'a'.repeat(65), 'a2fdd384-d811-4be5-9922-30b9176c2798']) expect(() => validateProjectId(id)).toThrow();
    expect(() => allocateProjectId('Name', ['notes'], 'NOTES')).toThrow('already exists');
});
