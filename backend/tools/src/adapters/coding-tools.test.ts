import { expect, it, vi } from 'vitest';
import { BUILTIN_TOOLS } from '../index';
import { ToolDeviceDriver } from './tool-device-driver';

it('streams the cwd and matches while a subsequent read is still pending', async () => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  let release!: (text: string) => void;
  const slow = new Promise<string>(resolve => { release = resolve; });
  const progress: Array<{ message: string; output?: string }> = [];
  driver.setFileContext({ listFiles: async () => ['/work/first', '/work/slow'],
    readFile: async path => path.endsWith('first') ? 'mdx' : slow, writeFile: vi.fn() }, '/work');
  const pending = driver.invoke({ toolId: 'Grep', args: { pattern: 'mdx' }, onProgress: async event => { progress.push(event); } });
  try {
    await vi.waitFor(() => expect(progress.some(event => event.output?.includes('/work/first:1: mdx'))).toBe(true));
    expect(progress.some(event => event.message.includes('cwd: /work | path: /work'))).toBe(true);
  } finally { release('no match'); }
  expect(await pending).toMatchObject({ success: true, data: { numMatches: 1 } });
});

it('reports skipped oversized files instead of claiming a complete negative search', async () => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  const readFile = vi.fn(async () => { throw Object.assign(new Error('too large'), { code: 'SEARCH_FILE_TOO_LARGE' }); });
  driver.setFileContext({ listFiles: async () => ['/large'], readFile, writeFile: vi.fn() }, '/');
  const result = await driver.invoke({ toolId: 'Grep', args: { pattern: 'mdx', includeIgnored: true } });
  expect(readFile).toHaveBeenCalledWith('/large', { maxBytes: 2 * 1024 * 1024 });
  expect(result).toMatchObject({ success: true, data: { skippedFiles: 1, numMatches: 0, truncated: true } });
  expect(result.output).toContain('search is incomplete');
});

it('yields during a large file scan so a UI cancellation can interrupt it', async () => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Cancelled from UI')), 0);
  driver.setFileContext({ listFiles: async () => ['/large.txt'],
    readFile: async () => 'no match\n'.repeat(100_000), writeFile: vi.fn() }, '/');
  try {
    const result = await driver.invoke({ toolId: 'Grep', args: { pattern: 'mdx' }, signal: controller.signal });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Cancelled from UI');
  } finally { clearTimeout(timer); }
});

it('preserves line numbers and the final empty line across scan batches', async () => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  driver.setFileContext({ listFiles: async () => ['/large.txt'],
    readFile: async () => 'none\n'.repeat(2048) + 'mdx\n', writeFile: vi.fn() }, '/');
  expect(await driver.invoke({ toolId: 'Grep', args: { pattern: 'mdx|^$' } })).toMatchObject({
    success: true, data: { matches: [
      { file: '/large.txt', line: 2049, content: 'mdx' }, { file: '/large.txt', line: 2050, content: '' },
    ] },
  });
});

it.each(['Grep', 'Glob'])('stops lazy VFS discovery at the %s result limit', async toolId => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  const listFiles = vi.fn(async () => { throw new Error('Must not collect the entire tree'); });
  let closed = false;
  const walkFiles = async function* () {
    try {
      if (toolId === 'Grep') yield '/early.txt';
      else for (let i = 0; i < 100; i++) yield `/file${i}.txt`;
      throw new Error('Must not traverse the remaining slow directories');
    } finally { closed = true; }
  };
  driver.setFileContext({ listFiles, walkFiles, readFile: async () => Array(60).fill('mdx').join('\n'), writeFile: vi.fn() }, '/');
  expect(await driver.invoke({ toolId, args: { pattern: toolId === 'Grep' ? 'mdx' : '**/*' } }))
    .toMatchObject({ success: true, data: { truncated: true } });
  expect(closed).toBe(true);
  expect(listFiles).not.toHaveBeenCalled();
});

it('stops reading VFS files at the match limit and passes discovery options', async () => {
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  const listFiles = vi.fn(async () => ['/matches.txt', '/unused.txt']);
  const readFile = vi.fn(async (path: string) => {
    if (path === '/unused.txt') throw new Error('Must stop once the result limit is reached');
    return Array(60).fill('mdx').join('\n');
  });
  driver.setFileContext({ listFiles, readFile, writeFile: vi.fn() }, '/');
  expect(await driver.invoke({ toolId: 'Grep', args: { pattern: 'mdx' } }))
    .toMatchObject({ success: true, data: { numMatches: 50, truncated: true } });
  expect(readFile).toHaveBeenCalledOnce();
  expect(listFiles).toHaveBeenCalledWith('/', expect.objectContaining({ includeIgnored: undefined }));
});

function files(initial = 'before target after') {
  let content = initial;
  const writeFile = vi.fn(async (_path: string, value: string) => { content = value; });
  const readFile = vi.fn(async () => content);
  const driver = new ToolDeviceDriver([...BUILTIN_TOOLS]);
  driver.setFileContext({ readFile, writeFile, listFiles: async () => ['/code.ts'] }, '/');
  const edit = (old_string: string, new_string: string, replace_all = false) => driver.invoke({
    toolId: 'Edit', args: { file_path: '/code.ts', old_string, new_string, replace_all },
  });
  return { driver, readFile, writeFile, edit, content: () => content };
}

it.each([false, true])('writes replacement metacharacters literally (replace_all=%s)', async replaceAll => {
  const fixture = files(replaceAll ? 'target target' : 'target');
  const replacement = '$& $$ $` $\'';
  const result = await fixture.edit('target', replacement, replaceAll);
  expect(result).toMatchObject({ success: true, data: { replacements: replaceAll ? 2 : 1, oldString: 'target', newString: replacement } });
  expect(fixture.content()).toBe(replaceAll ? `${replacement} ${replacement}` : replacement);
});

it.each([
  ['', 'new', 'INVALID_ARGUMENTS'], ['target', 'target', 'INVALID_ARGUMENTS'],
  ['missing', 'new', 'EDIT_NOT_FOUND'],
])('returns a corrective error without writing (%j)', async (old, next, code) => {
  const fixture = files();
  expect(await fixture.edit(old, next)).toMatchObject({ success: false, recoverable: true, errorCode: code });
  expect(fixture.writeFile).not.toHaveBeenCalled();
});

it('rejects ambiguous edits and accepts a subsequent precise correction', async () => {
  const fixture = files('first target; second target');
  expect(await fixture.edit('target', 'new')).toMatchObject({ errorCode: 'EDIT_AMBIGUOUS', recoverable: true });
  expect(fixture.writeFile).not.toHaveBeenCalled();
  expect((await fixture.edit('first target', 'first new')).success).toBe(true);
  expect(fixture.content()).toBe('first new; second target');
});

it.each([{ offset: 0 }, { offset: 1.5 }, { limit: -1 }, { limit: 2001 }])('validates Read ranges (%j)', async range => {
  const fixture = files();
  expect(await fixture.driver.invoke({ toolId: 'Read', args: { file_path: '/code.ts', ...range } })).toMatchObject({ errorCode: 'INVALID_ARGUMENTS' });
  expect(fixture.readFile).not.toHaveBeenCalled();
});

it('does not treat a storage read failure as permission to create a file', async () => {
  const fixture = files();
  fixture.readFile.mockRejectedValue(new Error('backend offline'));
  const result = await fixture.driver.invoke({ toolId: 'Write', args: { file_path: '/code.ts', content: 'new' } });
  expect(result.success).toBe(false);
  expect(result.recoverable).not.toBe(true);
  expect(fixture.writeFile).not.toHaveBeenCalled();
});

it('allows creation only after an explicit missing-file result', async () => {
  const fixture = files();
  fixture.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  expect(await fixture.driver.invoke({ toolId: 'Read', args: { file_path: '/code.ts' } })).toMatchObject({ errorCode: 'ENOENT', recoverable: true });
  expect(await fixture.driver.invoke({ toolId: 'Write', args: { file_path: '/code.ts', content: 'new' } }))
    .toMatchObject({ success: true, data: { fileType: 'create' } });
  expect(fixture.content()).toBe('new');
});

it('does not write when cancellation arrives during an Edit read', async () => {
  const fixture = files();
  let finish!: (value: string) => void;
  fixture.readFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = fixture.driver.invoke({ toolId: 'Edit', signal: controller.signal,
    args: { file_path: '/code.ts', old_string: 'target', new_string: 'new' } });
  await vi.waitFor(() => expect(fixture.readFile).toHaveBeenCalledOnce());
  controller.abort();
  finish('target');
  expect(await pending).toMatchObject({ success: false, errorCode: 'CANCELLED', recoverable: false });
  expect(fixture.writeFile).not.toHaveBeenCalled();
});

it('runs Bash validation before starting a process and retains its exit code', async () => {
  const fixture = files();
  const exec = vi.fn(async () => ({ stdout: 'failed test', stderr: '', code: 1 }));
  fixture.driver.setNativeShell({ capabilities: { fd: false, ripgrep: false }, exec });
  expect(await fixture.driver.invoke({ toolId: 'Bash', args: { command: 'rm -rf /' } })).toMatchObject({ errorCode: 'INVALID_ARGUMENTS' });
  expect(exec).not.toHaveBeenCalled();
  expect(await fixture.driver.invoke({ toolId: 'Bash', args: { command: 'pnpm test', timeout_ms: 5000 }, timeoutMs: 1000 }))
    .toMatchObject({ success: true, data: { exitCode: 1 } });
  expect(exec).toHaveBeenCalledWith('sh', ['-c', 'pnpm test'], expect.objectContaining({ timeoutMs: 1000 }));
});
