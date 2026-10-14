export interface OcrSettingsState {
    value: { connectionId?: string };
    connections: Array<{ id: string; label: string; disabled?: boolean }>;
}

/** Host-owned image recognition and configuration, shared across chat editors. */
export interface OcrControls {
    readSettings(): Promise<OcrSettingsState>;
    saveSettings(value: OcrSettingsState['value']): Promise<void>;
    openSettings(target: 'models' | 'prompt'): Promise<void>;
    recognize(image: Blob, signal?: AbortSignal): Promise<string>;
    configure(): Promise<boolean>;
    label(): Promise<string>;
    subscribe(listener: () => void): () => void;
}
