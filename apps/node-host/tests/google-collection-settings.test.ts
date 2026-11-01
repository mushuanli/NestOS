import {expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {z} from 'zod/v4';
import {loadNodeToolModules} from '../src/runtime/tool-modules';
import {readToolPackage} from '../src/runtime/tool-packages/manifest';
import {readToolbox, toolboxParameters, toolboxOptionLabels} from '../src/runtime/tool-packages/toolbox';

it('projects the actual Google collector branches and account settings without a Flow or credential fields', async () => {
    const root = fileURLToPath(new URL('../../../tools/googlecli/', import.meta.url));
    const source = await readToolPackage(root), declaration = await readToolbox(source);
    const tools = await loadNodeToolModules(JSON.stringify([fileURLToPath(new URL('../../../tools/googlecli/node/extension.mjs', import.meta.url))]));
    const collector = tools.find(tool => tool.name === 'google.collect')!;
    const schema = z.toJSONSchema(collector.inputSchema) as {anyOf?: Array<{properties: Record<string, unknown>}>; oneOf?: Array<{properties: Record<string, unknown>}>};
    const branches = schema.oneOf ?? schema.anyOf!;
    expect(branches).toHaveLength(2);
    expect(toolboxOptionLabels(declaration!.tools['google.collect'].parameters, []).resource).toEqual({mail: '邮件', calendar: '日历'});
    expect(branches[0].properties.query).toBeDefined(); expect(branches[0].properties.calendarId).toBeUndefined();
    expect(branches[1].properties.calendarId).toBeDefined(); expect(branches[1].properties.query).toBeUndefined();
    expect(source.manifest.flows).toBeUndefined();
    const fields = toolboxParameters(collector, declaration!.tools['google.collect'].parameters, [
        {id: 'saved-account', type: 'google-workspace', name: 'Saved account', values: {}, configuredSecrets: ['refreshToken']}]);
    expect(fields.find(field => field.name === 'connection')).toMatchObject({options: ['saved-account'], default: 'saved-account'});
    expect(fields.find(field => field.name === 'resource')?.options).toEqual(['mail', 'calendar']);
    expect(fields.some(field => ['clientId', 'clientSecret', 'refreshToken'].includes(field.name))).toBe(false);
    expect(declaration!.tools['google.gmail.collect'].hidden).toBe(true);
    expect(tools.find(tool => tool.name === 'google.gmail.collect')?.version).toBe('1');
});
