import { escapeHTML, escapeAttr, t } from '@itookit/common';
import { TWIN_KINDS, type TwinMemoryData } from '@itookit/app-contracts';
import type { DigitalTwinService, TwinDataRecord } from '@itookit/app-contracts/services';
import { scanListFilters, scanListPagination } from './scan-list';

export type TwinSnapshot = Awaited<ReturnType<DigitalTwinService['snapshot']>>;
export type TwinPage = 'overview' | 'profile' | 'memories' | 'goals' | 'sources' | 'runs';
export const TWIN_PAGES: TwinPage[] = ['overview', 'profile', 'memories', 'goals', 'sources', 'runs'];
export const label = (key: string) => t(`twin.${key}` as Parameters<typeof t>[0]);
export const button = (action: string, title: string, id = '') => `<button type="button" data-action="${escapeAttr(action)}" data-id="${escapeAttr(id)}">${escapeHTML(label(title))}</button>`;
const input = (name: string, title: string, value = '', type = 'text') => `<label>${escapeHTML(label(title))}<input name="${name}" type="${type}" value="${escapeAttr(value)}"></label>`;
export const select = (name: string, options: Array<{ id: string; name: string }>, selected = '') => `<select name="${name}" aria-label="${escapeAttr(label(name))}">${options.map(option => `<option value="${escapeAttr(option.id)}"${option.id === selected ? ' selected' : ''}>${escapeHTML(option.name)}</option>`).join('')}</select>`;
const checkbox = (name: string, title: string, checked = false) => `<label><input type="checkbox" name="${name}"${checked ? ' checked' : ''}>${escapeHTML(label(title))}</label>`;
const submit = (title: string) => `<button type="submit">${escapeHTML(label(title))}</button>`;

export function overview(snapshot: TwinSnapshot): string {
    const active = snapshot.memories.filter(memory => memory.data.state === 'active' && memory.supported);
    const pending = snapshot.memories.filter(memory => memory.data.state === 'candidate' && memory.supported);
    const recent = [...active].sort((a, b) => b.data.recordedAt - a.data.recordedAt).slice(0, 8);
    return `<p>${escapeHTML(label('overviewHelp'))}</p>
        <p>${escapeHTML(label('counts'))}: ${active.length} / ${pending.length}</p>
        ${snapshot.cleanupError || snapshot.pendingCleanup.length ? `<p class="twin__error">${escapeHTML(label('cleanupPending'))}${button('refresh', 'refresh')}</p>` : ''}
        ${button('openProfile', 'profile')}${button('openUpdates', 'sources')}
        <h3>${escapeHTML(label('recentKnowledge'))}</h3>${recent.map(memory => `<article class="twin__card"><p>${escapeHTML(memory.data.content)}</p><small>${escapeHTML(memory.data.subject)} · ${escapeHTML(memory.data.project)}</small></article>`).join('') || `<p>${escapeHTML(label('empty'))}</p>`}
        <p>${escapeHTML(label('defaultKnowledgeUse'))}</p>`;
}

export function updateSettings(snapshot: TwinSnapshot, connections: Array<{ id: string; name: string }>): string {
    const { settings } = snapshot;
    return `<section class="twin__settings" aria-label="${escapeAttr(label('updateSettings'))}">
        <header class="twin__section-header"><div><h3>${escapeHTML(label('updateSettings'))}</h3><p>${escapeHTML(label('autosaveHelp'))}</p></div>
        <span class="twin__save-status" data-save-status role="status" aria-live="polite">${escapeHTML(label('autosave.idle'))}</span></header>
        <form class="twin__form twin__settings-form" data-form="settings">
        <div class="twin__settings-grid"><section class="twin__settings-group"><h4>${escapeHTML(label('modelUsage'))}</h4>
        <label>${escapeHTML(label('connectionId'))}${select('connectionId', [{ id: '', name: label('connectionRequired') }, ...connections], settings.data.connectionId)}</label>
        <p class="twin__help">${escapeHTML(label('modelAutoSaveHelp'))}</p>${budgetSettings(settings.data)}</section>
        <section class="twin__settings-group"><h4>${escapeHTML(label('personalInfo'))}</h4>
        ${input('userName', 'userName', settings.data.userName ?? '')}
        <label>${escapeHTML(label('userAliases'))}<textarea name="userAliases" rows="2">${escapeHTML((settings.data.userAliases ?? []).join('\n'))}</textarea></label>
        <p class="twin__help">${escapeHTML(label('identityHelp'))}</p></section>
        <section class="twin__settings-group twin__settings-group--wide"><h4>${escapeHTML(label('analysisControls'))}</h4>
        <div class="twin__settings-grid"><div class="twin__toggles">${checkbox('paused', 'paused', settings.data.paused)}${checkbox('useEnabled', 'useEnabled', settings.data.useEnabled)}</div>
        <div><label>${escapeHTML(label('globalExclude'))}<textarea name="globalExclude" rows="3" placeholder="**/*.log">${escapeHTML((settings.data.globalExclude ?? []).join('\n'))}</textarea></label>
        <p class="twin__help">${escapeHTML(label('globalExcludeHelp'))}</p></div></div></section></div>
        <details class="twin__advanced"><summary>${escapeHTML(label('extractionPrompt'))}</summary><pre class="twin__preview">${escapeHTML(snapshot.prompt ?? '')}</pre></details>
        <div class="twin__save-feedback"><p class="twin__error" data-save-error role="alert"></p><button type="button" data-action="retrySettings" hidden>${escapeHTML(label('retrySave'))}</button></div>
        </form></section>`;
}

function budgetSettings(settings: TwinSnapshot['settings']['data']): string {
    return `<div class="twin__usage"><div><span>${escapeHTML(label('spentTokens'))}</span><strong data-spent-tokens>${settings.spentTokens.toLocaleString()}</strong></div>
        <div><span>${escapeHTML(label('reservedTokens'))}</span><strong data-reserved-tokens>${settings.reservedTokens.toLocaleString()}</strong></div></div>
        <div class="twin__budget">${checkbox('budgetUnlimited', 'budgetUnlimited', settings.budgetUnlimited === true)}
        <label data-budget-limit${settings.budgetUnlimited ? ' hidden' : ''}>${escapeHTML(label('tokenLimit'))}<input name="tokenLimit" type="number" min="0" step="1" value="${settings.tokenLimit}"${settings.budgetUnlimited ? ' disabled' : ''}></label>
        <p class="twin__help">${escapeHTML(label('budgetLimitHelp'))}</p>
        <details><summary>${escapeHTML(label('usageAccounting'))}</summary><p class="twin__help">${escapeHTML(label('unknownBudget'))}</p></details></div>`;
}

export function sources(snapshot: TwinSnapshot, _connections: Array<{ id: string; name: string }>): string {
    return `<section data-scan-list="sources">${scanListFilters('sources')}
        ${snapshot.sources.map(source => `<article class="twin__card" data-scan-row="${escapeAttr(source.id)}" data-scan-text="${escapeAttr([source.data.label, source.data.target, source.data.resource?.projectName, source.data.resource?.projectId].join(' ').toLocaleLowerCase())}" data-scan-enabled="${source.data.enabled}" data-scan-kind="${source.data.kind}" data-scan-state="${source.data.status}"><h3>${escapeHTML(source.data.label || source.data.target)}</h3>
        <p>${escapeHTML(source.data.resource?.projectName ?? source.data.resource?.projectId ?? '')} · ${escapeHTML(source.data.target)} · ${escapeHTML(label(source.data.enabled ? 'enabled' : 'disabled'))} · ${escapeHTML(label(`source.${source.data.status}`))}</p>
        <p>${source.data.offset} / ${source.data.characters} · ${escapeHTML(label('checkedAt'))}: ${escapeHTML(new Date(source.observedAt).toLocaleString())}</p></article>`).join('') || `<p>${escapeHTML(label('targetsEmpty'))}</p>`}${scanListPagination()}</section>`;
}

export function memories(snapshot: TwinSnapshot, page: 'memories' | 'goals'): string {
    const visible = snapshot.memories.filter(memory => page !== 'goals' || ['goal', 'commitment'].includes(memory.data.kind));
    const sorted = [...visible].sort((a, b) => b.data.recordedAt - a.data.recordedAt);
    return `<p>${escapeHTML(label(page === 'goals' ? 'goalHelp' : 'memoryHelp'))}</p>
        <details><summary>${escapeHTML(label('addMemory'))}</summary><form class="twin__form" data-form="memory">${memoryFields(undefined, page === 'goals' ? 'goal' : 'fact')}${submit('addMemory')}</form></details>
        <input class="twin__search" data-search placeholder="${escapeAttr(label('search'))}" aria-label="${escapeAttr(label('search'))}">
        ${page === 'memories' ? `<details><summary>${escapeHTML(label('forgetScope'))}</summary>${profileGroups(snapshot.memories)}</details>` : ''}
        ${page === 'memories' ? timeline(snapshot.memories) : ''}
        <div class="twin__cards">${sorted.map(memory => memoryCard(memory)).join('') || `<p>${escapeHTML(label('empty'))}</p>`}</div>`;
}
function memoryCard(memory: TwinSnapshot['memories'][number]): string {
    const data = memory.data;
    return `<article class="twin__card" data-memory="${escapeAttr(memory.id)}" data-search-text="${escapeAttr(`${data.content} ${data.subject} ${data.project} ${data.kind} ${data.state}`.toLowerCase())}">
        <h3>${escapeHTML(label(`kind.${data.kind}`))} · ${escapeHTML(label(`state.${data.state}`))}${memory.supported ? '' : ` · ${escapeHTML(label('unsupported'))}`}</h3>
        <p>${escapeHTML(data.content)}</p><p>${escapeHTML(data.subject)} · ${escapeHTML(data.project)} · ${escapeHTML(data.eventTime)}</p>
        ${memory.retained ? `<p>${escapeHTML(label('retainedKnowledge'))}</p>` : ''}
        ${['goal', 'commitment'].includes(data.kind) ? `<p>${escapeHTML(label(`goal.${data.goalStatus}`))} · ${escapeHTML(data.successCondition)} · ${escapeHTML(data.deadline)}</p>` : ''}
        <details><summary>${escapeHTML(label('evidence'))}</summary><blockquote>${escapeHTML(data.quote || label('userStatement'))}</blockquote><p>${escapeHTML(data.sourceId)} · ${escapeHTML(data.sourceHash)} · ${escapeHTML(memory.revision)}</p></details>
        ${data.state === 'candidate' && memory.supported ? button('confirm', 'confirm', memory.id) : ''}${button('reject', 'reject', memory.id)}${button('dispute', 'dispute', memory.id)}
        <details><summary>${escapeHTML(label('correct'))}</summary><p>${escapeHTML(label('correctHelp'))}</p><form class="twin__form" data-form="correct" data-id="${escapeAttr(memory.id)}">${memoryFields(memory)}${submit('correct')}</form></details>
        ${['goal', 'commitment'].includes(data.kind) && data.state === 'active' ? executionForm(memory) : ''}
        ${button('forget', 'forget', memory.id)}${button('suppress', 'suppress', memory.id)}</article>`;
}
export function memoryFields(memory?: TwinDataRecord<TwinMemoryData>, defaultKind = 'fact'): string {
    const data = memory?.data;
    return `<label>${escapeHTML(label('content'))}<textarea name="content" required maxlength="4000">${escapeHTML(data?.content ?? '')}</textarea></label>
        ${select('kind', TWIN_KINDS.map(kind => ({ id: kind, name: label(`kind.${kind}`) })), data?.kind ?? defaultKind)}
        ${input('subject', 'subject', data?.subject ?? 'self')}${input('project', 'project', data?.project)}${input('eventTime', 'eventTime', data?.eventTime)}
        ${select('goalStatus', ['draft', 'active', 'paused', 'completed', 'cancelled'].map(status => ({ id: status, name: label(`goal.${status}`) })), data?.goalStatus ?? 'draft')}
        ${input('successCondition', 'successCondition', data?.successCondition)}${input('deadline', 'deadline', data?.deadline)}
        <details><summary>${escapeHTML(label('kind.relationship'))}</summary>
        ${input('relationPredicate', 'relationPredicate', data?.relation?.predicate)}${input('relationTarget', 'relationTarget', data?.relation?.target)}
        ${select('relationTargetKind', ['person', 'organization', 'project'].map(kind => ({ id: kind, name: label(`entity.${kind}`) })), data?.relation?.targetKind ?? 'person')}</details>`;
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
