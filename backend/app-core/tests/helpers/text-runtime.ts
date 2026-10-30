import {vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '../../src/runtime/create-application-runtime';
import {openApplicationView} from '../../src/host';
export async function textRuntime() {
    const storage = new MemoryBackend(); await storage.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await storage.mkdir(path);
    const write = (path: string, value: unknown) => storage.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id:'mock',name:'Mock',implementation:'openai-compatible',apiKey:'fixture',baseURL:'https://fixture.invalid',models:[{id:'model',name:'Model'},{id:'alternate',name:'Alternate'}]});
    await write('/etc/llm/.connections/default.json', {id:'default',name:'Default',providerId:'mock',protocol:'openai-chat',tiers:{optimal:'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId:'default'});
    const fetch = vi.fn(async (_url: unknown, _options: any) => response('--generated--'));
    vi.stubGlobal('fetch', fetch);
    const runtime = await createApplicationRuntime({backend:storage,ownerKind:'tauri',digitalTwinAutoStart:false});
    const view = await openApplicationView(runtime);
    const sessionId = await view.backend.createSessionDraft({title:'Anki creation',inputText:''});
    const input = {sessionId,operationId:'first',prompt:'Instructions',source:'Material',previousDraft:''};
    return {runtime,view,input,fetch,close:async()=>{await view.close();await runtime.dispose();vi.unstubAllGlobals();}};
}
export function response(content: string, finish = 'stop') {
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({id:'response',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    return new Response(chunk({role:'assistant',content},null)+chunk({},finish)+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
