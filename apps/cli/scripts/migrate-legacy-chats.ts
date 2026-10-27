/**
 * @file scripts/migrate-legacy-chats.ts
 * @desc One-off recovery of legacy file-based chats into Durable Sessions.
 *
 * The pre-Session desktop app stored every chat as `<dataRoot>/module/chats/<name>.chat`
 * (a ChatNode manifest) plus a sibling `_<name>.chat/` directory holding one
 * `*.chat` file per message. The current layout never reads `<dataRoot>/module/`,
 * and Session storage is a Round DAG of SeqFile records inside the module SQLite
 * sidecar, so those chats are invisible until they are converted and imported.
 *
 * Conversion follows the project's own historical ChatNode → Round migration
 * (`llm-engine/src/persistence/migration.ts`, removed in a42ee7af): walk each named
 * branch chain from its head back to the root, dedupe the shared prefix, pair each
 * user message with its assistant answer into one Round, and keep the sibling
 * assistant answers as forked Rounds.
 *
 * Dry run by default: it scans, converts and validates every Session in memory and
 * prints the plan without touching anything. `--apply` writes through the real
 * Session repository and records each source in `<dataRoot>/etc/legacy-chat-import.json`
 * so re-running is a no-op.
 *
 *   pnpm --filter @itookit/cli exec tsx scripts/migrate-legacy-chats.ts --root /path/to/data
 *   pnpm --filter @itookit/cli exec tsx scripts/migrate-legacy-chats.ts --root /path/to/data --apply
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { SessionRepository } from '@itookit/llm-session';
import { parseSessionBundle } from '@itookit/app-core';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';

/**
 * Legacy system rounds only ever carried the default "You are a helpful assistant."
 * prompt; the current model keeps that in session settings, so they are dropped.
 */
const DEFAULT_SOURCE = 'module/chats';
const JOURNAL_PATH = 'etc/legacy-chat-import.json';

// ── Legacy shapes ──────────────────────────────────────────────────────────

interface LegacyNode {
    id: string; role: 'system' | 'user' | 'assistant'; content: string; createdAt: number;
    parentId: string | null; childrenIds: string[]; deleted: boolean; parentUserNodeId?: string; thinking?: string; agentId?: string;
}
interface LegacyChat { file: string; folder: string | null; title: string; summary?: string; uiState?: Record<string, unknown>;
    branchHeads: Record<string, string>; currentBranch: string; rootId: string | null; assetDirs: string[] }

// ── Current shapes (kept structural: the repository validates the real ones) ──

interface RoundDocument {
    id: string; sessionId: string; historyParentIds: string[]; input: Array<{ role: string; content: string; thinking?: string }>;
    output: Array<{ role: string; content: string; thinking?: string }>; executions: never[];
    status: 'completed'; createdAt: number; completedAt?: number; origin: 'user'; agentId?: string;
}
interface ConvertedChat { rounds: RoundDocument[]; manifest: Record<string, unknown>; droppedSystem: number; droppedDeleted: number; }

// ── Arguments ──────────────────────────────────────────────────────────────

interface Options { root: string; source: string; apply: boolean; help: boolean; configDir: string }

function parseArgs(argv: string[]): Options {
    const options: Options = { root: '', source: DEFAULT_SOURCE, apply: false, help: false,
        configDir: process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config') };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--apply') options.apply = true;
        else if (flag === '--help' || flag === '-h') options.help = true;
        else if (flag === '--root' || flag === '--source' || flag === '--config-dir') {
            const value = argv[++index]; if (!value) throw new Error(`${flag} needs a value`);
            if (flag === '--root') options.root = value; else if (flag === '--source') options.source = value; else options.configDir = value;
        } else throw new Error(`Unknown argument: ${flag}`);
    }
    return options;
}

const USAGE = `旧版文件式聊天 → Durable Session 迁移工具

  --root <dir>        数据根（默认取 ~/.config/nestos/nestos.json#rootDir）
  --source <rel>      旧聊天目录，相对数据根（默认 ${DEFAULT_SOURCE}）
  --apply             真正写入（默认只做 dry-run，不碰任何文件）
  --config-dir <dir>  nestos.json 所在目录（默认 $XDG_CONFIG_HOME 或 ~/.config）

先跑 dry-run 看清单，确认后再加 --apply；写入前请退出正在使用该数据根的 Tauri/CLI。`;

/** nestos.json#rootDir wins, then <configDir>/nestos/data — same order as the app. */
async function resolveRoot(options: Options): Promise<string> {
    if (options.root) return path.resolve(options.root);
    const configDir = path.join(options.configDir, 'nestos');
    try {
        const settings = JSON.parse(await readFile(path.join(configDir, 'nestos.json'), 'utf8')) as { rootDir?: unknown };
        if (typeof settings.rootDir === 'string' && settings.rootDir) return path.resolve(configDir, settings.rootDir);
    } catch { /* fall through to the default layout */ }
    return path.join(configDir, 'data');
}

// ── Scanning ───────────────────────────────────────────────────────────────

async function* walkFiles(dir: string): AsyncGenerator<string> {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkFiles(full);
        else if (entry.isFile()) yield full;
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

function toNode(doc: Record<string, unknown>): LegacyNode | undefined {
    const id = asString(doc.id), role = asString(doc.role);
    if (!id || (role !== 'system' && role !== 'user' && role !== 'assistant')) return undefined;
    const meta = isRecord(doc.meta) ? doc.meta : {};
    const createdAt = Date.parse(asString(doc.created_at) ?? '') ;
    return { id, role, content: asString(doc.content) ?? '', createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        parentId: asString(doc.parent_id) ?? null, childrenIds: (Array.isArray(doc.children_ids) ? doc.children_ids : []).filter((v): v is string => typeof v === 'string'),
        deleted: doc.status === 'deleted', parentUserNodeId: asString(meta.parentUserNodeId), thinking: asString(meta.thinking), agentId: asString(meta.agentId) };
}

function toChat(file: string, doc: Record<string, unknown>, relative: string): LegacyChat | undefined {
    const title = asString(doc.title), branches = isRecord(doc.branches) ? doc.branches : undefined;
    if (!title || !branches) return undefined;
    const branchHeads: Record<string, string> = {};
    for (const [name, head] of Object.entries(branches)) { const id = asString(head); if (id) branchHeads[name] = id; }
    const uiState = doc.ui_state ?? doc.uiState;
    return { file, folder: path.dirname(relative) === '.' ? null : '/' + path.dirname(relative).split(path.sep).join('/'),
        title, summary: asString(doc.summary), uiState: isRecord(uiState) ? uiState : undefined, branchHeads,
        currentBranch: asString(doc.current_branch) ?? asString(doc.currentBranch) ?? 'main',
        rootId: asString(doc.root_id) ?? asString(doc.rootRoundId) ?? null,
        assetDirs: [`_${path.basename(file)}`, `_${path.basename(file).replace(/\.chat$/, '')}`, `_${title}`].map(name => path.join(path.dirname(file), name)) };
}

/** Every JSON file under the legacy tree, split into chat manifests and message nodes. */
async function scanLegacy(sourceDir: string): Promise<{ chats: LegacyChat[]; nodes: Map<string, Map<string, LegacyNode>> }> {
    const chats: LegacyChat[] = [];
    const byAssetDir = new Map<string, Map<string, LegacyNode>>();
    for await (const file of walkFiles(sourceDir)) {
        let doc: unknown; try { doc = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
        if (!isRecord(doc)) continue;
        const node = toNode(doc);
        if (node && doc.title === undefined) {
            const dir = path.dirname(file);
            const bucket = byAssetDir.get(dir) ?? new Map<string, LegacyNode>();
            if (!bucket.has(node.id)) bucket.set(node.id, node);
            byAssetDir.set(dir, bucket);
            continue;
        }
        const chat = toChat(file, doc, path.relative(sourceDir, file));
        if (chat) chats.push(chat);
    }
    return { chats: chats.sort((a, b) => a.file.localeCompare(b.file)), nodes: byAssetDir };
}

/** Message nodes for one chat: its asset directories, or its own directory as a fallback. */
function chatNodes(chat: LegacyChat, byAssetDir: Map<string, Map<string, LegacyNode>>): Map<string, LegacyNode> {
    const nodes = new Map<string, LegacyNode>();
    for (const dir of chat.assetDirs) for (const [id, node] of byAssetDir.get(dir) ?? []) if (!nodes.has(id)) nodes.set(id, node);
    if (nodes.size) return nodes;
    for (const [id, node] of byAssetDir.get(path.dirname(chat.file)) ?? []) nodes.set(id, node);
    return nodes;
}

// ── Conversion ─────────────────────────────────────────────────────────────

const message = (role: string, content: string, thinking?: string) => ({ role, content, ...(thinking ? { thinking } : {}) });

/** Deleted nodes and default-prompt system nodes are gone; children are re-hung on the survivor above. */
function survivingParents(nodes: Map<string, LegacyNode>): { alive: Map<string, LegacyNode>; parentOf: Map<string, string | null>; droppedSystem: number; droppedDeleted: number } {
    const alive = new Map<string, LegacyNode>(), dropped = new Set<string>();
    let droppedSystem = 0, droppedDeleted = 0;
    for (const node of nodes.values()) {
        if (node.role === 'system') { dropped.add(node.id); droppedSystem++; }
        else if (node.deleted) { dropped.add(node.id); droppedDeleted++; }
        else alive.set(node.id, node);
    }
    const parentOf = new Map<string, string | null>();
    const resolve = (id: string): string | null => {
        const seen = new Set<string>();
        let current = nodes.get(id)?.parentId ?? null;
        while (current && !seen.has(current)) { seen.add(current); if (alive.has(current)) return current; current = nodes.get(current)?.parentId ?? null; }
        return null;
    };
    for (const id of alive.keys()) parentOf.set(id, resolve(id));
    return { alive, parentOf, droppedSystem, droppedDeleted };
}

/** Ordered node chains: one per named branch head, walking back to the root. */
function branchChains(chat: LegacyChat, alive: Map<string, LegacyNode>, parentOf: Map<string, string | null>): Map<string, string[]> {
    const chains = new Map<string, string[]>();
    const heads = Object.entries(chat.branchHeads).map(([name, id]) => [name, alive.has(id) ? id : nearestAlive(id, alive, parentOf)] as const);
    for (const [name, head] of heads) {
        if (!head || chains.has(name)) continue;
        const chain: string[] = []; const seen = new Set<string>();
        let current: string | null = head;
        while (current && !seen.has(current)) { seen.add(current); chain.unshift(current); current = parentOf.get(current) ?? null; }
        chains.set(name, chain);
    }
    if (!chains.size) chains.set('main', [...alive.keys()]);
    return chains;
}

/** Closest surviving ancestor of a head that itself was dropped. */
function nearestAlive(id: string, alive: Map<string, LegacyNode>, parentOf: Map<string, string | null>): string | null {
    if (alive.has(id)) return id;
    return parentOf.get(id) ?? null;
}

/** Pair each user message with its assistant answer; a loose assistant joins the previous pair. */
function pairsOfChain(chain: string[], alive: Map<string, LegacyNode>): Array<{ anchor: string; assistant?: string }> {
    const pairs: Array<{ anchor: string; assistant?: string }> = [];
    const byUser = new Map<string, { anchor: string; assistant?: string }>();
    const ordered = chain.map(id => alive.get(id)!).filter(Boolean);
    // Messages already declare which user they answer; trust that before falling back to order.
    const anchored = new Set(ordered.filter(node => node.role === 'assistant' && node.parentUserNodeId && alive.has(node.parentUserNodeId)).map(node => node.id));
    for (const node of ordered) {
        if (node.role === 'user') { const pair = { anchor: node.id }; pairs.push(pair); byUser.set(node.id, pair); continue; }
        const target = node.parentUserNodeId ? byUser.get(node.parentUserNodeId) : undefined;
        if (anchored.has(node.id) && target) { if (!target.assistant) target.assistant = node.id; else pairs.push({ anchor: node.id, assistant: node.id }); continue; }
        const last = pairs[pairs.length - 1];
        if (last && !last.assistant && !anchored.has(node.id)) last.assistant = node.id;
        else pairs.push({ anchor: node.id, assistant: node.id });
    }
    return pairs;
}

/** ChatNode chains → the current Round DAG. Shared prefixes keep the same Round identity. */
function convertChat(chat: LegacyChat, nodes: Map<string, LegacyNode>, sessionId: string): ConvertedChat {
    const { alive, parentOf, droppedSystem, droppedDeleted } = survivingParents(nodes);
    const chains = branchChains(chat, alive, parentOf);
    const rounds = new Map<string, RoundDocument>();
    const roundOfNode = new Map<string, string>();

    for (const chain of chains.values()) for (const { anchor, assistant } of pairsOfChain(chain, alive)) {
        if (roundOfNode.has(anchor)) continue;
        const anchorNode = alive.get(anchor);
        if (!anchorNode) continue;
        const assistantNode = assistant && assistant !== anchor ? alive.get(assistant) : undefined;
        const round = anchorNode.role === 'assistant' && anchorNode.parentUserNodeId
            ? forkRound(anchorNode, assistantNode, anchorNode.parentUserNodeId, roundOfNode, rounds)
            : anchorNode.role === 'assistant' ? orphanRound(anchorNode, sessionId, parentRoundOf(anchorNode, parentOf, roundOfNode))
            : userRound(anchorNode, assistantNode, parentRoundOf(anchorNode, parentOf, roundOfNode), sessionId);
        rounds.set(round.id, round); roundOfNode.set(anchor, round.id);
        if (assistantNode) roundOfNode.set(assistantNode.id, round.id);
    }

    const branchHeads: Record<string, string> = {};
    for (const [name, chain] of chains) for (let index = chain.length - 1; index >= 0; index--) {
        const roundId = roundOfNode.get(chain[index]);
        if (roundId) { branchHeads[name] = roundId; break; }
    }
    const currentBranch = branchHeads[chat.currentBranch] ? chat.currentBranch : Object.keys(branchHeads)[0] ?? 'main';
    return { rounds: [...rounds.values()], droppedSystem, droppedDeleted,
        manifest: { title: chat.title, ...(chat.summary ? { summary: chat.summary } : {}), origin: 'tauri',
            ...(chat.uiState ? { uiState: modernUiState(chat.uiState, currentBranch) } : {}),
            rootRoundId: rootRoundOf(rounds), branches: branchHeads, branchMeta: branchMetaOf(branchHeads, currentBranch),
            currentBranch, currentHead: branchHeads[currentBranch] ?? null, children: childrenOf(rounds) } };
}

/** A user message plus the answer it produced. */
function userRound(anchor: LegacyNode, assistant: LegacyNode | undefined, parent: string | null, sessionId: string): RoundDocument {
    return { id: anchor.id, sessionId, historyParentIds: parent ? [parent] : [], input: [message('user', anchor.content)],
        output: assistant ? [message('assistant', assistant.content, assistant.thinking)] : [], executions: [], status: 'completed',
        createdAt: anchor.createdAt || Date.now(), ...(assistant ? { completedAt: assistant.createdAt || anchor.createdAt } : {}),
        origin: 'user', ...(assistant?.agentId ?? anchor.agentId ? { agentId: assistant?.agentId ?? anchor.agentId } : {}) };
}

/** An answer whose question is gone: kept as assistant output, never re-labelled as user input. */
function orphanRound(anchor: LegacyNode, sessionId: string, parent: string | null): RoundDocument {
    return { id: anchor.id, sessionId, historyParentIds: parent ? [parent] : [], input: [],
        output: [message('assistant', anchor.content, anchor.thinking)], executions: [], status: 'completed',
        createdAt: anchor.createdAt || Date.now(), completedAt: anchor.createdAt || Date.now(), origin: 'user',
        ...(anchor.agentId ? { agentId: anchor.agentId } : {}) };
}

/** A regenerated/alternative answer: a sibling Round of the one it competes with, same question. */
function forkRound(anchor: LegacyNode, assistant: LegacyNode | undefined, baseAnchor: string, roundOfNode: Map<string, string>, rounds: Map<string, RoundDocument>): RoundDocument {
    const base = rounds.get(roundOfNode.get(baseAnchor) ?? '');
    const answer = assistant ?? anchor;
    return { id: anchor.id, sessionId: base?.sessionId ?? '', historyParentIds: [...(base?.historyParentIds ?? [])], input: [...(base?.input ?? [])],
        output: [message('assistant', answer.content, answer.thinking)], executions: [], status: 'completed',
        createdAt: anchor.createdAt || Date.now(), completedAt: answer.createdAt || anchor.createdAt, origin: 'user',
        ...(answer.agentId ? { agentId: answer.agentId } : {}) };
}

/** Nearest Round already built for an ancestor message. */
function parentRoundOf(node: LegacyNode, parentOf: Map<string, string | null>, roundOfNode: Map<string, string>): string | null {
    let current: string | null = node.parentUserNodeId ?? parentOf.get(node.id) ?? null;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
        seen.add(current);
        const roundId = roundOfNode.get(current); if (roundId) return roundId;
        current = parentOf.get(current) ?? null;
    }
    return null;
}
const rootRoundOf = (rounds: Map<string, RoundDocument>) => [...rounds.values()].find(r => !r.historyParentIds.length)?.id ?? null;
function childrenOf(rounds: Map<string, RoundDocument>): Record<string, string[]> {
    const children: Record<string, string[]> = {};
    for (const round of rounds.values()) for (const parent of round.historyParentIds) (children[parent] ??= []).push(round.id);
    return children;
}
function branchMetaOf(branchHeads: Record<string, string>, _currentBranch: string): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    for (const [name, head] of Object.entries(branchHeads)) {
        if (name === 'main') continue;
        meta[name] = { createdAt: Date.now(), createdFrom: 'manual', forkedFromBranch: 'main', branchRootRoundId: head };
    }
    return meta;
}
/** Legacy snake_case editor state → the current ConversationUIState. */
function modernUiState(legacy: Record<string, unknown>, branch: string): Record<string, unknown> {
    const collapseStates = isRecord(legacy.collapseStates) ? legacy.collapseStates : isRecord(legacy.collapse_states) ? legacy.collapse_states : undefined;
    const inputText = asString(legacy.inputText) ?? asString(legacy.input_text);
    const inputAgentId = asString(legacy.inputAgentId) ?? asString(legacy.input_agent_id);
    const historyVisibility = asString(legacy.historyVisibility);
    return { ...(collapseStates ? { collapseStates } : {}), ...(historyVisibility === 'visible' || historyVisibility === 'hidden' ? { historyVisibility } : {}),
        ...(inputText || inputAgentId ? { branchDrafts: { [branch]: { ...(inputText ? { inputText } : {}), ...(inputAgentId ? { inputAgentId } : {}) } } } : {}) };
}

// ── Plan ───────────────────────────────────────────────────────────────────

interface Plan { chat: LegacyChat; converted?: ConvertedChat; error?: string }

/** Converts one chat and validates the result through the real bundle parser. */
function planChat(chat: LegacyChat, nodes: Map<string, LegacyNode>): Plan {
    try {
        if (!nodes.size) return { chat, error: '资源目录为空或缺失，找不到消息文件' };
        const converted = convertChat(chat, nodes, 'validation');
        if (!converted.rounds.length) return { chat, error: '没有可导入的消息（全部为空/已删除）' };
        parseSessionBundle(JSON.stringify({ format: 'itookit.session', version: 2, manifest: converted.manifest, settings: {},
            documents: Object.fromEntries(converted.rounds.map(round => [`round-${round.id}.json`, JSON.stringify(round)])), attachments: [] }));
        return { chat, converted };
    } catch (error) { return { chat, error: error instanceof Error ? error.message : String(error) }; }
}

function report(plans: Plan[], sourceDir: string): void {
    const ok = plans.filter(plan => !plan.error);
    console.log(`\n扫描 ${sourceDir}`);
    console.log(`${plans.length} 个旧会话：可导入 ${ok.length}，跳过 ${plans.length - ok.length}\n`);
    for (const plan of plans) {
        const label = plan.chat.file.replace(/^.*\/module\/chats\//, '');
        if (plan.error) { console.log(`  跳过  ${label}\n        原因: ${plan.error}`); continue; }
        const c = plan.converted!;
        const dropped = [c.droppedSystem ? `系统轮 ${c.droppedSystem}` : '', c.droppedDeleted ? `已删除 ${c.droppedDeleted}` : ''].filter(Boolean).join('、');
        console.log(`  导入  ${label}\n        ${c.rounds.length} 轮 / ${Object.keys(c.manifest.branches as object).length} 分支${plan.chat.folder ? ` / 文件夹 ${plan.chat.folder}` : ''}${dropped ? ` / 丢弃 ${dropped}` : ''}`);
    }
    const rounds = ok.reduce((sum, plan) => sum + plan.converted!.rounds.length, 0);
    console.log(`\n合计将写入 ${ok.length} 个 Session、${rounds} 轮。`);
}

// ── Apply ──────────────────────────────────────────────────────────────────

interface Journal { version: 1; imports: Array<{ source: string; sessionId: string; importedAt: string }> }

async function readJournal(root: string): Promise<Journal> {
    try {
        const parsed = JSON.parse(await readFile(path.join(root, JOURNAL_PATH), 'utf8')) as Journal;
        if (parsed?.version === 1 && Array.isArray(parsed.imports)) return parsed;
    } catch { /* first run */ }
    return { version: 1, imports: [] };
}

async function writeJournal(root: string, journal: Journal): Promise<void> {
    await mkdir(path.dirname(path.join(root, JOURNAL_PATH)), { recursive: true });
    await writeFile(path.join(root, JOURNAL_PATH), JSON.stringify(journal, null, 2));
}

/** Session folders are a flat list with recorded parents, so each level is created in order. */
async function ensureFolder(repository: SessionRepository, folder: string): Promise<void> {
    let current = '';
    for (const part of folder.split('/').filter(Boolean)) { current += '/' + part; await repository.createFolder(current); }
}

async function importChat(repository: SessionRepository, plan: Plan): Promise<string> {
    const { chat, converted } = plan;
    if (chat.folder) await ensureFolder(repository, chat.folder);
    const id = await repository.createSession(chat.title, chat.folder);
    try {
        for (const round of converted!.rounds) await repository.writeDocument(id, `round-${round.id}.json`, JSON.stringify({ ...round, sessionId: id }));
        await repository.updateManifest(id, converted!.manifest);
        return id;
    } catch (error) {
        await repository.deleteSession(id).catch(() => undefined);
        throw error;
    }
}

async function applyPlans(root: string, plans: Plan[]): Promise<void> {
    if (!existsSync(path.join(root, '_meta'))) throw new Error(`数据根尚未初始化（缺少 ${path.join(root, '_meta')}）：请先启动一次应用`);
    const journal = await readJournal(root);
    const done = new Set(journal.imports.map(entry => entry.source));
    const backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(root, '_meta'), createDb: NodeSqliteSidecarDb.open });
    const { manager } = await createVFS({ rootBackend: backend });
    const repository = new SessionRepository(await manager.openFileSystem('/'));
    await repository.init();
    let imported = 0, skipped = 0;
    try {
        for (const plan of plans) {
            if (plan.error) continue;
            if (done.has(plan.chat.file)) { skipped++; continue; }
            const id = await importChat(repository, plan);
            journal.imports.push({ source: plan.chat.file, sessionId: id, importedAt: new Date().toISOString() });
            await writeJournal(root, journal);
            imported++; console.log(`  已导入 ${plan.chat.title} → ${id}`);
        }
    } finally { await repository.dispose(); await manager.dispose(); }
    console.log(`\n写入 ${imported} 个 Session，跳过 ${skipped} 个已在日志中的会话。`);
    console.log(`日志：${path.join(root, JOURNAL_PATH)}`);
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(USAGE); return; }
    const root = await resolveRoot(options);
    const sourceDir = path.resolve(root, options.source);
    if (!existsSync(sourceDir)) throw new Error(`旧聊天目录不存在：${sourceDir}`);
    const { chats, nodes } = await scanLegacy(sourceDir);
    if (!chats.length) { console.log(`没有找到旧会话：${sourceDir}`); return; }
    const plans = chats.map(chat => planChat(chat, chatNodes(chat, nodes)));
    report(plans, sourceDir);
    if (!options.apply) { console.log('\n这是 dry-run，未写入任何内容。确认无误后加 --apply（请先退出正在使用该数据根的应用）。'); return; }
    if (plans.every(plan => plan.error)) { console.log('\n没有可导入的会话。'); return; }
    console.log(`\n写入 ${root} …`);
    await applyPlans(root, plans);
}

main().catch(error => { console.error(`\n迁移失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

export {};
