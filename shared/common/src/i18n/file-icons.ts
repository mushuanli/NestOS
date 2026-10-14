const svg = (body: string, kind: string) => `<svg data-file-icon="${kind}" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const page = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>';
export const FILE_ICONS = {
    folder: svg('<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', 'folder'),
    file: svg(page, 'file'),
    document: svg(page + '<path d="M8 13h8M8 17h6"/>', 'document'),
    code: svg(page + '<path d="m9 12-3 3 3 3m6-6 3 3-3 3"/>', 'code'),
    config: svg(page + '<path d="M8 13h8M8 18h8M10 11v4m4 1v4"/>', 'config'),
    image: svg(page + '<circle cx="9" cy="12" r="1"/><path d="m6 19 4-4 3 2 3-4 3 6"/>', 'image'),
    media: svg(page + '<path d="m10 12 6 4-6 4Z"/>', 'media'),
    archive: svg(page + '<path d="M10 3v3m0 3v3m0 3v3"/>', 'archive'),
    pdf: svg(page + '<path d="M8 17v-5h2a1.5 1.5 0 0 1 0 3H8m6-3v5m0-5h2m-2 3h2"/>', 'pdf'),
    spreadsheet: svg(page + '<path d="M7 11h10v9H7zM7 14h10M7 17h10M11 11v9"/>', 'spreadsheet'),
    slides: svg(page + '<path d="M7 11h10v7H7zM12 18v3m-3 0h6"/>', 'slides'),
    audio: svg(page + '<path d="M14 11v7m0-7 3 1"/><ellipse cx="11.5" cy="18" rx="2.5" ry="2"/>', 'audio'),
    database: svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>', 'database'),
    pin: svg('<path d="m15 3 6 6-4 1-3 5-2-2-6 6m6-6-3-3 5-3Z"/>', 'pin'),
} as const;

/** Filename-only classification: never reads file contents or metadata. */
export function fileTypeIcon(name: string, directory = false): string {
    if (directory) return FILE_ICONS.folder;
    const filename = name.split('/').pop()?.toLowerCase() ?? '';
    if (/^(dockerfile(?:\..+)?|makefile|gnumakefile)$/.test(filename)) return FILE_ICONS.code;
    if (/^(\.env(?:\..+)?|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.yarnrc|tsconfig(?:\..+)?\.json)$/.test(filename)) return FILE_ICONS.config;
    if (/^(readme|license|licence|changelog|authors|notice)$/.test(filename)) return FILE_ICONS.document;
    const extension = filename.includes('.') ? filename.split('.').pop() ?? '' : '';
    if (extension === 'pdf') return FILE_ICONS.pdf;
    if (/^(csv|tsv|xls|xlsx|ods|numbers)$/.test(extension)) return FILE_ICONS.spreadsheet;
    if (/^(ppt|pptx|odp|key)$/.test(extension)) return FILE_ICONS.slides;
    if (/^(db|sqlite|sqlite3)$/.test(extension)) return FILE_ICONS.database;
    if (/^(md|mdx|markdown|txt|rst|doc|docx|odt|rtf)$/.test(extension)) return FILE_ICONS.document;
    if (/^(json|yaml|yml|toml|ini|conf|lock)$/.test(extension)) return FILE_ICONS.config;
    if (/^(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|cc|h|hpp|sh|bash|zsh|fish|html|css|scss|less|sql|vue|svelte|rb|php|swift|kt|kts|cs|lua)$/.test(extension)) return FILE_ICONS.code;
    if (/^(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|heic)$/.test(extension)) return FILE_ICONS.image;
    if (/^(mp3|wav|ogg|flac|aac|m4a|opus)$/.test(extension)) return FILE_ICONS.audio;
    if (/^(mp4|webm|mov|mkv|avi|m4v)$/.test(extension)) return FILE_ICONS.media;
    if (/^(zip|gz|tar|7z|rar|bz2|xz|zst|tgz)$/.test(extension)) return FILE_ICONS.archive;
    return FILE_ICONS.file;
}

/** Small navigation controls share the file browser's line weight and dimensions. */
export const FILE_BROWSER_ICONS = {
    newSession: svg('<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6"/><path d="M19 2v8m-4-4h8M7 10h5m-5 4h8"/>', 'new-session'),
    root: svg('<path d="M3 7h18v13H3zM3 7V4h6l3 3M8 12h8m-8 4h5"/>', 'navigation'),
    up: svg('<path d="m6 10 6-6 6 6M12 4v16"/>', 'navigation'),
    browse: svg('<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', 'navigation'),
    refresh: svg('<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6"/>', 'navigation'),
    addFile: svg(page + '<path d="M12 11v8m-4-4h8"/>', 'add-file'),
    addFolder: svg('<path d="M3 7V5h7l2 3h9v12H3zM12 11v6m-3-3h6"/>', 'add-folder'),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', 'more'),
    close: svg('<path d="m6 6 12 12M6 18 18 6"/>', 'close'),
    chevron: svg('<path d="m8 10 4 4 4-4"/>', 'chevron'),
    maximize: svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>', 'maximize'),
    restore: svg('<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M17 17v4H3V7h4"/>', 'restore'),
    move: svg('<path d="M3 7V5h7l2 3h9v12H3M3 14h11m-4-4 4 4-4 4"/>', 'move'),
    delete: svg('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>', 'delete'),
    keep: svg('<path d="m5 12 4 4L19 6"/>', 'keep'),
    columns: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 4v16m7-16v16"/>', 'columns'),
} as const;
