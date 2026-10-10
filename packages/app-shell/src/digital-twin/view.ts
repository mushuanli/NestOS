import { escapeHTML, escapeAttr, t } from '@itookit/common';
import { TWIN_KINDS, type DigitalTwinService, type TwinMemoryData, type TwinDataRecord } from '@itookit/app-core';

export type TwinSnapshot = Awaited<ReturnType<DigitalTwinService['snapshot']>>;
export type TwinPage = 'overview' | 'profile' | 'memories' | 'goals' | 'sources';
export const TWIN_PAGES: TwinPage[] = ['overview', 'profile', 'memories', 'goals', 'sources'];
export const label = (key: string) => t(`twin.${key}` as Parameters<typeof t>[0]);
export const button = (action: string, title: string, id = '') => `<button type="button" data-action="${escapeAttr(action)}" data-id="${escapeAttr(id)}">${escapeHTML(label(title))}</button>`;
const input = (name: string, title: string, value = '', type = 'text') => `<label>${escapeHTML(label(title))}<input name="${name}" type="${type}" value="${escapeAttr(value)}"></label>`;
export const select = (name: string, options: Array<{ id: string; name: string }>, selected = '') => `<select name="${name}" aria-label="${escapeAttr(label(name))}">${options.map(option => `<option value="${escapeAttr(option.id)}"${option.id === selected ? ' selected' : ''}>${escapeHTML(option.name)}</option>`).join('')}</select>`;
const checkbox = (name: string, title: string, checked = false) => `<label><input type="checkbox" name="${name}"${checked ? ' checked' : ''}>${escapeHTML(label(title))}</label>`;
const submit = (title: string) => `<button type="submit">${escapeHTML(label(title))}</button>`;

export function overview(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>, sessionId = '', agents: Array<{ id: string; name: string }> = []): string {
    const { settings, memories, jobs } = snapshot;
    return `<p>${escapeHTML(label('overviewHelp'))}</p><p>${escapeHTML(label('scanHost'))}: ${escapeHTML(snapshot.scans.worker.host)} · ${escapeHTML(label('scanHostHelp'))}</p>
        <p>${escapeHTML(snapshot.scans.worker.error)} ${escapeHTML(label('scanLeaseHost'))}: ${escapeHTML(snapshot.scans.worker.ownerHost || label('scanIdle'))}</p>
        <p>${escapeHTML(label('scanPlans'))}: ${snapshot.scans.plans.length} · ${escapeHTML(label('scanState.queued'))}: ${snapshot.scans.runs.filter(run => run.data.state === 'queued').length} · ${escapeHTML(label('scanState.running'))}: ${snapshot.scans.runs.filter(run => run.data.state === 'running').length}</p>
        ${snapshot.cleanupError || snapshot.pendingCleanup.length ? `<p class="twin__error">${escapeHTML(label('cleanupPending'))} (${snapshot.pendingCleanup.length}) ${button('refresh', 'refresh')}</p>` : ''}<p>${escapeHTML(label('counts'))}: ${memories.filter(memory => memory.data.state === 'active' && memory.supported).length} / ${memories.filter(memory => memory.data.state === 'candidate').length}</p>
        <form class="twin__form" data-form="settings">${input('tokenLimit', 'tokenLimit', String(settings.data.tokenLimit), 'number')}
        ${select('connectionId', connections, settings.data.connectionId)}<label>${escapeHTML(label('globalExclude'))}<textarea name="globalExclude">${escapeHTML((settings.data.globalExclude ?? []).join('\n'))}</textarea></label>
        ${checkbox('paused', 'paused', settings.data.paused)}${checkbox('useEnabled', 'useEnabled', settings.data.useEnabled)}${submit('save')}</form>
        <p>${escapeHTML(label('budget'))}: ${settings.data.spentTokens} / ${settings.data.reservedTokens} / ${settings.data.tokenLimit}</p>
        <p>${escapeHTML(label('unknownBudget'))}</p><h3>${escapeHTML(label('grants'))}</h3>${grantForm(snapshot, connections, sessionId, agents)}
        ${snapshot.grants.map(grant => `<article class="twin__card"><p>${escapeHTML(snapshot.sessions.find(session => session.id === grant.id)?.title ?? grant.id)} · ${escapeHTML(grant.data.agentId)} · ${escapeHTML(grant.data.connectionId)} · ${escapeHTML(grant.data.project)} · ${escapeHTML(label(grant.data.enabled ? 'enabled' : 'disabled'))}</p>${button('revokeGrant', 'revoke', grant.id)}</article>`).join('')}
        <h3>${escapeHTML(label('jobs'))}</h3>${jobs.slice(-20).reverse().map(job => `<article class="twin__card">${escapeHTML(label(`job.${job.data.state === 'cancelled' && !job.data.cancelConfirmed ? 'cancelPending' : job.data.state}`))} · ${escapeHTML(job.data.error)} ${escapeHTML(job.data.cleanupError ?? '')}${['queued', 'running'].includes(job.data.state) ? button('cancelJob', 'cancel', job.id) : ''}</article>`).join('')}
        <h3>${escapeHTML(label('usage'))}</h3>${snapshot.uses.slice(-30).reverse().map(use => `<p>${escapeHTML(snapshot.sessions.find(session => session.id === use.data.sessionId)?.title ?? use.data.sessionId)} · ${escapeHTML(new Date(use.data.usedAt).toLocaleString())} · ${use.data.memoryRefs.map(ref => escapeHTML(`${ref.id}@${ref.revision}`)).join(', ')}</p>`).join('')}`;
}
function grantForm(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>, sessionId: string, agents: Array<{ id: string; name: string }>): string {
    return `<p>${escapeHTML(label('grantHelp'))}</p><form class="twin__form" data-form="grant">
        ${select('sessionId', snapshot.sessions.map(session => ({ id: session.id, name: session.title })), sessionId)}
        ${select('agentId', [{ id: '*', name: label('allAgents') }, ...agents])}${select('connectionId', connections)}${input('project', 'project')}
        ${checkbox('consent', 'grantConsent')}${submit('authorize')}</form>`;
}

export function sources(snapshot: TwinSnapshot, _connections: Array<{ id: string; name: string }>): string {
    return `<p>${escapeHTML(label('sourceHelp'))} (${snapshot.sources.length})</p>
        ${snapshot.sources.slice(0, 200).map(source => `<article class="twin__card"><h3>${escapeHTML(source.data.label || source.data.target)}</h3>
        <p>${escapeHTML(source.data.resource?.projectName ?? source.data.resource?.projectId ?? '')} · ${escapeHTML(source.data.target)} · ${escapeHTML(label(source.data.enabled ? 'enabled' : 'disabled'))} · ${escapeHTML(label(`source.${source.data.status}`))}</p>
        <p>${source.data.offset} / ${source.data.characters} · ${escapeHTML(label('checkedAt'))}: ${escapeHTML(new Date(source.observedAt).toLocaleString())}</p></article>`).join('')}`;
}

export function memories(snapshot: TwinSnapshot, page: TwinPage): string {
    const visible = snapshot.memories.filter(memory => page === 'goals' ? ['goal', 'commitment'].includes(memory.data.kind)
        : page === 'profile' ? memory.data.state === 'active' && ['fact', 'preference', 'role', 'relationship', 'project', 'constraint'].includes(memory.data.kind) : true);
    const sorted = [...visible].sort((a, b) => b.data.recordedAt - a.data.recordedAt);
    return `<p>${escapeHTML(label(page === 'profile' ? 'profileHelp' : page === 'goals' ? 'goalHelp' : 'memoryHelp'))}</p>
        <details><summary>${escapeHTML(label('addMemory'))}</summary><form class="twin__form" data-form="memory">${memoryFields(undefined, page === 'goals' ? 'goal' : 'fact')}${submit('addMemory')}</form></details>
        <input class="twin__search" data-search placeholder="${escapeAttr(label('search'))}" aria-label="${escapeAttr(label('search'))}">
        ${page === 'profile' ? profileGroups(snapshot.memories.filter(memory => memory.data.state === 'active')) : ''}
        ${page === 'memories' ? timeline(snapshot.memories) : ''}
        <div class="twin__cards">${sorted.map(memory => memoryCard(memory)).join('') || `<p>${escapeHTML(label('empty'))}</p>`}</div>`;
}
function memoryCard(memory: TwinSnapshot['memories'][number]): string {
    const data = memory.data;
    return `<article class="twin__card" data-memory="${escapeAttr(memory.id)}" data-search-text="${escapeAttr(`${data.content} ${data.subject} ${data.project} ${data.kind} ${data.state}`.toLowerCase())}">
        <h3>${escapeHTML(label(`kind.${data.kind}`))} · ${escapeHTML(label(`state.${data.state}`))}${memory.supported ? '' : ` · ${escapeHTML(label('unsupported'))}`}</h3>
        <p>${escapeHTML(data.content)}</p><p>${escapeHTML(data.subject)} · ${escapeHTML(data.project)} · ${escapeHTML(data.eventTime)}</p>
        ${['goal', 'commitment'].includes(data.kind) ? `<p>${escapeHTML(label(`goal.${data.goalStatus}`))} · ${escapeHTML(data.successCondition)} · ${escapeHTML(data.deadline)}</p>` : ''}
        <details><summary>${escapeHTML(label('evidence'))}</summary><blockquote>${escapeHTML(data.quote || label('userStatement'))}</blockquote><p>${escapeHTML(data.sourceId)} · ${escapeHTML(data.sourceHash)} · ${escapeHTML(memory.revision)}</p></details>
        ${data.state === 'candidate' && memory.supported ? button('confirm', 'confirm', memory.id) : ''}${button('reject', 'reject', memory.id)}${button('dispute', 'dispute', memory.id)}
        <details><summary>${escapeHTML(label('correct'))}</summary><p>${escapeHTML(label('correctHelp'))}</p><form class="twin__form" data-form="correct" data-id="${escapeAttr(memory.id)}">${memoryFields(memory)}${submit('correct')}</form></details>
        ${['goal', 'commitment'].includes(data.kind) && data.state === 'active' ? executionForm(memory) : ''}
        ${button('forget', 'forget', memory.id)}${button('suppress', 'suppress', memory.id)}</article>`;
}
function memoryFields(memory?: TwinDataRecord<TwinMemoryData>, defaultKind = 'fact'): string {
    const data = memory?.data;
    return `<label>${escapeHTML(label('content'))}<textarea name="content" required maxlength="4000">${escapeHTML(data?.content ?? '')}</textarea></label>
        ${select('kind', TWIN_KINDS.map(kind => ({ id: kind, name: label(`kind.${kind}`) })), data?.kind ?? defaultKind)}
        ${input('subject', 'subject', data?.subject ?? 'self')}${input('project', 'project', data?.project)}${input('eventTime', 'eventTime', data?.eventTime)}
        ${select('goalStatus', ['draft', 'active', 'paused', 'completed', 'cancelled'].map(status => ({ id: status, name: label(`goal.${status}`) })), data?.goalStatus ?? 'draft')}
        ${input('successCondition', 'successCondition', data?.successCondition)}${input('deadline', 'deadline', data?.deadline)}`;
}

function profileGroups(memories: TwinSnapshot['memories']): string {
    const people = new Map<string, TwinSnapshot['memories']>();
    const projects = new Map<string, TwinSnapshot['memories']>();
    for (const memory of memories) {
        const key = memory.data.subjectId;
        people.set(key, [...people.get(key) ?? [], memory]);
        if (memory.data.project) projects.set(memory.data.project, [...projects.get(memory.data.project) ?? [], memory]);
    }
    const card = (title: string, action: string, id: string, entries: TwinSnapshot['memories']) => `<details class="twin__card"><summary>${escapeHTML(title)} (${entries.length})</summary>
        ${entries.map(entry => `<p>${escapeHTML(entry.data.content)}</p>`).join('')}${button(action, 'forgetScope', id)}</details>`;
    return `<h3>${escapeHTML(label('people'))}</h3>${[...people.values()].map(entries => card(entries[0].data.subject, 'forgetSubject', entries[0].data.subjectId, entries)).join('')}
        <h3>${escapeHTML(label('projects'))}</h3>${[...projects].map(([name, entries]) => card(name, 'forgetProject', name, entries)).join('')}`;
}

function timeline(memories: TwinSnapshot['memories']): string {
    const events = memories.filter(memory => memory.data.state === 'active' && memory.data.eventTime
        && ['event', 'decision', 'goal', 'commitment', 'experience'].includes(memory.data.kind));
    return `<details><summary>${escapeHTML(label('timeline'))}</summary><p>${escapeHTML(label('timelineHelp'))}</p><ol>
        ${events.sort((a, b) => a.data.recordedAt - b.data.recordedAt).map(event => `<li><time>${escapeHTML(event.data.eventTime)}</time> · ${escapeHTML(event.data.subject)} · ${escapeHTML(event.data.project)} · ${escapeHTML(event.data.content)}</li>`).join('')}</ol></details>`;
}

function executionForm(memory: TwinDataRecord<TwinMemoryData>): string {
    return `<details><summary>${escapeHTML(label('executionRefs'))}</summary><p>${escapeHTML(label('executionHelp'))}</p>
        ${memory.data.executionRefs.map(ref => `<p>${escapeHTML(ref.sessionId)} / ${escapeHTML(ref.taskId)}</p>`).join('')}
        <form class="twin__form" data-form="execution" data-id="${escapeAttr(memory.id)}">${input('executionSessionId', 'executionSessionId')}${input('executionTaskId', 'executionTaskId')}${submit('linkExecution')}</form></details>`;
}
