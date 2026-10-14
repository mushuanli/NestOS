import { randomUUID, t } from '@itookit/common';
import type { IFileSystem } from '@itookit/vfs-core';
import { toolboxKind, type ToolboxKind } from './toolbox-identity';

import { DRAWER_KINDS, drawerKind, ungroupedId, type Drawer, type DrawerKind } from '@itookit/app-contracts';
export { DRAWER_KINDS, drawerKind, ungroupedId, type Drawer, type DrawerKind } from '@itookit/app-contracts';
interface State { version: 1; names: Record<string, { kind: DrawerKind; name: string }>; assignments: Record<string, string>; removed: string[] }
const path = '/ui/toolbox-drawers.json';
const normalized = (name: string): string => name.trim().normalize('NFC').toLocaleLowerCase();

/** Navigation metadata never changes the resource's source identity or permissions. */
export class ToolboxDrawers {
    private state: State = { version: 1, names: {}, assignments: {}, removed: [] };
    private resources: Array<{ path: string; kind: DrawerKind; groupId?: string }> = [];
    private defaults: readonly Drawer[] = [];
    setCatalog(resources: Array<{ path: string; kind: DrawerKind; groupId?: string }>, defaults: readonly Drawer[]): void {
        this.resources = structuredClone(resources); this.defaults = structuredClone(defaults);
    }
    snapshot(): readonly Drawer[] { return this.project(this.state); }
    private project(state: State): readonly Drawer[] {
        const groups = new Map(this.defaults.filter(group => !state.removed.includes(group.id)).map(group => [group.id, { ...group, paths: [] as string[] }]));
        for (const [id, value] of Object.entries(state.names)) groups.set(id, { ...value, id, paths: [], icon: groups.get(id)?.icon });
        for (const kind of DRAWER_KINDS) groups.set(ungroupedId(kind), { id: ungroupedId(kind), kind, name: t('toolbox.ungrouped'), paths: [] });
        for (const item of this.resources) {
            const preferred = state.assignments[item.path] ?? item.groupId ?? ungroupedId(item.kind), group = groups.get(preferred);
            (group?.kind === item.kind ? group : groups.get(ungroupedId(item.kind))!).paths.push(item.path);
        }
        return [...groups.values()].filter(group => group.paths.length || !!state.names[group.id] || !this.resources.some(item => item.kind === group.kind));
    }
    get(id: string): Drawer | undefined { return this.snapshot().find(group => group.id === id); }
    private tail: Promise<void> = Promise.resolve();
    constructor(private readonly fs: IFileSystem) {}
    async init(): Promise<void> {
        if (!await this.fs.driver.exists(path)) return;
        const data = JSON.parse(await this.fs.driver.readContent(path, { encoding: 'utf-8' }));
        if (data?.version !== 1 || !data.names || !data.assignments || Array.isArray(data.names) || Array.isArray(data.assignments) || !Array.isArray(data.removed)) throw new Error(t('toolbox.drawerInvalid'));
        for (const value of Object.values(data.names) as Array<{ kind: ToolboxKind; name: string }>)
            if (!value || !drawerKind(value.kind) || typeof value.name !== 'string') throw new Error(t('toolbox.drawerInvalid'));
        if (Object.values(data.assignments).some(id => typeof id !== 'string') || data.removed.some((id: unknown) => typeof id !== 'string')) throw new Error(t('toolbox.drawerInvalid'));
        this.state = data;
    }
    list(kind: DrawerKind): Drawer[] {
        return this.snapshot().filter(item => item.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    }
    forPath(resource: string): Drawer | undefined { return this.snapshot().find(group => group.paths.includes(resource)); }
    async assign(entries: Array<{ path: string; name: string }>, empty: Array<{ kind: DrawerKind; name: string }> = [], options: { restoreNames?: boolean } = {}): Promise<void> {
        await this.change(state => {
            for (const group of empty) this.resolve(state, group.kind, group.name, options.restoreNames);
            for (const entry of entries) {
                const kind = toolboxKind(entry.path); if (!drawerKind(kind)) continue;
                const id = this.resolve(state, kind, entry.name, options.restoreNames);
                state.assignments[entry.path] = id;
            }
        });
    }
    async relocate(kind: DrawerKind, nodes: Array<{ oldPath: string; newPath: string }>): Promise<void> {
        nodes = nodes.filter(node => node.oldPath && node.newPath && node.oldPath !== node.newPath);
        if (!nodes.length) return;
        await this.change(state => {
            for (const node of nodes) {
                const oldPath = '/' + kind + node.oldPath, newPath = '/' + kind + node.newPath;
                const group = this.forPath(oldPath);
                if (group) { state.assignments[newPath] = group.id; if (group.id !== ungroupedId(kind)) state.names[group.id] ??= { kind, name: group.name }; }
                delete state.assignments[oldPath];
            }
        });
    }
    async create(kind: DrawerKind, name: string): Promise<void> { await this.change(state => { this.resolve(state, kind, name); }); }
    async rename(group: Drawer, name: string): Promise<void> {
        name = this.validate(name);
        await this.change(state => {
            if (this.project(state).some(item => item.kind === group.kind && item.id !== group.id && normalized(item.name) === normalized(name))) throw new Error(t('toolbox.drawerExists'));
            state.names[group.id] = { kind: group.kind, name };
        });
    }
    async remove(group: Drawer): Promise<void> {
        await this.change(state => {
            delete state.names[group.id]; state.removed = [...new Set([...state.removed, group.id])];
            const paths = new Set([...group.paths, ...Object.keys(state.assignments).filter(key => state.assignments[key] === group.id)]);
            for (const resource of paths) state.assignments[resource] = ungroupedId(group.kind);
        });
    }
    private validate(name: string): string {
        const value = name.trim().normalize('NFC');
        if (!value || value.length > 80) throw new Error(t('toolbox.drawerNameRequired'));
        return value;
    }
    private resolve(state: State, kind: DrawerKind, name: string, restoreName = false): string {
        if (!name.trim() || normalized(name) === normalized(t('toolbox.ungrouped'))) return ungroupedId(kind);
        name = name.trim().normalize('NFC');
        const saved = Object.entries(state.names).find(([, value]) => value.kind === kind && normalized(value.name) === normalized(name));
        const existing = this.list(kind).find(item => normalized(item.name) === normalized(name));
        if (saved) return saved[0];
        if (existing && !state.removed.includes(existing.id)) return existing.id;
        if (!restoreName) name = this.validate(name);
        const id = '/drawers/' + randomUUID(); state.names[id] = { kind, name }; return id;
    }
    private change(update: (state: State) => void): Promise<void> {
        const work = this.tail.then(async () => {
            const state = structuredClone(this.state); update(state);
            const content = JSON.stringify(state, null, 2);
            if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path, content);
            else await this.fs.driver.createFile({ name: 'toolbox-drawers.json', parentPath: '/ui', content, recursive: true });
            this.state = state;
        });
        this.tail = work.catch(() => {}); return work;
    }
}
