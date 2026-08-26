'use strict';

// Empties the marker database in Redis (marker:* hashes + the z:markers:all
// sorted set), without touching message history, finisher counters, push
// subscriptions, or anything else.
//
//   node reset-markers.js --yes

const redis = require('redis');

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
    console.error('This deletes all marker data (marker:* and z:markers:all) from Redis.');
    console.error('It does NOT touch message history, finisher counters, or anything else.');
    console.error('Re-run with --yes to confirm, e.g.: node reset-markers.js --yes');
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
        const res = await client.scan(cursor, { MATCH: 'marker:*', COUNT: 500 });
        cursor = res.cursor;
        if (res.keys.length > 0) {
            await client.del(res.keys);
            deleted += res.keys.length;
        }
    } while (cursor !== '0');

    const removedIndex = await client.del('z:markers:all');
    deleted += removedIndex;

    console.log(`Deleted ${deleted} marker key(s) from Redis (marker:* + z:markers:all). Everything else was left untouched.`);
    await client.quit();
}

main().catch(err => {
    console.error('Failed to reset markers:', err);
    process.exit(1);
});
