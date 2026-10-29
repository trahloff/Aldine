/**
 * RateLimiter.take with a cost, on the in-memory bucket: a batch is taken
 * whole or not at all, so a refused batch leaves the bucket as it was.
 */
import { eq } from './assert.mjs';

delete process.env.REDIS_URL;
const { RateLimiter } = await import('../src/ratelimit.ts');

const T0 = 1_800_000_000_000;
const l = new RateLimiter('cost-test', 10, 10 / 3600);
eq(await l.take('u', T0, 8), true, 'a batch within the bucket is taken');
eq(await l.take('u', T0, 3), false, 'a batch larger than what is left is refused');
eq(await l.take('u', T0, 2), true, 'and takes nothing: the two left are still there');
eq(await l.take('u', T0), false, 'until they are spent');
eq(await l.take('u', T0 + 359_000), false, 'none comes back before a tenth of the hour');
eq(await l.take('u', T0 + 360_000), true, 'one comes back every tenth of the hour');
eq(await l.take('other', T0, 10), true, 'each key has a bucket of its own');
eq(await l.take('fresh', T0, 11), false, 'a batch larger than the whole bucket is never taken');
eq(await l.take('fresh', T0, 10), true, 'and leaves the bucket full');

console.log('ratelimit-cost: all assertions passed');
process.exit(0);
