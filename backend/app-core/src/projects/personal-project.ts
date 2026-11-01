import {LEGACY_LOCAL_PROJECT_NAMES} from '@itookit/app-contracts';
import {FSError, type IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ProjectFolder} from '@itookit/app-contracts/services';
const path = '/etc/system-local-project.json';
const legacyPath = '/etc/system-personal-project.json';
/** Reserved local identity is independent of the user's selectable default. */
export class PersonalProject {
    id?: string;
    migrateName = false;
    private pending?: Promise<ProjectFolder>;
    constructor(private fs: IFileSystem, private list: () => Promise<ProjectFolder[]>, private create: () => Promise<ProjectFolder>, private legacyName: string) {}
    ensure(): Promise<ProjectFolder> {return this.pending ??= this.resolve().finally(() => {this.pending = undefined;});}
    private async readId(): Promise<string | undefined> {
        const source = await this.fs.driver.exists(path) ? path : await this.fs.driver.exists(legacyPath) ? legacyPath : undefined;
        if (!source) return;
        this.migrateName = source === legacyPath;
        const record = JSON.parse(await this.fs.driver.readContent(source,{encoding:'utf-8'}));
        if (typeof record?.id !== 'string' || !record.id.trim()) throw new FSError('EINVAL','Invalid local project identity');
        return record.id;
    }
    private async resolve(): Promise<ProjectFolder> {
        const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('local-project');
        try {
            const savedId = await this.readId() ?? this.id, projects = await this.list();
            const saved = projects.find(p => p.project.id === savedId);
            const legacy = !savedId ? projects.find(p => [this.legacyName,...LEGACY_LOCAL_PROJECT_NAMES].includes(p.name) && p.project.source?.kind !== 'remote') : undefined;
            if (legacy && LEGACY_LOCAL_PROJECT_NAMES.includes(legacy.name)) this.migrateName = true;
            const project = saved ?? legacy ?? await this.create(), content = JSON.stringify({id:project.project.id});
            if (savedId !== project.project.id || !await this.fs.driver.exists(path)) {
                if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path,content);
                else await this.fs.driver.createFile({parentPath:'/etc',name:'system-local-project.json',content,recursive:true});
            }
            this.id = project.project.id;
            log.info('project.local.ensure',{operationId,stage:'complete',result:'success',projectId:this.id,durationMs:Date.now()-started}); return {...project,protected:true};
        } catch (error) {
            log.error('project.local.ensure',{operationId,stage:'ensure',result:'failure',code:error instanceof FSError?error.code:'LOCAL_PROJECT_FAILED',durationMs:Date.now()-started});throw error;
        }
    }
}
