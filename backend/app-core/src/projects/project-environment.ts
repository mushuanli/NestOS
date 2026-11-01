import {createModuleLogger, randomUUID} from '@itookit/common';
import {FSError, type IFileSystem} from '@itookit/vfs-core';
import type {ProjectExecutionContext} from './execution/contracts';
export interface LocalProjectEnvironment {revision: number; variables: Record<string,string>}
export function validateProjectVariables(variables: Record<string,string>): void {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.keys(variables).length > 64) throw new FSError('EINVAL','Project environment allows at most 64 variables');
    for (const [key,value] of Object.entries(variables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new FSError('EINVAL','Invalid environment variable name');
        if (typeof value !== 'string' || new TextEncoder().encode(value).length > 8192 || value.includes('\0')) throw new FSError('EINVAL','Environment values must be text without NUL, at most 8192 bytes');
        if (/^(NESTOS_|FS_AGENT_|PI_AGENT_)/.test(key) || ['LD_PRELOAD','LD_LIBRARY_PATH','CODEX_HOME','CLAUDE_CONFIG_DIR','DSH_HOME'].includes(key)) throw new FSError('EACCES','Environment variable is reserved by the execution host');
    }
}
function decodeEnvironment(raw: string | null | undefined): LocalProjectEnvironment {
    try {
        const value = raw ? JSON.parse(raw) as LocalProjectEnvironment : {revision:0,variables:{}};
        if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid revision');
        validateProjectVariables(value.variables);
        return value;
    } catch {throw new FSError('EIO','Stored project environment is invalid');}
}
/** Project defaults are versioned independently of names and process lifetimes. */
export class ProjectEnvironmentStore {
    constructor(private readonly fs: IFileSystem) {}
    private path(id: string): string {if (!/^[\w-]+$/.test(id)) throw new FSError('EINVAL','Invalid project ID'); return `/var/lib/projects/${id}/settings.seq`;}
    async read(id: string): Promise<LocalProjectEnvironment> {
        const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('project-environment'); let stage = 'read';
        try {
            const path = this.path(id);
            const raw = await this.fs.driver.exists(path) ? await this.fs.meta.seq!.getEntry(path,'environment') : null;
            stage = 'decode'; const value = decodeEnvironment(raw);
            log.info('project.environment.read',{operationId,projectId:id,stage,result:'success',revision:value.revision,count:Object.keys(value.variables).length,durationMs:Date.now()-started});
            return value;
        } catch (error) {log.warn('project.environment.read',{operationId,projectId:id,stage,result:'failure',code:error instanceof FSError?error.code:'PROJECT_ENVIRONMENT_READ_FAILED',durationMs:Date.now()-started}); throw error;}
    }
    async save(id: string, expected: number, variables: Record<string,string>): Promise<void> {
        const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('project-environment'); let stage = 'validate';
        try {
            variables = structuredClone(variables);
            validateProjectVariables(variables);
            if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) throw new FSError('EINVAL','Invalid project environment revision');
            const path = this.path(id); stage = 'prepare-storage';
            if (!await this.fs.driver.exists(path)) {
                try {await this.fs.driver.createFile({parentPath:path.slice(0,path.lastIndexOf('/')),name:'settings.seq',type:'seqfile',recursive:true});}
                catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
            }
            stage = 'persist';
            await this.fs.meta.seq!.transaction!(async tx => {
                const raw = await tx.getEntry(path,'environment'), revision = decodeEnvironment(raw).revision;
                if (revision !== expected) throw new FSError('ECONFLICT','Project environment changed; reload settings before saving');
                await tx.setEntry(path,'environment',JSON.stringify({revision:expected+1,variables}));
            });
            log.info('project.environment.save',{operationId,projectId:id,stage,result:'success',count:Object.keys(variables).length,durationMs:Date.now()-started});
        } catch (error) {log.warn('project.environment.save',{operationId,projectId:id,stage,result:'failure',code:error instanceof FSError?error.code:'PROJECT_ENVIRONMENT_FAILED',durationMs:Date.now()-started}); throw error;}
    }
}
export function withProjectEnvironment(context: ProjectExecutionContext, variables: Record<string,string>): ProjectExecutionContext {
    const defaults = structuredClone(variables), shell = context.nativeShell, tty = context.ttyDriver;
    return {...context, nativeShell: shell && {capabilities:shell.capabilities,
        exec:(command,args,options) => shell.exec(command,args,{...options,env:{...defaults,...options?.env}})},
        ttyDriver: tty && {supportsPty:tty.supportsPty,spawn:(command,args,options) => tty.spawn(command,args,{...options,env:{...defaults,...options?.env}})}};
}
