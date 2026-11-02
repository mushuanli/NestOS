import {expect,it,vi} from 'vitest';
import {DirectorySubscriptions} from '../src/run/directory-subscriptions';
it('shares one subscription and releases it once',async()=>{
    const subscriptions=new DirectorySubscriptions(),release=vi.fn(async()=>{}),open=vi.fn(async()=>release);
    await Promise.all([subscriptions.ensure('scope',open),subscriptions.ensure('scope',open)]);
    expect(open).toHaveBeenCalledTimes(1);await subscriptions.close('scope');await subscriptions.dispose();
    expect(release).toHaveBeenCalledTimes(1);await subscriptions.ensure('later',open);expect(open).toHaveBeenCalledTimes(1);
});
it('releases an opening subscription during disposal and allows retry after an opening failure',async()=>{
    const subscriptions=new DirectorySubscriptions(),release=vi.fn(async()=>{});
    await expect(subscriptions.ensure('scope',async()=>{throw new Error('offline');})).rejects.toThrow('offline');
    let ready!:(release:()=>Promise<void>)=>void;
    const opening=subscriptions.ensure('scope',()=>new Promise(resolve=>{ready=resolve;}));
    const disposing=subscriptions.dispose();ready(release);await Promise.all([opening,disposing]);
    expect(release).toHaveBeenCalledTimes(1);
});
