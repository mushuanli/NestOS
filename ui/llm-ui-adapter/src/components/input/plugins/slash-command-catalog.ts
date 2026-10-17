import { SLASH_ICONS, t, type LocaleKey } from '@itookit/common';
import type { InputPluginContext } from './InputPlugin';
import type { SlashCommandCallbacks, SlashCommandDef } from './SlashCommandPlugin';
import { parseToolArgs } from './slash-tool-args';
/** Command descriptions are separate from popup state and command execution routing. */
export function createSlashCommandCatalog(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef[] {
    return [
        ...chatSlashCommands(cb),
        ...refineSlashCommands(cb),
        ...contextSlashCommands(cb),
        ...viewSlashCommands(cb),
        ...exportSlashCommands(cb),
        ...branchSlashCommands(cb),
        ...agentSlashCommands(cb),
        ...helpSlashCommands(cb),
        ...skillsSlashCommands(cb, hint),
        ...toolsPanelSlashCommands(cb, hint),
        ...filesSlashCommands(cb),
        ...kernelSlashCommands(cb),
        ...toolsSlashCommands(cb),
    ];
}
function flowCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return { name: 'flow', label: '/flow', description: t('flow.invoke.description'), icon: SLASH_ICONS.new,
        group: 'chat' as const, hasArgs: true, argsPlaceholder: '[id] [JSON]', preserveInput: true,
        execute: async (args: string, context: InputPluginContext) => {
            const submitted = context.getText();
            if (await cb.onFlow!(args) && context.getText() === submitted)
                context.setText('');
        } };
}
function newCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'new',
        label: '/new',
        description: t('slash.new.description'),
        icon: SLASH_ICONS.new,
        group: 'chat',
        // hasArgs 移除（默认 false）— 面板选中时直接执行，使用默认标题
        // 用户仍可手动输入 `/new my-title` 按 Enter 来指定标题
        execute: (args) => cb.onNew(args),
    };
}
function retryCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'retry',
        label: '/retry',
        description: t('slash.retry.description'),
        icon: SLASH_ICONS.retry,
        group: 'chat',
        execute: () => cb.onRetry(),
    };
}
function continueCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'continue',
        label: '/continue',
        description: t('slash.continue.description'),
        icon: SLASH_ICONS.continue,
        group: 'chat',
        execute: () => cb.onContinue(),
    };
}
function reeditCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'reedit',
        label: '/reedit',
        description: t('slash.reedit.description'),
        icon: SLASH_ICONS.reedit,
        group: 'chat',
        preserveInput: true,
        execute: () => cb.onReedit(),
    };
}
function deleteCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'delete',
        label: '/delete',
        aliases: ['message-delete'],
        description: t('slash.delete.description'),
        icon: SLASH_ICONS.delete,
        group: 'chat',
        execute: () => cb.onDeleteLast(),
    };
}
function clearCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'clear',
        label: '/clear',
        description: t('slash.clear.description'),
        icon: SLASH_ICONS.clear,
        group: 'chat',
        execute: () => cb.onClear(),
    };
}
function btwCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'btw',
        label: '/btw',
        description: t('slash.btw.description'),
        icon: SLASH_ICONS.btw,
        group: 'chat',
        hasArgs: true,
        argsPlaceholder: 'message...',
        execute: (args) => cb.onBtw(args),
    };
}
function shorterCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'shorter',
        label: '/shorter',
        description: t('slash.shorter.description'),
        icon: SLASH_ICONS.shorter,
        group: 'refine',
        execute: () => cb.onShorter(),
    };
}
function longerCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'longer',
        label: '/longer',
        description: t('slash.longer.description'),
        icon: SLASH_ICONS.longer,
        group: 'refine',
        execute: () => cb.onLonger(),
    };
}
function simplifyCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'simplify',
        label: '/simplify',
        description: t('slash.simplify.description'),
        icon: SLASH_ICONS.simplify,
        group: 'refine',
        execute: () => cb.onSimplify(),
    };
}
function summarizeCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'summarize',
        label: '/summarize',
        description: t('slash.summarize.description'),
        icon: SLASH_ICONS.summarize,
        group: 'refine',
        execute: () => cb.onSummarize(),
    };
}
function historyCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'history',
        label: '/history',
        aliases: ['context-length'],
        description: t('slash.history.description'),
        icon: SLASH_ICONS.history,
        group: 'context',
        hasArgs: true,
        argsPlaceholder: '<number>',
        execute: (args) => cb.onHistory(args),
    };
}
function freshCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'fresh',
        label: '/fresh',
        aliases: ['context-reset'],
        description: t('slash.fresh.description'),
        icon: SLASH_ICONS.fresh,
        group: 'context',
        execute: () => cb.onFresh(),
    };
}
function foldCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'fold',
        label: '/fold',
        description: t('slash.fold.description'),
        icon: SLASH_ICONS.fold,
        group: 'view',
        execute: () => cb.onFoldCurrent(),
    };
}
function foldAllCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'fold-all',
        label: '/fold-all',
        aliases: ['foldall'],
        description: t('slash.fold-all.description'),
        icon: SLASH_ICONS.foldAll,
        group: 'view',
        execute: () => cb.onFoldAll(),
    };
}
function unfoldAllCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'unfold-all',
        label: '/unfold-all',
        aliases: ['unfoldall'],
        description: t('slash.unfold-all.description'),
        icon: SLASH_ICONS.unfoldAll,
        group: 'view',
        execute: () => cb.onUnfoldAll(),
    };
}
function topCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'top',
        label: '/top',
        description: t('slash.top.description'),
        icon: SLASH_ICONS.top,
        group: 'view',
        execute: () => cb.onTop(),
    };
}
function bottomCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'bottom',
        label: '/bottom',
        description: t('slash.bottom.description'),
        icon: SLASH_ICONS.bottom,
        group: 'view',
        execute: () => cb.onBottom(),
    };
}
function navCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'nav',
        label: '/nav',
        description: t('slash.nav.description'),
        icon: SLASH_ICONS.nav,
        group: 'view',
        execute: () => cb.onNav(),
    };
}
function copyCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'copy',
        label: '/copy',
        description: t('slash.copy.description'),
        icon: SLASH_ICONS.copy,
        group: 'export',
        execute: () => cb.onCopyAll(),
    };
}
function exportCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'export',
        label: '/export',
        aliases: ['export-chat'],
        description: t('slash.export.description'),
        icon: SLASH_ICONS.export,
        group: 'export',
        execute: () => cb.onExport(),
    };
}
function printCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'print',
        label: '/print',
        description: t('slash.print.description'),
        icon: SLASH_ICONS.print,
        group: 'export',
        execute: () => cb.onPrint(),
    };
}
function branchCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branch',
        label: '/branch',
        description: t('slash.branch.description'),
        icon: SLASH_ICONS.branch,
        group: 'branch',
        execute: () => cb.onCreateBranch(),
    };
}
function switchCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'switch',
        label: '/switch',
        aliases: ['branch-switch'],
        description: t('slash.switch.description'),
        icon: SLASH_ICONS.branchSwitch,
        group: 'branch',
        hasArgs: true,
        argsPlaceholder: '<branch-name>',
        execute: (args) => { if (args)
            cb.onSwitchBranch(args); },
    };
}
function branchPrevCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branch-prev',
        label: '/branch-prev',
        aliases: ['branchprev'],
        description: t('slash.branch-prev.description'),
        icon: SLASH_ICONS.branchPrev,
        group: 'branch',
        execute: () => cb.onBranchPrev(),
    };
}
function branchNextCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branch-next',
        label: '/branch-next',
        aliases: ['branchnext'],
        description: t('slash.branch-next.description'),
        icon: SLASH_ICONS.branchNext,
        group: 'branch',
        execute: () => cb.onBranchNext(),
    };
}
function branchesCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branches',
        label: '/branches',
        aliases: ['branch-list'],
        description: t('slash.branches.description'),
        icon: SLASH_ICONS.branchList,
        group: 'branch',
        execute: () => cb.onListBranches(),
    };
}
function branchRenameCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branch-rename',
        label: '/branch-rename',
        aliases: ['renamebranch'],
        description: t('slash.branch-rename.description'),
        icon: SLASH_ICONS.branchRename,
        group: 'branch',
        hasArgs: true,
        argsPlaceholder: '<old-name> <new-name>',
        execute: (args) => cb.onRenameBranch(args),
    };
}
function branchDeleteCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'branch-delete',
        label: '/branch-delete',
        aliases: ['deletebranch'],
        description: t('slash.branch-delete.description'),
        icon: SLASH_ICONS.branchDelete,
        group: 'branch',
        hasArgs: true,
        argsPlaceholder: '<branch-name>',
        execute: (args) => { if (args)
            cb.onDeleteBranch(args); },
    };
}
function agentCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'agent',
        label: '/agent',
        description: t('slash.agent.description'),
        icon: SLASH_ICONS.agent,
        group: 'agent',
        hasArgs: true,
        argsPlaceholder: '<agent-id>',
        execute: (args) => { if (args)
            cb.onSwitchAgent(args); },
    };
}
function connectionCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'connection', label: '/connection', description: t('connection.command'),
        icon: SLASH_ICONS.model, group: 'agent', hasArgs: true, argsPlaceholder: '<id> | --reset',
        execute: args => cb.onConnection?.(args),
    };
}
function modelCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'model',
        label: '/model',
        description: t('slash.model.description'),
        icon: SLASH_ICONS.model,
        group: 'agent',
        hasArgs: true,
        argsPlaceholder: '<model-id>',
        execute: (args) => { if (args)
            cb.onModel(args); },
    };
}
function helpCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'help',
        label: '/help',
        description: t('slash.help.description'),
        icon: SLASH_ICONS.help,
        group: 'help',
        execute: () => cb.onHelp(),
    };
}
function skillCommand(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef {
    return {
        name: 'skill',
        label: '/skill',
        description: cb.onSkill
            ? t('slash.skill.description')
            : `${t('slash.skill.description')}${t('slash.hint.enableAgentMode')}`,
        icon: SLASH_ICONS.skill,
        group: 'skills',
        hasArgs: true,
        argsPlaceholder: '<skill-id>',
        execute: async (args?: string) => {
            if (!cb.onSkill) {
                hint('skill');
                return;
            }
            const id = args?.trim();
            if (id)
                await cb.onSkill(id);
        },
    };
}
function skillsCommand(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef {
    return {
        name: 'skills',
        label: '/skills',
        description: cb.onSkills
            ? t('slash.skills.description')
            : `${t('slash.skills.description')}${t('slash.hint.enableAgentMode')}`,
        icon: SLASH_ICONS.skills,
        group: 'skills',
        execute: () => {
            if (!cb.onSkills) {
                hint('skills');
                return;
            }
            cb.onSkills();
        },
    };
}
function toolsCommand(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef {
    return {
        name: 'tools',
        label: '/tools',
        description: cb.onTools
            ? t('slash.tools.description')
            : `${t('slash.tools.description')}${t('slash.hint.enableAgentMode')}`,
        icon: SLASH_ICONS.tools,
        group: 'agent',
        execute: () => {
            if (!cb.onTools) {
                hint('tools');
                return;
            }
            cb.onTools();
        },
    };
}
function addDirCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return directoryCommand('add-dir', 'slash.add-dir.description', SLASH_ICONS.addDir, cb.onAddDirectory, '<dir> [r|w]');
}
function setHomeCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return directoryCommand('set-home', 'slash.set-home.description', SLASH_ICONS.setHome, cb.onSetHome, '<dir>');
}
function planCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return privilegedCommand('plan', 'slash.plan.description', SLASH_ICONS.plan, cb.onPlan, '<goal>');
}
function cancelCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return privilegedCommand('cancel', 'slash.cancel.description', SLASH_ICONS.cancel, cb.onCancelTask);
}
function resumeCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return privilegedCommand('resume', 'slash.resume.description', SLASH_ICONS.resume, cb.onResumeTask);
}
function approveCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return privilegedCommand('approve', 'slash.approve.description', SLASH_ICONS.approve, cb.onApproveTask);
}
function execCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return privilegedCommand('exec', 'slash.exec.description', SLASH_ICONS.exec, cb.onExec, '<command>');
}
function readCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'read',
        label: '/read',
        description: t('slash.read.description'),
        icon: SLASH_ICONS.read,
        group: 'tools',
        hasArgs: true,
        argsPlaceholder: '<path> [--offset N] [--limit N]',
        execute: async (args?: string) => {
            const { positionals, flags } = parseToolArgs(args ?? '');
            const path = positionals.join(' ');
            if (!path)
                return;
            // Only include non-positional flags in toolArgs to avoid duplication.
            const toolArgs: Record<string, unknown> = { path,
        ...flags };
            await cb.onToolInvoke!('file_read', toolArgs, `/read ${args ?? ''}`);
        },
    };
}
function grepCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'grep',
        label: '/grep',
        description: t('slash.grep.description'),
        icon: SLASH_ICONS.grep,
        group: 'tools',
        hasArgs: true,
        argsPlaceholder: '"<pattern>" [--glob *.ts] [--dir ./src]',
        execute: async (args?: string) => {
            const { positionals, flags } = parseToolArgs(args ?? '');
            const pattern = positionals[0];
            if (!pattern)
                return;
            const toolArgs: Record<string, unknown> = { pattern };
            if (flags['glob'])
                toolArgs['glob'] = flags['glob'];
            if (flags['dir'])
                toolArgs['base_dir'] = flags['dir'];
            if (flags['i'])
                toolArgs['case_insensitive'] = true;
            if (flags['n'])
                toolArgs['context_lines'] = Number(flags['n']) || 0;
            await cb.onToolInvoke!('grep_search', toolArgs, `/grep ${args ?? ''}`);
        },
    };
}
function globCommand(cb: SlashCommandCallbacks): SlashCommandDef {
    return {
        name: 'glob',
        label: '/glob',
        description: t('slash.glob.description'),
        icon: SLASH_ICONS.glob,
        group: 'tools',
        hasArgs: true,
        argsPlaceholder: '"**/*.ts" [--dir ./src] [--limit 50]',
        execute: async (args?: string) => {
            const { positionals, flags } = parseToolArgs(args ?? '');
            const pattern = positionals[0];
            if (!pattern)
                return;
            const toolArgs: Record<string, unknown> = { pattern };
            if (flags['dir'])
                toolArgs['base_dir'] = flags['dir'];
            if (flags['limit'])
                toolArgs['limit'] = Number(flags['limit']) || 100;
            await cb.onToolInvoke!('glob_search', toolArgs, `/glob ${args ?? ''}`);
        },
    };
}
function chatSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        ...(cb.onFlow ? [flowCommand(cb)] : []),
        newCommand(cb),
        retryCommand(cb),
        continueCommand(cb),
        reeditCommand(cb),
        deleteCommand(cb),
        clearCommand(cb),
        btwCommand(cb)
    ];
}
function refineSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        shorterCommand(cb),
        longerCommand(cb),
        simplifyCommand(cb),
        summarizeCommand(cb)
    ];
}
function contextSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        historyCommand(cb),
        freshCommand(cb)
    ];
}
function viewSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        foldCommand(cb),
        foldAllCommand(cb),
        unfoldAllCommand(cb),
        topCommand(cb),
        bottomCommand(cb),
        navCommand(cb)
    ];
}
function exportSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        copyCommand(cb),
        exportCommand(cb),
        printCommand(cb)
    ];
}
function branchSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        branchCommand(cb),
        switchCommand(cb),
        branchPrevCommand(cb),
        branchNextCommand(cb),
        branchesCommand(cb),
        branchRenameCommand(cb),
        branchDeleteCommand(cb)
    ];
}
function agentSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        agentCommand(cb),
        connectionCommand(cb),
        modelCommand(cb)
    ];
}
function helpSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        helpCommand(cb)
    ];
}
function skillsSlashCommands(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef[] {
    return [
        skillCommand(cb, hint),
        skillsCommand(cb, hint)
    ];
}
function toolsPanelSlashCommands(cb: SlashCommandCallbacks, hint: (name: string) => void): SlashCommandDef[] {
    return [
        toolsCommand(cb, hint)
    ];
}
function filesSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        addDirCommand(cb),
        setHomeCommand(cb)
    ];
}
function kernelSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        planCommand(cb),
        cancelCommand(cb),
        resumeCommand(cb),
        approveCommand(cb),
        execCommand(cb)
    ];
}
function toolsSlashCommands(cb: SlashCommandCallbacks): SlashCommandDef[] {
    return [
        ...(cb.onToolInvoke ? [readCommand(cb), grepCommand(cb), globCommand(cb)] as SlashCommandDef[] : [])
    ];
}
function privilegedCommand(name: string, descriptionKey: LocaleKey, icon: string, execute: ((args: string) => Promise<void>) | (() => Promise<void>) | undefined, placeholder?: string): SlashCommandDef {
    return {
        name,
        label: `/${name}`,
        description: execute ? t(descriptionKey) : `${t(descriptionKey)}${t('slash.hint.kernelUnavailable')}`,
        icon,
        group: 'task',
        hasArgs: Boolean(placeholder),
        argsPlaceholder: placeholder,
        execute: async (args) => {
            if (!execute)
                throw new Error(t('slash.error.kernelRequired', { name }));
            if (placeholder?.startsWith('<') && !args.trim()) {
                throw new Error(t('slash.usage', { name, placeholder }));
            }
            await execute(args.trim());
        },
    };
}
function directoryCommand(name: string, descriptionKey: LocaleKey, icon: string, execute: ((args: string) => Promise<void>) | undefined, placeholder: string): SlashCommandDef {
    return { name, label: `/${name}`, description: t(descriptionKey), icon, group: 'files', hasArgs: true, argsPlaceholder: placeholder,
        execute: async (args) => { if (!execute)
            throw new Error(t('slash.error.directoryUnavailable')); await execute(args.trim()); } };
}
