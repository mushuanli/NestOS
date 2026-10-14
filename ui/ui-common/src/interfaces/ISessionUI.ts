/**
 * @file ui-common/interfaces/ISessionUI.ts
 * @description Defines the public interface that a session management module must implement.
 */

interface IRegularMenuItem<TItem extends object = Record<string, unknown>> {
    id: string;
    label: string;
    iconHTML?: string;
    disabled?: boolean;
    type?: 'item'; // 'type' 是可辨识的属性
    hidden?: (item: TItem) => boolean;
    /** Custom click handler. When provided, bypasses the command-bus dispatch. */
    onClick?: (item: TItem) => void | Promise<void>;
}

// 定义一个分割线
interface ISeparatorMenuItem {
    type: 'separator';
}

// MenuItem 现在是一个可辨识联合类型
export type MenuItem<TItem extends object = Record<string, unknown>> =
    | IRegularMenuItem<TItem>
    | ISeparatorMenuItem;

export type ContextMenuBuilder<TItem extends object = Record<string, unknown>> = (
    item: TItem,
    defaultItems: MenuItem<TItem>[],
) => MenuItem<TItem>[];

export interface ContextMenuConfig<TItem extends object = Record<string, unknown>> {
    items?: ContextMenuBuilder<TItem>;
    bulkItems?: (items: TItem[], defaults: MenuItem<TItem>[]) => MenuItem<TItem>[];
}

export interface TagEditorOptions {
    container: HTMLElement;
    initialTags: string[];
    onSave: (tags: string[]) => void;
    onCancel: () => void;
}

export interface TagEditorInstance {
    destroy?(): void;
}

export type TagEditorFactory = (
    options: TagEditorOptions,
) => TagEditorInstance | void;

/**
 * Options controlling new-file creation behaviour.
 * Grouped to keep ResourceListOptions focused on list-level concerns.
 */
export interface FileCreationConfig {
    /** Map a selected virtual container to a valid creation parent (also for directories). */
    resolveParent?: (parentPath: string | null) => string | null;
    /** Label on the "+ New" button (e.g. "Chat", "Agent"). Default: "File". */
    label?: string;
    /** Title pre-filled in the new-file inline input. */
    title?: string;
    /** Body content template for newly created files. */
    content?: string;
    /** Auto-create this file on startup when the module has zero items. */
    startupFileName?: string;
    /** Content for the auto-created startup file. */
    startupContent?: string;
    /**
     * Skip the inline name-prompt and create the file instantly with {@link title}.
     * Focus goes directly to the editor; rename via titlebar if needed.
     * @default false
     */
    instant?: boolean;
}

export interface ResourceListOptions<TItem extends object = Record<string, unknown>> {
    sessionListContainer: HTMLElement;
    documentOutlineContainer?: HTMLElement;
    initialState?: object;
    contextMenu?: ContextMenuConfig<TItem>;
    readOnly?: boolean;
    initialSidebarCollapsed?: boolean;
    title?: string;
    searchPlaceholder?: string;

    /** New-file creation defaults. When omitted, the "+" button still works but without pre-fill or startup file. */
    fileCreation?: FileCreationConfig;

    /**
     * 自定义组件工厂
     * TagEditor 的构造函数引用
     */
    components?: {
        tagEditor?: TagEditorFactory;
    };
}

/** Compatibility name for existing session hosts; the contract is resource-neutral. */
export type SessionUIOptions<TItem extends object = Record<string, unknown>> = ResourceListOptions<TItem>;

export interface SessionUIEventMap<TSession extends object> {
    sessionSelected: { item: TSession | undefined };
    fileRenamed: { oldId: string; newId: string; item: TSession };
    navigateToHeading: { elementId: string };
    importRequested: { parentPath: string | null };
    sidebarStateChanged: { isCollapsed: boolean };
    menuItemClicked: { actionId: string; item: TSession };
    stateChanged: { state: unknown };
}

export type SessionManagerEvent = keyof SessionUIEventMap<object>;
export type SessionManagerCallback<TPayload = unknown> = (payload: TPayload) => void;

/**
 * Session UI 主接口
 * @template TSession 会话对象类型 (如 VFSNodeUI)
 * @template TService 服务层类型 (如 VFSService)
 */
export abstract class ISessionUI<
    TSession extends object,
    TService extends object,
    TEvents extends object = SessionUIEventMap<TSession>,
> {
    protected constructor() {
        if (this.constructor === ISessionUI) {
            throw new Error("ISessionUI is an interface and cannot be instantiated directly.");
        }
    }

    abstract readonly sessionService: TService;

    abstract start(): Promise<TSession | undefined>;
    abstract getActiveSession(): TSession | undefined;
    abstract updateSessionContent(sessionId: string, newContent: string): Promise<void>;
    abstract toggleSidebar(): void;
    abstract setTitle(newTitle: string): void;
    
    abstract on<E extends keyof TEvents & string>(
        eventName: E,
        callback: SessionManagerCallback<TEvents[E]>,
    ): () => void;
    abstract destroy(): void;
}
