'use strict';

// Resets the live finisher-counter data in Redis (dedup set + all counter
// keys under cnt:finish:*) back to 0, without touching anything else --
// message history (z:messages:*), marker history (z:markers:*), etc. are left
// completely alone.
//
// Run this once, right before a new race, after you've copied the outgoing
// all-time totals into finisher-counters-config.json's baseOffsets so the
// "ever" numbers keep being correct across the reset.
//
//   node reset-finisher-counters.js --yes

const redis = require('redis');

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
    console.error('This deletes all finisher counter data (cnt:finish:*) from Redis.');
    console.error('It does NOT touch message/marker history or anything else.');
    console.error('Re-run with --yes to confirm, e.g.: node reset-finisher-counters.js --yes');
    process.exit(1);
}

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

async function main() {
    const client = redis.createClient({ url: `redis://${redisHost}:${redisPort}` });
    await client.connect();

    let cursor = '0';
    let deleted = 0;
    do {
        const res = await client.scan(cursor, { MATCH: 'cnt:finish:*', COUNT: 500 });
        cursor = res.cursor;
        if (res.keys.length > 0) {
            await client.del(res.keys);
            deleted += res.keys.length;
        }
    } while (cursor !== '0');

    console.log(`Deleted ${deleted} finisher-counter key(s) from Redis (cnt:finish:*). Message/marker history was left untouched.`);
    await client.quit();
}

main().catch(err => {
    console.error('Failed to reset finisher counters:', err);
    process.exit(1);
});
