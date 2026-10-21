import sharp from 'sharp';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const workspace = await mkdtemp(path.join(tmpdir(), 'anki-flow-'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.ANKI_CLI_BIN ?? path.join(repo, 'tools/anki-cli/target/debug/anki-cli');
const cli = ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url))];
const png = await sharp({create:{width:128,height:64,channels:3,background:'#ef4477'}}).png().toBuffer();
const audio = Buffer.from('ID3-fixture-audio');
const cards = [{ name:'apple',unit:2,symbol:'/ˈæpəl/',chn:'苹果',example_en:'I eat an apple.',example_cn:'我吃一个苹果。',word_family:'apples',memory_tips:'联想水果',difficulty:'1',collocations:'an apple a day 每天一个苹果',image_prompt:'A student eating a red apple.' }];
const calls = [];
const server = createServer((request, response) => { void serve(request,response).catch(error => { response.writeHead(500);response.end(String(error)); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
    await seed();
    const file = path.join(repo, 'tools/anki-cli/flows/anki-generate.flow');
    const parameters = await save('parameters.json', { words:'Unit 2\napple',generateImages:true,generateAudio:true,voice:'fixture-voice' });
    const bindings = await save('bindings.json', { text:'text',image:'image',speech:'speech' });
    await invoke('run','-f',file,'--params',parameters,'--connection-bindings',bindings);
    assert.deepEqual(calls.sort(), ['chat','image','speech','speech']);
    const files = await walk(path.join(workspace,'anki-output'));
    const manifest = files.find(file => file.endsWith('anki.manifest.yaml'));
    const packageFile = files.find(file => file.endsWith('deck.apkg'));
    assert.ok(manifest); assert.ok(packageFile);
    const yaml = await readFile(manifest,'utf8'); assert.ok(yaml.includes('version: 1')); assert.ok(yaml.includes('audio_example:'));
    const { stdout: inspected } = await promisify(execFile)(binary, ['pkg2md',packageFile,'--output',path.join(workspace,'unpacked')]);
    assert.equal(JSON.parse(inspected).cards,1);
    const imported = JSON.parse(await readFile(path.join(workspace,'unpacked/cards.json'),'utf8'));
    assert.equal(imported[0].name,'apple'); assert.equal(imported[0].chn,'苹果');
    const runs = await readdir(path.join(workspace,'runs'));
    const outputs = JSON.parse(await readFile(path.join(workspace,'runs',runs[0],'result.json'),'utf8'));
    assert.equal(path.join(workspace,outputs.manifest.path),manifest);
    assert.equal(path.join(workspace,outputs.package.path),packageFile);
    const before = calls.length; await invoke('resume',runs[0]); assert.equal(calls.length,before);
    const textOnly = await save('text-only.json',{words:'apple',outputDirectory:'text-output'});
    const textBinding = await save('text-bindings.json',{text:'text'});
    await invoke('run','-f',file,'--params',textOnly,'--connection-bindings',textBinding);
    assert.equal(calls.length,before+1);assert.equal(calls.at(-1),'chat');
    assert.ok((await walk(path.join(workspace,'text-output'))).some(file=>file.endsWith('deck.apkg')));
    const invalid = await save('invalid.json',{words:Array.from({length:21},(_,index)=>`word${index}`).join('\n')});
    await assert.rejects(invoke('run','-f',file,'--params',invalid,'--connection-bindings',textBinding));
    assert.equal(calls.length,before+1);
    const photoParams = await save('photo-parameters.json', { images:[{type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`}}],outputDirectory:'photo-output',generateImages:true,generateAudio:true,voice:'fixture-voice' });
    const photoBindings = await save('photo-bindings.json', {text:'text',vision:'vision',image:'image',speech:'speech'});
    const photoStart = calls.length;
    const existingRuns = new Set(await readdir(path.join(workspace,'runs')));
    await invoke('run','-f',path.join(repo,'tools/anki-cli/flows/anki-from-image.flow'),'--params',photoParams,'--connection-bindings',photoBindings);
    assert.deepEqual(calls.slice(photoStart),['vision']);
    const photoRun = (await readdir(path.join(workspace,'runs'))).find(id=>!existingRuns.has(id));
    assert.ok(photoRun);
    const state = JSON.parse(await readFile(path.join(workspace,'runs',photoRun,'run.json'),'utf8'));
    assert.equal(state.status,'waiting');assert.equal(state.pendingInteractions.length,1);
    assert.equal(state.flow.parameters.images[0].source.asset.kind,'input');
    assert.ok(!JSON.stringify(state.flow.parameters).includes('base64'));
    assert.equal(state.pendingInteractions[0].payload.values.cards[0].chn,'苹果?');
    await invoke('resume',photoRun);
    assert.deepEqual(calls.slice(photoStart),['vision']);
    await invoke('respond',photoRun,state.pendingInteractions[0].interactionId,'--value',JSON.stringify({cards:[{name:'apple',unit:2,symbol:'/a/',chn:'青苹果'}]}));
    await invoke('resume',photoRun);
    assert.deepEqual(calls.slice(photoStart).sort(),['chat','image','speech','speech','vision']);
    const photoPackage = (await walk(path.join(workspace,'photo-output'))).find(file=>file.endsWith('deck.apkg'));
    assert.ok(photoPackage);
    await promisify(execFile)(binary,['pkg2md',photoPackage,'--output',path.join(workspace,'photo-unpacked')]);
    const corrected = JSON.parse(await readFile(path.join(workspace,'photo-unpacked/cards.json'),'utf8'));
    assert.equal(corrected[0].chn,'青苹果');assert.equal(corrected[0].symbol,'/a/');
    const finalCalls = calls.length;await invoke('resume',photoRun);assert.equal(calls.length,finalCalls);
    console.log(JSON.stringify({success:true,workspace,manifest,package:packageFile,calls,restoredWithoutRequests:true,textOnly:true,invalidInputBlockedBeforeModel:true,photoReviewAndResume:true,correctedPhotoPackage:photoPackage},null,2));
} finally { await new Promise(resolve => server.close(resolve)); }

async function serve(request,response) {
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(request.url.endsWith('/chat/completions')) {
        const vision = body.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));
        calls.push(vision?'vision':'chat');
        if(vision) {
            const part=body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).find(part=>part.image_url?.url?.startsWith('data:image/jpeg;base64,'));
            assert.ok(part);
            const actual=Buffer.from(part.image_url.url.split(',')[1],'base64'), meta=await sharp(actual).metadata();
            assert.equal(meta.format,'jpeg');assert.equal(meta.width,128);assert.equal(meta.height,64);
            const pixels=await sharp(actual).raw().toBuffer();assert.equal(pixels[0],pixels[1]);assert.equal(pixels[1],pixels[2]);
        }
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({id:'fixture',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(vision?{cards:[{name:'apple',unit:2,symbol:'',chn:'苹果?'}]}:{cards})},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));
    } else if(request.url.endsWith('/images/generations')) {
        calls.push('image');assert.equal(body.prompt,cards[0].image_prompt);
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
    } else {
        calls.push('speech');assert.equal(body.voice,'fixture-voice');assert.ok([cards[0].name,cards[0].example_en].includes(body.input));
        response.writeHead(200,{'Content-Type':'audio/mpeg'});response.end(audio);
    }
}
async function seed() {
    for(const [id,operation,output] of [['text','chat','text'],['vision','chat','text'],['image','image.generate','image'],['speech','speech.synthesize','audio']]) {
        const model={id:`fixture-${id}`,name:id,category:operation==='chat'?'chat':output,supportsVision:id==='vision',supportsTools:true,supportsStructuredOutput:true};
        const provider={id,name:id,implementation:'openai-compatible',baseURL:endpoint,apiKey:'fixture-key',enabled:true,models:[model]};
        if(operation!=='chat') {
            provider.media={[operation]:{adapter:id==='image'?'openai-images':'openai-speech'}};
            model.operations={[operation]:{inputModalities:['text'],outputModalities:[output],formats:[id==='image'?'png':'mp3'],...(id==='speech'?{voices:['fixture-voice']}:{})}};
        }
        await save(`etc/llm/.providers/${id}.json`,provider);
        await save(`etc/llm/.connections/${id}.json`,{id,name:id,providerId:id,enabled:true,protocol:'openai-chat',tiers:{optimal:model.id,standard:model.id}});
    }
}
async function save(relative,value) {
    const target=path.join(workspace,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));return target;
}
async function invoke(...args) {
    try { return await promisify(execFile)(process.execPath,[...cli,...args,'--profile',workspace,'--state-dir',workspace,'--headless','--json'],{
        cwd:workspace,timeout:45000,maxBuffer:4000000,env:{...process.env,ANKI_CLI_BIN:binary,MINDOS_TOOL_MODULES:JSON.stringify([path.join(repo,'tools/anki-cli/node/extension.mjs')]),XDG_CONFIG_HOME:path.join(workspace,'xdg'),MINDOS_LOG_DIR:path.join(workspace,'logs')},
    }); } catch(error) {
        if(error.code===3 && error.stderr?.includes('run.waiting')) return {stdout:error.stdout,stderr:error.stderr};
        throw new Error(`${error.message}\n${error.stderr}\n${error.stdout}\nworkspace=${workspace}`);
    }
}
async function walk(root) {
    const files=[];for(const item of await readdir(root,{withFileTypes:true})){const full=path.join(root,item.name);if(item.isDirectory())files.push(...await walk(full));else files.push(full);}return files;
}
