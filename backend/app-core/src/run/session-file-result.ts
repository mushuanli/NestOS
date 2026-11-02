import {load, JSON_SCHEMA} from 'js-yaml';
import {sha256HexSync} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import {failure, readPrompt, type PromptJournal} from './prompt-bundle';

/** Session text carries instructions; immutable files carry application results. */
export async function readSessionFileResult(fs:IFileSystem,path:string,operationId:string,journal:PromptJournal):Promise<unknown|undefined> {
    if(!await fs.driver.exists(path))return;
    const text=await readPrompt(fs,path);
    const value=parseSessionFile(text);
    const result=value as {schema?:string;operationId?:string;payload?:unknown};
    if(!result||result.schema!=='nestos.file-result/1'||result.operationId!==operationId||result.payload===undefined)
        throw failure('SESSION_FILE_RESULT_SCOPE_MISMATCH');
    const digest=sha256HexSync(text);
    await journal.update<{digest:string}>('session-file-result:'+operationId,old=>{
        if(old&&old.digest!==digest)throw failure('SESSION_FILE_RESULT_CHANGED');
        return old??{digest};
    });
    return result.payload;
}
function assertBounded(root:unknown):void {
    const pending=[{value:root,depth:0}];let count=0;
    while(pending.length) {
        const {value,depth}=pending.pop()!;
        if(++count>5000||depth>20)throw failure('SESSION_FILE_RESULT_LIMIT');
        if(value&&typeof value==='object')for(const child of Object.values(value))pending.push({value:child,depth:depth+1});
    }
}

export function sessionFileResultPrompt(path:string,operationId:string):string {
    return `Publish the result payload ONLY as YAML at ${path}, wrapped as {schema: nestos.file-result/1, operationId: ${operationId}, payload: <result object>}. Write a temporary file and atomically rename it. Published files are immutable. Chat output is informational and is never parsed as a result.`;
}

export function parseSessionFile(text:string):unknown {
    try {const value:unknown=load(text,{schema:JSON_SCHEMA,json:false});assertBounded(value);return value;}
    catch {throw failure('SESSION_FILE_RESULT_INVALID');}
}
