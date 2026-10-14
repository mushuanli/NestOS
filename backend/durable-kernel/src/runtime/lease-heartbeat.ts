export interface LeaseHeartbeatOptions {
    intervalMs: number;
    renew(): Promise<boolean>;
    onError(error: unknown): void;
}

export class LeaseHeartbeat {
    private timer?: ReturnType<typeof setInterval>;
    private renewing = false;

    constructor(private readonly options: LeaseHeartbeatOptions) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
        unrefTimer(this.timer);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private async tick(): Promise<void> {
        if (this.renewing) return;
        this.renewing = true;
        try {
            if (!(await this.options.renew())) this.stop();
        } catch (error) {
            this.options.onError(error);
        } finally {
            this.renewing = false;
        }
    }
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
    (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}
