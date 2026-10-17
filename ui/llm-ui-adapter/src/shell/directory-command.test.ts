import { expect, it } from 'vitest';
import { parseDirectoryCommand } from './directory-command';
it('parses directory access without shell expansion', () => {
    expect(parseDirectoryCommand('"~/my project"')).toEqual({ directory: '~/my project', access: 'rw' });
    expect(parseDirectoryCommand("'/data/read only' r")).toEqual({ directory: '/data/read only', access: 'ro' });
    expect(parseDirectoryCommand('/data w').access).toBe('rw');
    expect(parseDirectoryCommand('')).toEqual({ directory: undefined, access: 'rw' });
    expect(parseDirectoryCommand('"$(echo secret)"').directory).toBe('$(echo secret)');
    expect(() => parseDirectoryCommand('/data x')).toThrow('用法');
    expect(() => parseDirectoryCommand('/data w', false)).toThrow('/set-home');
    expect(() => parseDirectoryCommand('"unclosed')).toThrow('引号');
    expect(() => parseDirectoryCommand('""')).toThrow('不能为空');
});
