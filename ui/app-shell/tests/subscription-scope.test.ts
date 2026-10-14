import { expect, it, vi } from 'vitest';
import { SubscriptionScope } from '../src/lifecycle/subscription-scope';

it('releases all subscriptions once even if one throws', () => {
    const scope = new SubscriptionScope();
    const first = vi.fn(), last = vi.fn();
    scope.add(first, () => { throw new Error('cleanup'); }, last);
    expect(() => scope.dispose()).toThrow(AggregateError);
    scope.dispose();
    expect(first).toHaveBeenCalledOnce(); expect(last).toHaveBeenCalledOnce();
    const late = vi.fn(); scope.add(late); expect(late).toHaveBeenCalledOnce();
});
