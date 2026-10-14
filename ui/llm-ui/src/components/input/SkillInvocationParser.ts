// @file: llm-ui/components/input/SkillInvocationParser.ts
//
// Parses skill invocation syntax:
//   /skillname [--key value]* [[name](path)]* [@file|@*.glob]* [free text]
//
// Examples:
//   /review [auth.ts](./auth.ts) --focus security check error handling
//   /translate --lang ja Hello world
//   /lint @src/*.ts
//   /explain [utils.ts](./utils.ts) what does this do?

export type { SkillInvocation };

import type { SkillInvocation } from '../../domain/types';

// Matches Markdown-link file refs: [name](./path) or [name](path)
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
// Matches @glob patterns: @*.ts  @src/*.ts
const GLOB_RE = /(?:^|\s)@([\w./\\*?[\]{}!-]+\*[\w./\\*?[\]{}!-]*)/g;
// Matches direct @file refs (no wildcards): @auth.ts  @src/utils.ts
const FILE_REF_RE = /(?:^|\s)@([\w./\\-]+\.[\w]+)/g;
// Matches --key value pairs
const ARG_RE = /--(\w[\w-]*)(?:\s+([^-\s][^\s]*))?/g;

/**
 * Parse the `args` string (everything after `/skillname`) into a SkillInvocation.
 */
export function parseSkillArgs(
    skillId: string,
    argsStr: string,
    selectionText?: string,
): SkillInvocation {
    let rest = argsStr;
    const filePaths: string[] = [];
    const globPatterns: string[] = [];
    const args: Record<string, string> = {};

    // 1. Extract markdown links [name](path)
    rest = rest.replace(MD_LINK_RE, (_match, _name, path) => {
        filePaths.push(path);
        return ' ';
    });

    // 2. Extract @*.glob patterns (before @file so globs are matched first)
    const globMatches = [...rest.matchAll(GLOB_RE)];
    for (const m of globMatches) {
        globPatterns.push(m[1]);
    }
    rest = rest.replace(GLOB_RE, ' ');

    // 3. Extract @file direct references
    const fileMatches = [...rest.matchAll(FILE_REF_RE)];
    for (const m of fileMatches) {
        filePaths.push(m[1]);
    }
    rest = rest.replace(FILE_REF_RE, ' ');

    // 4. Extract --key value pairs
    const argMatches = [...rest.matchAll(ARG_RE)];
    for (const m of argMatches) {
        args[m[1]] = m[2] ?? 'true';
    }
    rest = rest.replace(ARG_RE, ' ');

    // 5. Remaining text (clean up extra spaces)
    const text = rest.trim().replace(/\s{2,}/g, ' ');

    return { skillId, args, filePaths, globPatterns, text, selectionText };
}

/**
 * Extract required placeholder names from a shell command template.
 *
 * E.g. `git log --oneline -{{n}} -- {{path}}` → ['n', 'path']
 */
export function getShellTemplateParams(command: string): string[] {
    const matches = [...command.matchAll(/\{\{(\w+)\}\}/g)];
    return [...new Set(matches.map(m => m[1]))];
}

/**
 * Return param names that are required but not provided in the invocation args.
 */
export function getMissingParams(required: string[], provided: Record<string, string>): string[] {
    return required.filter(p => !(p in provided));
}

/**
 * Build a wizard refill string for the textarea when required params are missing.
 * User sees: /skillname --missingA ___ --missingB ___ [existing] [files]
 */
export function buildWizardRefill(invocation: SkillInvocation, missing: string[]): string {
    const parts = [`/${invocation.skillId}`];
    for (const param of missing) {
        parts.push(`--${param} ___`);
    }
    for (const [k, v] of Object.entries(invocation.args)) {
        parts.push(`--${k} ${v}`);
    }
    for (const f of invocation.filePaths) {
        parts.push(`[${f.split('/').pop() ?? f}](${f})`);
    }
    if (invocation.text) parts.push(invocation.text);
    return parts.join(' ');
}

/**
 * Build the user message for an L1 action skill invocation.
 *
 * Action skills (disableModelInvocation=true) are invoked directly — their instructions
 * are injected into the user message without going through the LLM load_skill mechanism.
 * This bypasses the model and executes the skill's instructions as a user directive.
 */
export function buildActionSkillMessage(
    invocation: SkillInvocation,
    skillInstructions: string,
): string {
    const parts: string[] = [`[Action: ${invocation.skillId}]`, '', skillInstructions];

    if (invocation.filePaths.length > 0) {
        parts.push('', invocation.filePaths.length === 1 ? 'File:' : 'Files:');
        for (const fp of invocation.filePaths) {
            const name = fp.split('/').pop() ?? fp;
            parts.push(`[${name}](${fp})`);
        }
    }

    if (invocation.text) {
        parts.push('', `Task: ${invocation.text}`);
    }

    return parts.join('\n').trim();
}

/**
 * Build the prompt string sent to the agent for a skill invocation.
 *
 * File paths are kept as Markdown links so AttachmentProcessor can resolve them.
 */
export function buildSkillPrompt(
    invocation: SkillInvocation,
    skillName: string,
    skillType?: string,
): string {
    const lines: string[] = [];

    // Header
    lines.push(`[Skill: ${skillName}]`);

    // Named args (for http/mcp/shell context)
    const argEntries = Object.entries(invocation.args);
    if (argEntries.length > 0) {
        lines.push('');
        lines.push('Parameters:');
        for (const [k, v] of argEntries) {
            lines.push(`  --${k}: ${v}`);
        }
    }

    // Files
    if (invocation.filePaths.length > 0) {
        lines.push('');
        lines.push(invocation.filePaths.length === 1 ? 'File:' : 'Files:');
        for (const fp of invocation.filePaths) {
            const name = fp.split('/').pop() ?? fp;
            lines.push(`[${name}](${fp})`);
        }
    }

    // Glob patterns (will be expanded by the shell layer)
    if (invocation.globPatterns.length > 0) {
        lines.push('');
        lines.push('File patterns: ' + invocation.globPatterns.join(', '));
    }

    // Selected text context
    if (invocation.selectionText) {
        lines.push('');
        lines.push('Selected context:');
        lines.push('```');
        lines.push(invocation.selectionText);
        lines.push('```');
    }

    // Task / free text
    const hasContext = invocation.filePaths.length > 0 ||
        invocation.globPatterns.length > 0 ||
        invocation.selectionText;

    if (invocation.text) {
        lines.push('');
        if (hasContext) {
            lines.push(`Task: ${invocation.text}`);
        } else if (skillType === 'prompt') {
            // For prompt-type skills, wrap the user text as an explicit task directive so
            // the LLM executes the skill's instructions (e.g. calls human_input, shell_session)
            // rather than just acknowledging the skill content.
            lines.push(`Task: ${invocation.text}`);
            lines.push('');
            lines.push('Please follow this skill\'s instructions and invoke the appropriate tools immediately to handle the task above.');
        } else {
            lines.push(invocation.text);
        }
    } else if (!hasContext) {
        if (skillType === 'prompt') {
            // Standalone invocation with no task text — tell LLM to apply the skill right now.
            // This ensures skills like ask-human immediately invoke their tools (e.g. human_input)
            // instead of describing their purpose.
            lines.push('');
            lines.push('This skill has been activated. Please follow its instructions and invoke the appropriate tools immediately.');
            lines.push('If the skill requires human input, call the human_input tool now with mission_id="default" and todo_id="task-1".');
        } else {
            lines.push('');
            lines.push('Please execute this skill on the current context.');
        }
    }

    return lines.join('\n').trim();
}
