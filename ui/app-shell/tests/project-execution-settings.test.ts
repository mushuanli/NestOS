// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {parseEnvironment, projectExecutionSettings} from '../src/projects/project-execution-settings';
it('preserves literal values and rejects duplicate or malformed names', () => {
    expect(parseEnvironment('GIT_AUTHOR_NAME=Rain Li\nTOKEN=a=b\nEMPTY=\n\n')).toEqual({GIT_AUTHOR_NAME:'Rain Li', TOKEN:'a=b', EMPTY:''});
    for (const text of ['KEY=a\nKEY=b', 'MISSING', '1KEY=value']) expect(() => parseEnvironment(text)).toThrow();
});

it('renders profile labels safely and submits the originally read revision', async () => {
    const project = {id: 'p', revision: 7};
    const setExecution = vi.fn(async () => {});
    const remote = {executionSettings: async () => ({project, execution: {profile: 'dev', variables: {NAME: '<script>literal</script>'}},
        profiles: [{id: 'dev', name: '<img src=x>', user: 'li'}]}), setExecution};
    const form = await projectExecutionSettings(remote as never, 'p', new AbortController().signal);
    expect(form.panel.querySelector('img')).toBeNull();
    expect(form.panel.querySelector('textarea')!.value).toContain('<script>literal</script>');
    form.panel.querySelector('textarea')!.value = 'NAME=Changed';
    await form.save();
    expect(setExecution).toHaveBeenCalledWith('p', project, {profile: 'dev', variables: {NAME:'Changed'}}, expect.any(Object));
});
