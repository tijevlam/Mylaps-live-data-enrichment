const net = require('net');
// const sqlite3 = require('sqlite3').verbose(); // For SQLite
const redis = require('redis');
const { v4: uuidv4 } = require('uuid'); // Voor unieke IDs
const fs = require('fs');
const { join } = require('node:path');
const express = require('express');
const https = require('https');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const cors = require('cors'); // NEW: enable cross-site access for Socket.IO + Express
const webpush = require('web-push'); // Web Push notifications for special finishes

// ---------------- CLI args ----------------
// e.g. `node server.js --year=2026`, or with pm2: `pm2 start server.js -- --year=2026`
function arg(flagName, def) {
    const i = process.argv.indexOf(flagName);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const kv = process.argv.find(a => a.startsWith(flagName + '='));
    return kv ? kv.split('=').slice(1).join('=') : def;
}

// Which race year to run as: picks the bib enrichment file to load
// (bibs<year>_enhanced.json). --year=<year> wins, then YEAR=<year> in the
// environment, then the current calendar year. BIBS_FILE overrides the
// filename entirely if it doesn't follow the bibs<year>_enhanced.json
// convention.
const RACE_YEAR = arg('--year', process.env.YEAR || String(new Date().getFullYear()));
const BIBS_FILE = process.env.BIBS_FILE || `bibs${RACE_YEAR}_enhanced.json`;
// -------------------------------------------

const app = express();
const server = createServer(app);

// ---------------- CORS / Cross-site configuration ----------------
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map(o => o.trim()).filter(Boolean)
    : [];

const defaultAllowedOrigins = [
    'https://history.hollandtriathlon.nl',
    'https://challengealmere.s3.eu-west-1.amazonaws.com',
    '*'
];

// If you want to allow any origin for testing, you can set ALLOWED_ORIGINS=*
const finalAllowedOrigins = allowedOrigins.length ? allowedOrigins : defaultAllowedOrigins;

// Express-level CORS (mainly for static + any future REST endpoints)
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // Allow non-browser or same-origin
        if (finalAllowedOrigins.includes('*') || finalAllowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS: ' + origin));
    },
    methods: ['GET', 'POST'],
    credentials: false
}));

// Socket.IO with explicit CORS
const io = new Server(server, {
    cors: {
        origin: finalAllowedOrigins.includes('*') ? '*' : finalAllowedOrigins,
        methods: ['GET', 'POST'],
        credentials: false
    },
    transports: ['polling', 'websocket'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// -----------------------------------------------------------------

const {Logging} = require('@google-cloud/logging');

const projectId = process.env.PROJECT_ID;
const logName = 'mylaps-live-data-stream';
const loggingEnabled = Boolean(projectId);

// When no PROJECT_ID is set, log.entry()/log.write() below become cheap
// no-ops instead of constructing a log entry object and attempting (and
// failing) a GCP Logging API call for every single incoming TCP message --
// avoids real, measurable overhead on a hot path when GCP Logging isn't
// actually configured (the common case outside App Engine deployments).
const log = loggingEnabled
    ? new Logging({ projectId }).log(logName)
    : { entry: () => null, write: () => Promise.resolve() };

const metadata = {
    resource: {type: 'global'},
    // See: https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity
    severity: 'INFO',
};

// Redis Configuration
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;
const redisClient = redis.createClient({
    url: `redis://${redisHost}:${redisPort}`
});


// SQLite3 Database Configuration (replace with your actual path)
/* const db = new sqlite3.Database('mylaps_data.db'); // Use /tmp for App Engine

// Create the table if it doesn't exist
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sourceName TEXT,
    function TEXT,
    messageNumber TEXT,
    c TEXT,
    d TEXT,
    l NUMBER,
    b TEXT,
    n TEXT,
    t TEXT,
    Bib TEXT,
    Name TEXT,
    Info TEXT,
    Cat TEXT,
    Wave TEXT,
    CatEK TEXT,
    startTime TEXT,
    Serie TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sourceName TEXT,
    function TEXT,
    messageNumber TEXT,
    markerTime TEXT,
    markerType TEXT,
    markerName TEXT
  )
`);
*/

const TCP_PORT = 3389; //3097; // Use the PORT environment variable for App Engine

/*
 // read bibs csv file and store in memory with import of CSV
/*
const Papa = require("papaparse");
async function parseCsv(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(fs.createReadStream(file), {
            header: true,
            skipEmptyLines: true,
            delimiter: ';',
            // transform: value => {
            //     return value.trim()
            // },
            complete: results => {
                return resolve(results.data)
            },
            error: error => {
                return reject(error)
            }
        })
    })
}
*/

function matchChipToBib(bibs, bibsByNumber, passingData) {
    const bib = bibs[passingData.c];
    if (bib) return bib;
    if (passingData.b && passingData.b > -1) {
        return bibsByNumber[passingData.b] || null;
    }
    return null;
}

function bufferToString(buffer) {
    return buffer.toString(); // Assuming UTF-8 encoding
}

function handleAckPing(socket, message) {
    // Extract the version and parameters from the parsed message
    const version = message.data.version;
    const parameters = message.data.parameters;

    // Construct the AckPong message (Version 2)
    const ackPongMessage = `T&S@AckPong@${version || 'Version2.1'}@${parameters && parameters.length > 0 ? parameters.join('|') : ''}$`;

    // Send the AckPong message
    socket.write(ackPongMessage);

    console.log('Sent AckPong message:', ackPongMessage);
}

function parseMessage(bibs, bibsByNumber, rawMessage, socket) {
    const parts = rawMessage.split('@');
    if (parts.length < 3) {
        return { error: 'Invalid message format' };
    }

    const sourceName = parts[0].trim();
    const function_ = parts[1].trim();
    const data = ['Store','Passing','Marker'].includes(function_) ? parts.slice(2, -2).join('@') : parts.slice(2, -1).join('@'); // Join in case data contains '@'
    const messageNumber = ['Store','Passing', 'Marker'].includes(function_) ? parts[parts.length - 2] : undefined;

    if (function_ === "Pong"){
        socket.write('Tije@AckPong@Version2.1@$');
        let pongLog = log.entry(metadata, 'ackpong written');
        log.write(pongLog);
    } else if (function_.indexOf('Ack') === -1){
        socket.write(`Tije@Ack${function_}${['Store','Passing', 'Marker'].includes(function_) ? '@'+messageNumber:''}@$`);
    }

    let parsedData;
    switch (function_) {
        case 'Store':
            parsedData = parseStoreMessage(data);
            break;
        case 'Passing':
            parsedData = parsePassingMessage(bibs, bibsByNumber, data);
            break;
        case 'Marker':
            parsedData = parseMarkerMessage(data);
            break;
        case 'GetInfo':
        case 'AckGetInfo':
            parsedData = parseGetInfoMessage(data);
            break;
        case 'Pong':
            parsedData = parsePongMessage(data);
            break;
        case 'AckPong':
        default:
            parsedData = { rawData: data };
    }

    let parsedDataLog = log.entry(metadata, parsedData);
    log.write(parsedDataLog);

    return {
        sourceName: sourceName,
        function: function_,
        data: parsedData,
        messageNumber: messageNumber,
    };
}

function parseStoreMessage(data) {
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const [transponder, time, count, status] = record.split(' ');
        return { transponder, time, count: parseInt(count), status };
    });
}

function parsePassingMessage(bibs, bibsByNumber, data) {
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const pairs = record.split('|');
        const passingData = {};
        pairs.forEach(pair => {
            const [key, value] = pair.split('=');
            if(['c','d','l','b','n','t'].includes(key)) {
                passingData[key] = value;
            }

        });
        if(passingData.c) {
            const bib = matchChipToBib(bibs, bibsByNumber, passingData);
            if (bib) {
                Object.assign(passingData, bib);
            }
        }

        // If no name found, try to match based on bib number (b)
        // if(!passingData.Name && passingData.b && passingData.b > -1){
        //     console.log("looking for athlete based on bib:", passingData.b);
        //     const chipbib = matchChipBibToBib(bibs, passingData.b)
        //     if (chipbib) {
        //         Object.assign(passingData, chipbib);
        //     }
        // }

        return passingData;
    });
}

function parseMarkerMessage(data) {
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const pairs = record.split('|');
        const markerData = {};
        pairs.forEach(pair => {
            const [key, value] = pair.split('=');
            markerData[key] = value;
        });
        return markerData;
    });
}

function parseGetInfoMessage(data) {
    const parts = data.split('@');
    if (parts.length < 2) {
        return { error: 'Invalid GetInfo message format' };
    }
    const deviceName = parts[0];
    const status = parts[1];
    const computerName = parts[2] || null;
    return { deviceName, status, computerName };
}

function parsePongMessage(data) {
    const parts = data.split('@');
    const version = parts[0] || null; // Extract version (e.g., 'Version2.1')
    const parameters = parts[1] ? parts[1].split('|') : []; // Extract parameters

    if (version && version.startsWith('Version2')) {
        return {
            version: version,
            parameters: parameters,
        };
    } else {
        return {
            version: null,
            parameters: [],
        };
    }
}

// Store messages in the SQLite3 database
/*
function storeMessage(parsedMessage) {
    for(const d of parsedMessage.data) {
        db.run(`
        INSERT INTO messages (sourceName, function, messageNumber, c, d, l, b, n, t, Bib, Name, Info, Cat, Wave, CatEK, StartTime, Serie)
        VALUES (?, ?, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?)
      `, [parsedMessage.sourceName, parsedMessage.function, parsedMessage.messageNumber, d.c, d.d, d.l, d.b, d.n, d.t, d.bib, d.Name, '',d.Cat, d.Wave, d.CatEK, d.startTime, d.Serie])
    }
}

function storeMarker(parsedMessage) {
    for(const d of parsedMessage.data) {
        db.run(`
        INSERT INTO markers (sourceName, function, messageNumber, markerTime, markerType, markerName)
        VALUES (?, ?, ?, ?,?, ?)
      `, [parsedMessage.sourceName, parsedMessage.function, parsedMessage.messageNumber, d.t, d.mt, d.n])
    }
}
*/


// Store messages in Redis
async function storeMessageInRedis(parsedMessage) {
    if (!parsedMessage.data || !Array.isArray(parsedMessage.data)) return;

    const receivedTimestamp = Date.now();
    const multi = redisClient.multi();

    for (const item of parsedMessage.data) {
        const messageId = `message:${uuidv4()}`;
        const messagePayload = {
            ...item,
            sourceName: parsedMessage.sourceName,
            function: parsedMessage.function,
            originalMessageNumber: parsedMessage.messageNumber || '',
            receivedTimestamp: receivedTimestamp.toString()
        };

        for (const key in messagePayload) {
            if (messagePayload[key] == null) {
                delete messagePayload[key];
            }
        }

        multi.hSet(messageId, messagePayload);
        multi.zAdd(`z:messages:source:${parsedMessage.sourceName}`, { score: receivedTimestamp, value: messageId });
        multi.zAdd(`z:messages:everywhere`, { score: receivedTimestamp, value: messageId });
        // Optionally trim (commented)
        // multi.zRemRangeByRank(`z:messages:source:${parsedMessage.sourceName}`, 0, -1001);
        // multi.zRemRangeByRank(`z:messages:everywhere`, 0, -5001);
    }

    try {
        await multi.exec();
    } catch (err) {
        console.error('Redis multi exec error (storeMessage):', err);
        let xlog = log.entry(metadata, { severity: 'ERROR', message: `Redis multi exec error (storeMessage): ${err.message}` });
        log.write(xlog);
    }
}

async function storeMarkerInRedis(parsedMessage) {
    if (!parsedMessage.data || !Array.isArray(parsedMessage.data)) return;

    const receivedTimestamp = Date.now();
    const multi = redisClient.multi();

    for (const item of parsedMessage.data) {
        const markerId = `marker:${uuidv4()}`;
        const markerPayload = {
            ...item,
            sourceName: parsedMessage.sourceName,
            function: parsedMessage.function,
            originalMessageNumber: parsedMessage.messageNumber || '',
            receivedTimestamp: receivedTimestamp.toString()
        };

        for (const key in markerPayload) {
            if (markerPayload[key] == null) {
                delete markerPayload[key];
            }
        }

        multi.hSet(markerId, markerPayload);
        multi.zAdd(`z:markers:all`, { score: receivedTimestamp, value: markerId });
        // multi.zRemRangeByRank(`z:markers:all`, 0, -1001);
    }

    try {
        await multi.exec();
    } catch (err) {
        console.error('Redis multi exec error (storeMarker):', err);
        let xlog = log.entry(metadata, { severity: 'ERROR', message: `Redis multi exec error (storeMarker): ${err.message}` });
        log.write(xlog);
    }
}

// ---------------- Finisher counters ----------------
// Reliable, dedicated, dedup'd counters (overall / per distance / per gender / per
// distance+gender) that ride alongside the existing passing-message stream. This
// is purely additive: it does not read, write, or emit anything the existing
// message/marker flow depends on.
//
// Dedup + increment happens atomically in Redis via a small Lua script, so
// concurrent or duplicate "beeps" for the same bib (double reads at the mat,
// retried TCP messages, etc.) only ever get counted once, even under load.
const COUNTER_LUA_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 0 then
  return false
end
local counts = {}
for i = 2, #KEYS do
  counts[i - 1] = redis.call('INCR', KEYS[i])
end
return counts
`;

let counterScriptSha = null;

async function evalCounterScript(keys, args) {
    try {
        return await redisClient.evalSha(counterScriptSha, { keys, arguments: args });
    } catch (err) {
        if (err && /NOSCRIPT/.test(err.message)) {
            counterScriptSha = await redisClient.scriptLoad(COUNTER_LUA_SCRIPT);
            return await redisClient.evalSha(counterScriptSha, { keys, arguments: args });
        }
        throw err;
    }
}

// Historical carry-over + milestone config, e.g. before resetting Redis's live
// counters to 0 for a new race, this file records what the all-time totals
// were so counters can keep reporting correct "ever" numbers, and lists the
// specific all-time totals ("special finishes") that should be flagged when
// reached. See finisher-counters-config.example.json for the schema.
const FINISHER_COUNTERS_CONFIG_PATH = process.env.FINISHER_COUNTERS_CONFIG || 'finisher-counters-config.json';
let finisherCountersConfig = { baseOffsets: {}, specialFinishes: [] };
try {
    finisherCountersConfig = JSON.parse(fs.readFileSync(FINISHER_COUNTERS_CONFIG_PATH, 'utf8'));
} catch (err) {
    console.warn(`No finisher counters config at ${FINISHER_COUNTERS_CONFIG_PATH} (${err.code || err.message}); starting with no base offsets or special finishes.`);
}

// Base offset = the all-time count this dimension/group already had before the
// live Redis counter was last reset to 0. "group" must match the label used in
// snapshotEntries/groupFor below (e.g. a raceType string, a gender string, or
// "raceType|gender" for the combined dimension).
function getBaseOffset(eventName, dimensionName, group) {
    const eventOffsets = finisherCountersConfig.baseOffsets && finisherCountersConfig.baseOffsets[eventName];
    const dimOffsets = eventOffsets && eventOffsets[dimensionName];
    return Number((dimOffsets && dimOffsets[group]) || 0);
}

// Special finishes: milestone all-time totals to flag (e.g. "the 30,000th
// finisher ever"). Matched against dimension + group + exact target count;
// since every finish increments its counters by exactly 1, an exact-match
// check is sufficient (no risk of "jumping past" a target).
function matchSpecialFinishes(eventName, dimensionName, group, allTimeCount) {
    return (finisherCountersConfig.specialFinishes || [])
        .filter(m => m.event ? m.event === eventName : true)
        .filter(m => m.dimension === dimensionName && m.group === group && Number(m.target) === allTimeCount)
        .map(m => ({ dimension: dimensionName, group, target: Number(m.target), label: m.label || null }));
}

// Each dimension owns how it derives its Redis key for a given passing record
// (keyFor), its "group" label for offset/milestone lookups (groupFor), and how
// to enumerate all its keys for a snapshot (snapshotEntries). Add more
// dimensions here (e.g. age category) without touching anything else.
const FINISHER_COUNTER_DIMENSIONS = [
    {
        name: 'overall',
        groupFor: () => '_all',
        keyFor: (eventName) => `cnt:${eventName}:overall`,
        snapshotEntries: (eventName) => [{ label: '_all', key: `cnt:${eventName}:overall` }],
    },
    {
        name: 'distance',
        groupFor: (r) => r.raceType || 'unknown',
        keyFor: (eventName, r) => `cnt:${eventName}:distance:${r.raceType || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) =>
            knownGroups.distances.map(d => ({ label: d, key: `cnt:${eventName}:distance:${d}` })),
    },
    {
        name: 'gender',
        groupFor: (r) => r.gender || 'unknown',
        keyFor: (eventName, r) => `cnt:${eventName}:gender:${r.gender || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) =>
            knownGroups.genders.map(g => ({ label: g, key: `cnt:${eventName}:gender:${g}` })),
    },
    {
        name: 'distanceGender',
        groupFor: (r) => `${r.raceType || 'unknown'}|${r.gender || 'unknown'}`,
        keyFor: (eventName, r) => `cnt:${eventName}:distance-gender:${r.raceType || 'unknown'}|${r.gender || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) => {
            const entries = [];
            for (const d of knownGroups.distances) {
                for (const g of knownGroups.genders) {
                    entries.push({ label: `${d}|${g}`, key: `cnt:${eventName}:distance-gender:${d}|${g}` });
                }
            }
            return entries;
        },
    },
    {
        name: 'country',
        groupFor: (r) => r.Country || 'unknown',
        keyFor: (eventName, r) => `cnt:${eventName}:country:${r.Country || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) =>
            knownGroups.countries.map(c => ({ label: c, key: `cnt:${eventName}:country:${c}` })),
    },
    {
        name: 'countryGender',
        groupFor: (r) => `${r.Country || 'unknown'}|${r.gender || 'unknown'}`,
        keyFor: (eventName, r) => `cnt:${eventName}:country-gender:${r.Country || 'unknown'}|${r.gender || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) => {
            const entries = [];
            for (const c of knownGroups.countries) {
                for (const g of knownGroups.genders) {
                    entries.push({ label: `${c}|${g}`, key: `cnt:${eventName}:country-gender:${c}|${g}` });
                }
            }
            return entries;
        },
    },
    {
        name: 'distanceCountry',
        groupFor: (r) => `${r.raceType || 'unknown'}|${r.Country || 'unknown'}`,
        keyFor: (eventName, r) => `cnt:${eventName}:distance-country:${r.raceType || 'unknown'}|${r.Country || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) => {
            const entries = [];
            for (const d of knownGroups.distances) {
                for (const c of knownGroups.countries) {
                    entries.push({ label: `${d}|${c}`, key: `cnt:${eventName}:distance-country:${d}|${c}` });
                }
            }
            return entries;
        },
    },
    {
        name: 'distanceCountryGender',
        groupFor: (r) => `${r.raceType || 'unknown'}|${r.Country || 'unknown'}|${r.gender || 'unknown'}`,
        keyFor: (eventName, r) => `cnt:${eventName}:distance-country-gender:${r.raceType || 'unknown'}|${r.Country || 'unknown'}|${r.gender || 'unknown'}`,
        snapshotEntries: (eventName, knownGroups) => {
            const entries = [];
            for (const d of knownGroups.distances) {
                for (const c of knownGroups.countries) {
                    for (const g of knownGroups.genders) {
                        entries.push({ label: `${d}|${c}|${g}`, key: `cnt:${eventName}:distance-country-gender:${d}|${c}|${g}` });
                    }
                }
            }
            return entries;
        },
    },
];

// Which timing points count as a "finish" for counter purposes. Configurable so
// other timing points (or future non-finish counters) can be added later
// without changing how counting/dedup/broadcasting works.
const COUNTER_EVENTS = [
    {
        name: 'finish',
        sourceName: process.env.FINISH_SOURCE_NAME || 'TimeFinish',
        dedupeSetKey: 'cnt:finish:seen',
        dimensions: FINISHER_COUNTER_DIMENSIONS,
    },
];

// Known distance/gender/country values come straight from the loaded bib
// data, so the counters and their snapshot automatically adapt to whatever
// race types, genders, and countries exist for the current event, with no
// hardcoded lists. Country comes from the bib data's `Country` field
// (capital C, unlike lowercase `gender`/`raceType`) -- see the "country"
// dimension above.
function computeKnownGroups(bibs) {
    const distances = new Set(['unknown']);
    const genders = new Set(['unknown']);
    const countries = new Set(['unknown']);
    for (const b of Object.values(bibs)) {
        if (b.raceType) distances.add(b.raceType);
        if (b.gender) genders.add(b.gender);
        if (b.Country) countries.add(b.Country);
    }
    return { distances: [...distances], genders: [...genders], countries: [...countries] };
}

// Records a counter-event passing if (and only if) this bib/chip hasn't been
// counted for this event before. Returns { counters, allTime, specialFinishes }
// (live counts, live+baseOffset "ever" counts, and any milestones just hit),
// or null when it's a duplicate (or the record has no usable identity).
async function recordCounterEvent(eventConfig, record) {
    const dedupeId = record.bib ? `bib:${record.bib}` : (record.c ? `chip:${record.c}` : null);
    if (!dedupeId) return null;

    const dimensionKeys = eventConfig.dimensions.map(dim => dim.keyFor(eventConfig.name, record));
    const keys = [eventConfig.dedupeSetKey, ...dimensionKeys];

    const rawResult = await evalCounterScript(keys, [dedupeId]);
    if (!rawResult) return null;

    const counters = {};
    const allTime = {};
    const specialFinishes = [];
    eventConfig.dimensions.forEach((dim, i) => {
        const liveCount = Number(rawResult[i]);
        const group = dim.groupFor(record);
        const allTimeCount = liveCount + getBaseOffset(eventConfig.name, dim.name, group);

        counters[dim.name] = liveCount;
        allTime[dim.name] = allTimeCount;
        specialFinishes.push(...matchSpecialFinishes(eventConfig.name, dim.name, group, allTimeCount));
    });
    return { counters, allTime, specialFinishes };
}

async function getCounterSnapshot(eventConfig, knownGroups) {
    const perDimension = eventConfig.dimensions.map(dim => dim.snapshotEntries(eventConfig.name, knownGroups));
    const allKeys = perDimension.flat().map(e => e.key);
    const values = allKeys.length ? await redisClient.mGet(allKeys) : [];

    const counters = {};
    const allTime = {};
    let idx = 0;
    eventConfig.dimensions.forEach((dim, di) => {
        if (dim.name === 'overall') {
            const live = Number(values[idx] || 0);
            counters.overall = live;
            allTime.overall = live + getBaseOffset(eventConfig.name, dim.name, '_all');
            idx += 1;
            return;
        }
        const bucket = {};
        const allTimeBucket = {};
        for (const entry of perDimension[di]) {
            const live = Number(values[idx] || 0);
            bucket[entry.label] = live;
            allTimeBucket[entry.label] = live + getBaseOffset(eventConfig.name, dim.name, entry.label);
            idx += 1;
        }
        counters[dim.name] = bucket;
        allTime[dim.name] = allTimeBucket;
    });
    return { counters, allTime };
}

async function getAllCounterSnapshots(knownGroups) {
    const snapshots = {};
    for (const eventConfig of COUNTER_EVENTS) {
        snapshots[eventConfig.name] = await getCounterSnapshot(eventConfig, knownGroups);
    }
    return snapshots;
}
// -----------------------------------------------------------------

// ---------------- Push notifications (special finishes) ----------------
// Lets an installed PWA (incl. iOS Safari 16.4+, added to the home screen)
// receive a system notification for a special finish even when the app is
// backgrounded or the phone is locked. Entirely optional: with no VAPID keys
// configured this whole block is a no-op and nothing else is affected.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const pushNotificationsEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushNotificationsEnabled) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - special finish push notifications are disabled.');
}

const PUSH_SUBSCRIPTIONS_KEY = 'push:subscriptions'; // Redis hash: endpoint -> JSON subscription

async function savePushSubscription(subscription) {
    await redisClient.hSet(PUSH_SUBSCRIPTIONS_KEY, subscription.endpoint, JSON.stringify(subscription));
}

async function removePushSubscription(endpoint) {
    await redisClient.hDel(PUSH_SUBSCRIPTIONS_KEY, endpoint);
}

// Sends one push message per subscribed device. Fire-and-forget from the
// caller's perspective (never awaited on the hot passing-processing path) so
// a slow or unreachable push endpoint can never delay live timing data.
// Expired/invalid subscriptions (410/404) are pruned as they're discovered.
async function sendSpecialFinishPushNotifications(specialFinishPayload) {
    if (!pushNotificationsEnabled) return;

    let subscriptionsByEndpoint;
    try {
        subscriptionsByEndpoint = await redisClient.hGetAll(PUSH_SUBSCRIPTIONS_KEY);
    } catch (err) {
        console.error('Error reading push subscriptions from Redis:', err);
        return;
    }

    const milestoneText = specialFinishPayload.specialFinishes
        .map(m => m.label || `milestone ${m.target}`)
        .join(', ');
    const notificationBody = JSON.stringify({
        title: 'Special finish!',
        body: `${specialFinishPayload.name || specialFinishPayload.bib || 'Someone'} is ${milestoneText}`,
        data: specialFinishPayload,
    });

    await Promise.allSettled(Object.entries(subscriptionsByEndpoint).map(async ([endpoint, subscriptionJson]) => {
        let subscription;
        try {
            subscription = JSON.parse(subscriptionJson);
        } catch (err) {
            await removePushSubscription(endpoint);
            return;
        }
        try {
            await webpush.sendNotification(subscription, notificationBody);
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                await removePushSubscription(endpoint);
            } else {
                console.error('Push send error:', err.message);
            }
        }
    }));
}
// -----------------------------------------------------------------

let httpsServer;
let tcpServer;

async function main(){

    await redisClient.connect();

    let bibs;
    try {
        bibs = JSON.parse(fs.readFileSync(BIBS_FILE, 'utf8'));
    } catch (err) {
        console.error(`Failed to load bib data from "${BIBS_FILE}" (year=${RACE_YEAR}). Pass --year=<year>, set YEAR=<year>, or set BIBS_FILE=<path> to point at the right file.`);
        throw err;
    }
    console.log(`Loaded bib data for year ${RACE_YEAR} from ${BIBS_FILE} (${Object.keys(bibs).length} chips).`);

    // Pre-stringify all bib fields once so per-message conversion is not needed
    for (const chipCode in bibs) {
        const b = bibs[chipCode];
        for (const k in b) {
            if (Object.prototype.hasOwnProperty.call(b, k) && b[k] != null) {
                b[k] = b[k].toString();
            }
        }
    }

    // Build O(1) reverse index by bib number for fallback lookups
    const bibsByNumber = Object.create(null);
    for (const b of Object.values(bibs)) {
        if (b.bib != null) {
            bibsByNumber[b.bib] = b;
        }
    }

    // Room names are no longer restricted to a server-side whitelist -- any
    // roomName a client sends is accepted as-is (defaulting to 'everywhere'
    // only when none is given). Restricting which rooms/filters are exposed
    // is now a frontend concern (see index.html's filter buttons).

    // Finisher counters: derive known distance/gender groups from the bib data
    // and pre-load the atomic dedup+increment Lua script.
    const finisherKnownGroups = computeKnownGroups(bibs);
    counterScriptSha = await redisClient.scriptLoad(COUNTER_LUA_SCRIPT);

    app.use(express.static('public'));
    app.use(express.json());

    // Push notification subscription endpoints. Registered before the
    // catch-all '/:room' route below so they aren't swallowed by it.
    app.get('/push-public-key', (req, res) => {
        if (!pushNotificationsEnabled) {
            return res.status(503).json({ error: 'Push notifications are not configured on this server' });
        }
        res.json({ publicKey: VAPID_PUBLIC_KEY });
    });

    app.post('/push-subscribe', async (req, res) => {
        if (!pushNotificationsEnabled) {
            return res.status(503).json({ error: 'Push notifications are not configured on this server' });
        }
        const subscription = req.body;
        if (!subscription || typeof subscription.endpoint !== 'string') {
            return res.status(400).json({ error: 'Invalid subscription' });
        }
        try {
            await savePushSubscription(subscription);
            res.status(201).json({ ok: true });
        } catch (err) {
            console.error('Error saving push subscription:', err);
            res.status(500).json({ error: 'Failed to save subscription' });
        }
    });

    app.post('/push-unsubscribe', async (req, res) => {
        const endpoint = req.body && req.body.endpoint;
        if (typeof endpoint !== 'string') {
            return res.status(400).json({ error: 'Missing endpoint' });
        }
        try {
            await removePushSubscription(endpoint);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error('Error removing push subscription:', err);
            res.status(500).json({ error: 'Failed to remove subscription' });
        }
    });

    app.get('/:room', (req, res) => {
        console.log("Requested index html: ", `room name: ${req.params.room.split("?")[0]}`, `, query: ${JSON.stringify(req.query)}`)
        res.sendFile(join(__dirname, 'index.html'));
    });
    app.get('/', (req, res) => {
        console.log("Requested index html: ", `room name: everywhere (non specified)`)
        res.sendFile(join(__dirname, 'index.html'));
    });

    // Socket.IO connection
    io.on('connection', async (iosocket) => {
        console.log('A user connected from origin:', iosocket.handshake.headers.origin);

        const query = iosocket.handshake.query || {};
        let roomName = (query.roomName || "everywhere").toString();

        iosocket.join(roomName);
        console.log(`User joined room: ${roomName}`);
        iosocket.currentRoom = roomName;


        const fetchLimit = 100; // internal fetch size
        const sendLimit = 30;   // what we actually send to client

        try {
            // Fetch initial messages
            let messageKeys = [];
            if (roomName && roomName !== "everywhere") {
                messageKeys = await redisClient.zRange(`z:messages:source:${roomName}`, 0, fetchLimit -1, { REV: true });
            } else {
                messageKeys = await redisClient.zRange(`z:messages:everywhere`, 0, fetchLimit -1, { REV: true });
            }

            let messages = [];
            if (messageKeys.length > 0) {
                const multiGet = redisClient.multi();
                messageKeys.forEach(key => multiGet.hGetAll(key));
                const rawMessages = await multiGet.exec();
                messages = rawMessages.map(msg => msg).filter(msg => msg != null);
            }

            // Filtering
            let filteredMessages = messages;
            if (query.bibnr) {
                filteredMessages = filteredMessages.filter(msg => msg.Bib === query.bibnr);
            }
            if (query.laps) {
                filteredMessages = filteredMessages.filter(msg => msg.l && parseInt(msg.l) > parseInt(query.laps));
            }
            if (roomName && roomName !== "everywhere" && query.roomName && query.roomName.includes('%')) {
                const pattern = new RegExp(query.roomName.replace(/%/g, '.*'));
                filteredMessages = filteredMessages.filter(msg => msg.sourceName && pattern.test(msg.sourceName));
            }


            const finalMessages = filteredMessages.slice(0, sendLimit);

            iosocket.emit('initial data', finalMessages);

            // Fetch initial markers
            const markerKeys = await redisClient.zRange('z:markers:all', 0, fetchLimit -1, { REV: true });
            let markers = [];
            if (markerKeys.length > 0) {
                const multiGetMarkers = redisClient.multi();
                markerKeys.forEach(key => multiGetMarkers.hGetAll(key));
                const rawMarkers = await multiGetMarkers.exec();
                markers = rawMarkers.map(m => m).filter(m => m !=null);
            }

            iosocket.emit('initial markers', markers.slice(0, sendLimit));

        } catch (err) {
            console.error('Error fetching initial data from Redis:', err);
            iosocket.emit('initial data', []);
            iosocket.emit('initial markers', []);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching initial data from Redis: ${err.message}` });
            log.write(xlog);
        }

        try {
            iosocket.emit('initial finisher counters', await getAllCounterSnapshots(finisherKnownGroups));
        } catch (err) {
            console.error('Error fetching finisher counters from Redis:', err);
            iosocket.emit('initial finisher counters', {});
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching finisher counters from Redis: ${err.message}` });
            log.write(xlog);
        }

        iosocket.on('change room', async (newRoom) => {
            console.log(`User wants to change from ${iosocket.currentRoom} to ${newRoom}`);

            // Leave huidige room
            if (iosocket.currentRoom) {
                iosocket.leave(iosocket.currentRoom);
                console.log(`User left room: ${iosocket.currentRoom}`);
            }

            // Join nieuwe room
            iosocket.join(newRoom);
            iosocket.currentRoom = newRoom;
            console.log(`User joined room: ${newRoom}`);

            // Haal fresh data op voor de nieuwe room
            try {
                const fetchLimit = 100;
                const sendLimit = 30;

                let messageKeys = [];
                if (newRoom && newRoom !== "everywhere") {
                    messageKeys = await redisClient.zRange(`z:messages:source:${newRoom}`, 0, fetchLimit - 1, { REV: true });
                } else {
                    messageKeys = await redisClient.zRange(`z:messages:everywhere`, 0, fetchLimit - 1, { REV: true });
                }

                let messages = [];
                if (messageKeys.length > 0) {
                    const multiGet = redisClient.multi();
                    messageKeys.forEach(key => multiGet.hGetAll(key));
                    const rawMessages = await multiGet.exec();
                    messages = rawMessages.map(msg => msg).filter(msg => msg != null);
                }

                const finalMessages = messages.slice(0, sendLimit);

                // Stuur fresh data naar client
                iosocket.emit('all messages', finalMessages);

            } catch (err) {
                console.error('Error fetching data for new room:', err);
                iosocket.emit('all messages', []);
            }
        });

        iosocket.on('disconnect', () => {
            console.log('user disconnected');
        });
    });

    // Create HTTPS server
    const httpsOptions = {
        key: fs.readFileSync('privkey.pem'),
        cert: fs.readFileSync('fullchain.pem'),
    };

    httpsServer = https.createServer(httpsOptions, app);

    // Socket.IO for HTTPS (WSS)
    const httpsio = new Server(httpsServer, {
        cors: {
            origin: finalAllowedOrigins.includes('*') ? '*' : finalAllowedOrigins,
            methods: ['GET', 'POST'],
            credentials: false
        },
        transports: ['polling', 'websocket'],
        allowEIO3: true,
        pingTimeout: 60000,
        pingInterval: 25000
    });

    httpsio.on('connection', async (iosocket) => {
        console.log('A user connected from origin:', iosocket.handshake.headers.origin);

        const query = iosocket.handshake.query || {};
        let roomName = (query.roomName || "everywhere").toString();

        iosocket.join(roomName);
        console.log(`User joined room: ${roomName}`);
        iosocket.currentRoom = roomName;


        const fetchLimit = 100; // internal fetch size
        const sendLimit = 30;   // what we actually send to client

        try {
            // Fetch initial messages
            let messageKeys = [];
            if (roomName && roomName !== "everywhere") {
                messageKeys = await redisClient.zRange(`z:messages:source:${roomName}`, 0, fetchLimit -1, { REV: true });
            } else {
                messageKeys = await redisClient.zRange(`z:messages:everywhere`, 0, fetchLimit -1, { REV: true });
            }

            let messages = [];
            if (messageKeys.length > 0) {
                const multiGet = redisClient.multi();
                messageKeys.forEach(key => multiGet.hGetAll(key));
                const rawMessages = await multiGet.exec();
                messages = rawMessages.map(msg => msg).filter(msg => msg != null);
            }

            // Filtering
            let filteredMessages = messages;
            if (query.bibnr) {
                filteredMessages = filteredMessages.filter(msg => msg.Bib === query.bibnr);
            }
            if (query.laps) {
                filteredMessages = filteredMessages.filter(msg => msg.l && parseInt(msg.l) > parseInt(query.laps));
            }
            if (roomName && roomName !== "everywhere" && query.roomName && query.roomName.includes('%')) {
                const pattern = new RegExp(query.roomName.replace(/%/g, '.*'));
                filteredMessages = filteredMessages.filter(msg => msg.sourceName && pattern.test(msg.sourceName));
            }


            const finalMessages = filteredMessages.slice(0, sendLimit);

            iosocket.emit('initial data', finalMessages);

            // Fetch initial markers
            const markerKeys = await redisClient.zRange('z:markers:all', 0, fetchLimit -1, { REV: true });
            let markers = [];
            if (markerKeys.length > 0) {
                const multiGetMarkers = redisClient.multi();
                markerKeys.forEach(key => multiGetMarkers.hGetAll(key));
                const rawMarkers = await multiGetMarkers.exec();
                markers = rawMarkers.map(m => m).filter(m => m !=null);
            }

            iosocket.emit('initial markers', markers.slice(0, sendLimit));

        } catch (err) {
            console.error('Error fetching initial data from Redis:', err);
            iosocket.emit('initial data', []);
            iosocket.emit('initial markers', []);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching initial data from Redis: ${err.message}` });
            log.write(xlog);
        }

        try {
            iosocket.emit('initial finisher counters', await getAllCounterSnapshots(finisherKnownGroups));
        } catch (err) {
            console.error('Error fetching finisher counters from Redis:', err);
            iosocket.emit('initial finisher counters', {});
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching finisher counters from Redis: ${err.message}` });
            log.write(xlog);
        }

        iosocket.on('change room', async (newRoom) => {
            console.log(`User wants to change from ${iosocket.currentRoom} to ${newRoom}`);

            if (iosocket.currentRoom) {
                iosocket.leave(iosocket.currentRoom);
                console.log(`User left room: ${iosocket.currentRoom}`);
            }

            iosocket.join(newRoom);
            iosocket.currentRoom = newRoom;
            console.log(`User joined room: ${newRoom}`);

            try {
                const fetchLimit = 100;
                const sendLimit = 30;

                let messageKeys = [];
                if (newRoom && newRoom !== "everywhere") {
                    messageKeys = await redisClient.zRange(`z:messages:source:${newRoom}`, 0, fetchLimit - 1, { REV: true });
                } else {
                    messageKeys = await redisClient.zRange(`z:messages:everywhere`, 0, fetchLimit - 1, { REV: true });
                }

                let messages = [];
                if (messageKeys.length > 0) {
                    const multiGet = redisClient.multi();
                    messageKeys.forEach(key => multiGet.hGetAll(key));
                    const rawMessages = await multiGet.exec();
                    messages = rawMessages.map(msg => msg).filter(msg => msg != null);
                }

                const finalMessages = messages.slice(0, sendLimit);

                iosocket.emit('all messages', finalMessages);

            } catch (err) {
                console.error('Error fetching data for new room:', err);
                iosocket.emit('all messages', []);
            }
        });

        iosocket.on('disconnect', () => {
            console.log('user disconnected');
        });
    });


    // Fire-and-forget Redis persistence, so a slow/failed write can never
    // delay the live broadcast (which has already gone out by the time this
    // runs). Logged the same way an awaited failure would have been.
    function persistInBackground(promise, label) {
        promise.catch(err => {
            console.error(`Redis persist error (${label}):`, err);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Redis persist error (${label}): ${err.message}` });
            log.write(xlog);
        });
    }

    // Handles one fully-framed TCP message. Awaited sequentially per message
    // (see the 'data' handler below) so finisher-counter ranks still come
    // out in the exact order chips crossed the mat, across message
    // boundaries and not just within a single batch.
    async function processTcpMessage(pass, socket) {
        const rawMessage = pass.toString().trim();
        let mlog = log.entry(metadata, rawMessage);
        log.write(mlog)
        const messageString = bufferToString(pass);

        const parsedMessage = parseMessage(bibs, bibsByNumber, messageString, socket);
        let plog = log.entry(metadata, parsedMessage);
        log.write(plog)
        if (parsedMessage.function === 'AckPing') {
            handleAckPing(socket, parsedMessage);
        }

        if(parsedMessage.function === 'Passing') {
            // Broadcast first, persist in the background: live delivery speed
            // matters more than the (rare) case where a Redis write fails
            // after clients already saw the message.
            io.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
            httpsio.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
            persistInBackground(storeMessageInRedis(parsedMessage), 'storeMessage');

            const counterEvent = COUNTER_EVENTS.find(ev => ev.sourceName === parsedMessage.sourceName);
            if (counterEvent && Array.isArray(parsedMessage.data)) {
                // Sequential (not parallel) so ranks are assigned in the same
                // order the chips actually crossed the mat, matching the order
                // MYLAPS already sends them in within a batch.
                for (const record of parsedMessage.data) {
                    try {
                        const result = await recordCounterEvent(counterEvent, record);
                        if (result) {
                            const counterPayload = {
                                event: counterEvent.name,
                                sourceName: parsedMessage.sourceName,
                                bib: record.bib || null,
                                chip: record.c || null,
                                name: record.Name || null,
                                gender: record.gender || null,
                                raceType: record.raceType || null,
                                country: record.Country || null,
                                counters: result.counters,
                                allTime: result.allTime,
                                timestamp: Date.now(),
                            };
                            io.to(parsedMessage.sourceName).to("everywhere").emit('finisher counters', counterPayload);
                            httpsio.to(parsedMessage.sourceName).to("everywhere").emit('finisher counters', counterPayload);

                            if (result.specialFinishes.length > 0) {
                                const specialPayload = { ...counterPayload, specialFinishes: result.specialFinishes };
                                io.to(parsedMessage.sourceName).to("everywhere").emit('special finish', specialPayload);
                                httpsio.to(parsedMessage.sourceName).to("everywhere").emit('special finish', specialPayload);
                                // Not awaited: push delivery must never delay live timing data.
                                sendSpecialFinishPushNotifications(specialPayload).catch(err => {
                                    console.error('Error sending special finish push notifications:', err);
                                });
                            }
                        }
                    } catch (err) {
                        console.error('Finisher counter error:', err);
                        let xlog = log.entry(metadata, { severity: 'ERROR', message: `Finisher counter error: ${err.message}` });
                        log.write(xlog);
                    }
                }
            }
        }

        if(parsedMessage.function === 'Marker') {
            io.to(parsedMessage.sourceName).to("everywhere").emit('new marker', parsedMessage);
            httpsio.to(parsedMessage.sourceName).to("everywhere").emit('new marker', parsedMessage);
            persistInBackground(storeMarkerInRedis(parsedMessage), 'storeMarker');
        }
    }

    // TCP server
    tcpServer = net.createServer(async (socket) => {
        console.log('TCP client connected');
        let clog = log.entry(metadata, 'TCP client connected');
        log.write(clog);

        let rawData = "";
        const sep = "$";

        socket.on('data', async function(chunk) {
            rawData += chunk;

            // A while loop (not `if`): a single TCP chunk can contain more
            // than one complete '$'-terminated message (Mylaps often flushes
            // several readings together). Processing only the first and
            // waiting for the *next* unrelated chunk to handle the rest
            // could stall an already-fully-received message for seconds.
            let sepIndex;
            while ((sepIndex = rawData.indexOf(sep)) !== -1) {
                let pass = rawData.slice(0, sepIndex);
                rawData = rawData.slice(sepIndex + 1);

                if (!pass.toString().trim()) continue;

                await processTcpMessage(pass, socket);
            }
        });

        socket.on('end', () => {
            console.log('Client disconnected');
            let xlog = log.entry(metadata, 'TCP client disconnected');
            log.write(xlog);
        });

        socket.on('error', (err) => {
            console.error('Socket error:', err);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `TCP Socket error: ${err.message}` });
            log.write(xlog);
        });

    });


    // Start the HTTP Server
    server.listen(8080, () => {
        console.log('HTTP-server luistert op poort 8080');
    });

    // Start the HTTPS Server
    httpsServer.listen(8443, () => {
        console.log('HTTPS-server luistert op poort 8443');
    });

    // Start the TCP/IP Server to listen to Mylaps Exporter
    tcpServer.listen(TCP_PORT, () => {
        console.log(`TCP server listening on port ${TCP_PORT}`);
    });

}

main().catch(err => {
    console.error("Failed to start main application:", err);
    let xlog = log.entry(metadata, { severity: 'CRITICAL', message: `Failed to start main application: ${err.message}` });
    log.write(xlog);
    if (redisClient.isOpen) {
        redisClient.quit();
    }
    process.exit(1);
});

// Graceful shutdown
async function shutdownGracefully(signal) {
    console.log(`${signal} signal received: closing Redis client and servers.`);
    try {
        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        if (server) {
            server.close(() => console.log('HTTP server closed.'));
        }
        if (httpsServer) {
            httpsServer.close(() => console.log('HTTPS server closed.'));
        }
        if (tcpServer) {
            tcpServer.close(() => console.log('TCP server closed.'));
        }
        let xlog = log.entry(metadata, `${signal} signal received, shutting down.`);
        log.write(xlog);
    } catch (err) {
        console.error(`Error during shutdown: ${err.message}`);
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
