import {FSError, type IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ProjectFolder} from '@itookit/app-contracts/services';
const path = '/etc/system-personal-project.json';
/** Reserved identity is separate from the user's selectable default project. */
export class PersonalProject {
    id?: string;
    private pending?: Promise<ProjectFolder>;
    constructor(private fs: IFileSystem, private list: () => Promise<ProjectFolder[]>, private create: () => Promise<ProjectFolder>, private legacyName: string) {}
    ensure(): Promise<ProjectFolder> {return this.pending ??= this.resolve().finally(() => {this.pending = undefined;});}
    private async resolve(): Promise<ProjectFolder> {
        const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('personal-project');
        try {
            if (!this.id && await this.fs.driver.exists(path)) {
                const record = JSON.parse(await this.fs.driver.readContent(path,{encoding:'utf-8'}));
                if (typeof record?.id !== 'string' || !record.id.trim()) throw new FSError('EINVAL','Invalid personal project identity');
                this.id = record.id;
            }
            const projects = await this.list();
            const saved = projects.find(project => project.project.id === this.id);
            if (saved) return saved;
            const legacy = !this.id && projects.find(project => project.name === this.legacyName && project.project.source?.kind !== 'remote');
            const project = legacy || await this.create(), content = JSON.stringify({id:project.project.id});
            if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path,content);
            else await this.fs.driver.createFile({parentPath:'/etc',name:'system-personal-project.json',content,recursive:true});
            this.id = project.project.id;
            log.info('project.personal.ensure',{operationId,stage:'complete',result:'success',projectId:this.id,durationMs:Date.now()-started}); return project;
        } catch (error) {
            log.error('project.personal.ensure',{operationId,stage:'ensure',result:'failure',code:error instanceof FSError?error.code:'PERSONAL_PROJECT_FAILED',durationMs:Date.now()-started});throw error;
        }
    }
}
