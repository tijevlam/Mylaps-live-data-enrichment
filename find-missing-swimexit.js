'use strict';

// Finds chip codes (+ bib + name) of athletes who have a CheckIn passing and
// a SwimStart passing, but no SwimFinRunStart (swim exit / T1) passing yet --
// useful for spotting swim-course problems (missed mat, chip failure, DNF)
// while the race is live.
//
//   node find-missing-swimexit.js
//   node find-missing-swimexit.js --raceType="middle distance"
//   node find-missing-swimexit.js --checkin=CheckIn --swimstart=SwimStart --swimexit=SwimFinRunStart
//
// Reads from the same Redis the server writes to (REDIS_HOST / REDIS_PORT
// env vars, same defaults as server.js). Read-only -- does not change
// anything in Redis.

const redis = require('redis');

function arg(flagName, def) {
    const i = process.argv.indexOf(flagName);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const kv = process.argv.find(a => a.startsWith(flagName + '='));
    return kv ? kv.split('=').slice(1).join('=') : def;
}

const CHECKIN_SOURCE = arg('--checkin', 'CheckIn');
const SWIMSTART_SOURCE = arg('--swimstart', 'SwimStart');
const SWIMEXIT_SOURCE = arg('--swimexit', 'SwimFinRunStart');
const RACE_TYPE = arg('--raceType', 'long distance');

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

// Returns Map<chip, messageId> for the most recent passing per chip at this
// source, optionally filtered to raceType === filterRaceType.
async function chipsAtSource(client, sourceName, filterRaceType) {
    const zkey = `z:messages:source:${sourceName}`;
    const messageIds = await client.zRange(zkey, 0, -1);
    const chips = new Map();

    for (const messageId of messageIds) {
        const [chip, raceType] = await Promise.all([
            client.hGet(messageId, 'c'),
            filterRaceType ? client.hGet(messageId, 'raceType') : Promise.resolve(null),
        ]);
        if (!chip) continue;
        if (filterRaceType && raceType !== filterRaceType) continue;
        chips.set(chip, messageId);
    }

    return chips;
}

async function main() {
    const client = redis.createClient({ url: `redis://${redisHost}:${redisPort}` });
    await client.connect();

    const [checkinChips, swimstartChips, swimexitChips] = await Promise.all([
        chipsAtSource(client, CHECKIN_SOURCE, RACE_TYPE),
        chipsAtSource(client, SWIMSTART_SOURCE, RACE_TYPE),
        chipsAtSource(client, SWIMEXIT_SOURCE, null),
    ]);

    const missing = [];
    for (const [chip, messageId] of checkinChips) {
        if (!swimstartChips.has(chip)) continue;
        if (swimexitChips.has(chip)) continue;

        const [bib, name] = await Promise.all([
            client.hGet(messageId, 'bib'),
            client.hGet(messageId, 'Name'),
        ]);
        missing.push({ chip, bib: bib || '', name: name || '' });
    }

    await client.quit();

    console.log(`raceType=${JSON.stringify(RACE_TYPE)}  checkin=${CHECKIN_SOURCE}  swimstart=${SWIMSTART_SOURCE}  swimexit=${SWIMEXIT_SOURCE}`);
    console.log(`${missing.length} athlete(s) with check-in + swim start but no swim exit:\n`);
    for (const { chip, bib, name } of missing) {
        console.log(`${chip}\t${bib}\t${name}`);
    }
}

main().catch(err => {
    console.error('Failed to look up missing swim exits:', err);
    process.exit(1);
});
