/** A live server process belongs to one authenticated browser view. */
export interface ServerTerminal {
    readonly id: string;
    readOutput(cursor: number): Promise<{output: string; cursor: number; truncated: boolean; exited: boolean; exitCode: number | null}>;
    sendInput(data: string): Promise<void>;
    resizeTerminal(cols: number, rows: number): Promise<void>;
    dispose(): Promise<void>;
}

export interface ServerTerminals {
    openTerminal(): Promise<ServerTerminal>;
}
