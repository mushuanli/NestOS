type Release=()=>Promise<void>;
/** Owns subscriptions only; callers supply paths, transports and wakeup policy. */
export class DirectorySubscriptions {
    private stopped=false;
    private readonly entries=new Map<string,Promise<Release>>();
    async ensure(key:string,open:()=>Promise<Release>):Promise<void> {
        if(this.stopped)return;
        let entry=this.entries.get(key);
        if(!entry){entry=open();this.entries.set(key,entry);}
        try{await entry;}catch(error){if(this.entries.get(key)===entry)this.entries.delete(key);throw error;}
        if(this.stopped&&this.entries.get(key)===entry)await this.close(key);
    }
    async close(key:string):Promise<void> {
        const entry=this.entries.get(key);this.entries.delete(key);
        if(entry)await (await entry)();
    }
    async dispose():Promise<void> {
        this.stopped=true;
        await Promise.allSettled([...this.entries.keys()].map(key=>this.close(key)));
    }
}
