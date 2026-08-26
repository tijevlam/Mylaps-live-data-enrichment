'use strict';

// Replays every real timing-mat split from the 2025 race (not just finishes)
// against the TCP passing-message ingest, so you can load-test the server -
// including the finisher counters / dedup / push notification pipeline -
// with realistic volume and real bib numbers instead of synthetic data.
//
//   node replay-2025-results.js                    # timeline mode, 300x real time, against localhost
//   node replay-2025-results.js --mode burst        # blast everything as fast as possible
//   node replay-2025-results.js --limit 500         # quick smoke test (first 500 chronological events)
//   node replay-2025-results.js --stadium           # only the run-in-stadium laps + finish (TimeR1-TimeR4, TimeFinish)
//   node replay-2025-results.js --sources TimeR2,TimeR3,TimeR4,TimeFinish  # any custom sourceName subset
//   node replay-2025-results.js --host 1.2.3.4 --yes  # point at a non-local server (see warning below)
//
// IMPORTANT: this sends ~49,000 real bib numbers through the finisher-counter
// dedup pipeline. Only run this against a server backed by a local/throwaway
// Redis, or run `node reset-finisher-counters.js --yes` afterwards --
// otherwise those bibs get marked "already counted" and won't be counted
// again if the same bib numbers are reused for the real race.
//
// The results file (~100MB) is downloaded once from Challenge Almere's public
// results bucket and cached under .cache/ (gitignored). Use --refresh to
// re-download, or --file to point at your own local copy of the same shape.

const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');

function arg(flagName, def) {
    const i = process.argv.indexOf(flagName);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const kv = process.argv.find(a => a.startsWith(flagName + '='));
    return kv ? kv.split('=').slice(1).join('=') : def;
}
function flag(name) {
    return process.argv.includes(name);
}

const HOST = arg('--host', '34.32.193.155');
const PORT = parseInt(arg('--port', '3389'), 10);
const MODE = arg('--mode', 'timeline'); // timeline | burst
const SPEED = parseFloat(arg('--speed', '40')); // timeline mode: real-time compression factor
const CHUNK = parseInt(arg('--chunk', '150'), 10); // burst mode: max records per Passing message
const LIMIT = arg('--limit', null); // cap total events, earliest-first (quick smoke test)
const STADIUM = flag('--stadium'); // shorthand: only the run-in-stadium laps + finish
const SOURCES_ARG = arg('--sources', null); // comma-separated sourceName allowlist (overrides --stadium)
const SOURCE_URL = arg('--url', 'https://challengealmere.s3.dualstack.eu-west-1.amazonaws.com/data/2025-results-merged.json');
const CACHE_FILE = arg('--file', path.join(__dirname, '.cache', '2025-results-merged.json'));
const REFRESH = flag('--refresh');
const CONFIRMED = flag('--yes');

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !CONFIRMED) {
    console.error(`Refusing to replay real passings at "${HOST}" without --yes.`);
    console.error('This pollutes the finisher-counter dedup state (bib numbers get marked "already counted").');
    console.error('Only do this against a server backed by a local/throwaway Redis, or run reset-finisher-counters.js --yes afterwards.');
    console.error('Re-run with --yes to confirm you understand.');
    process.exit(1);
}

// Maps this results file's timing-point aliases to the sourceName strings the
// server/rooms actually use. TIMEFINISH -> TimeFinish is the important one --
// it's what drives the finisher counters -- along with TimeR1/TimeES/TimeEB
// which match the existing room whitelist. Anything else falls back to the
// raw alias unchanged.
const ALIAS_TO_SOURCE_NAME = {
    TIMESTART: 'TimeStart',
    TIMEES: 'TimeES',
    TIMESB: 'TimeSB',
    TIMEEB: 'TimeEB',
    TIMER0: 'TimeR0',
    TIMER1: 'TimeR1',
    TIMER2: 'TimeR2',
    TIMER3: 'TimeR3',
    TIMER4: 'TimeR4',
    TIMEB1: 'TimeB1',
    TIMEB2: 'TimeB2',
    TIMEB3: 'TimeB3',
    TIMEB4: 'TimeB4',
    TIMESRLD: 'TimeSRLD',
    TIMEFINISH: 'TimeFinish',
};
function sourceNameFor(alias) {
    return ALIAS_TO_SOURCE_NAME[alias] || alias || 'Unknown';
}

// "Stadium" = the run laps back through the stadium/finish area (TimeR1 and
// up) plus the finish line itself -- excludes swim/bike/T1/T2/TimeR0 (the
// very first run split, straight out of T2, not yet back at the stadium).
const STADIUM_SOURCES = ['TimeR1', 'TimeR2', 'TimeR3', 'TimeR4', 'TimeFinish'];

const SOURCE_FILTER = SOURCES_ARG
    ? new Set(SOURCES_ARG.split(',').map(s => s.trim()).filter(Boolean))
    : (STADIUM ? new Set(STADIUM_SOURCES) : null);

// ---- Download (with local caching) ----
function downloadFile(url, destPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
                res.resume();
                return resolve(downloadFile(res.headers.location, destPath, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            }
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            const tmpPath = `${destPath}.download`;
            const file = fs.createWriteStream(tmpPath);
            let received = 0;
            const total = parseInt(res.headers['content-length'] || '0', 10);
            res.on('data', (chunk) => {
                received += chunk.length;
                if (total) process.stdout.write(`\rDownloading results data: ${(received / 1e6).toFixed(1)}MB / ${(total / 1e6).toFixed(1)}MB`);
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    process.stdout.write('\n');
                    fs.renameSync(tmpPath, destPath);
                    resolve();
                });
            });
            file.on('error', reject);
        }).on('error', reject);
    });
}

async function loadResultsData() {
    if (REFRESH || !fs.existsSync(CACHE_FILE)) {
        console.log(`Fetching ${SOURCE_URL} -> ${CACHE_FILE} ...`);
        await downloadFile(SOURCE_URL, CACHE_FILE);
    } else {
        console.log(`Using cached results file: ${CACHE_FILE} (pass --refresh to re-download)`);
    }
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
}

// ---- Flatten into a chronological list of timing events ----
// Each finisher's top-level record IS their finish split (duplicated as the
// last entry of detailedSplits), so we only read detailedSplits to avoid
// double-counting it.
function buildEvents(resultsData) {
    const events = [];
    for (const records of Object.values(resultsData)) {
        for (const record of records) {
            const splits = (record.detailedSplits && record.detailedSplits.length) ? record.detailedSplits : [record];
            for (const split of splits) {
                const epoch = parseFloat(split.epochTime);
                const bib = split.bib;
                if (!Number.isFinite(epoch) || !bib) continue;
                const sourceName = sourceNameFor(split.alias || split.point);
                if (SOURCE_FILTER && !SOURCE_FILTER.has(sourceName)) continue;
                events.push({
                    epoch,
                    sourceName,
                    bib: String(bib),
                    chip: split.tag || split.pid || `T${bib}`,
                });
            }
        }
    }
    events.sort((a, b) => a.epoch - b.epoch);
    return LIMIT ? events.slice(0, parseInt(LIMIT, 10)) : events;
}

// ---- Wire format helpers (matches parsePassingMessage in server.js) ----
const AMSTERDAM_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
});
function localTimeAndDate(epochSeconds) {
    const parts = AMSTERDAM_FORMATTER.formatToParts(new Date(epochSeconds * 1000));
    const get = (type) => parts.find(p => p.type === type).value;
    const ms = String(Math.round((epochSeconds % 1) * 1000)).padStart(3, '0');
    return {
        d: `${get('year')}${get('month')}${get('day')}`,
        t: `${get('hour')}:${get('minute')}:${get('second')}.${ms}`,
    };
}

function eventToRecord(evt) {
    const { d, t } = localTimeAndDate(evt.epoch);
    return `c=${evt.chip}|ct=CX|t=${t}|d=${d}|l=1|dv=2|re=0|an=-1|g=-1|n=${evt.chip}|b=${evt.bib}`;
}

let msgNum = 1;
function passingMessage(sourceName, evts) {
    return `${sourceName}@Passing@${evts.map(eventToRecord).join('@')}@${msgNum++}@$`;
}

function writeAndDrain(socket, data) {
    return new Promise((resolve) => {
        if (socket.write(data)) resolve();
        else socket.once('drain', resolve);
    });
}

// ---- Stats ----
const stats = { sent: 0, messages: 0, acks: 0, bySource: Object.create(null) };
function recordSent(evts) {
    stats.sent += evts.length;
    stats.messages += 1;
    for (const e of evts) {
        stats.bySource[e.sourceName] = (stats.bySource[e.sourceName] || 0) + 1;
    }
}

function printSummary(startedAt, uniqueBibs, totalEvents) {
    const ms = Date.now() - startedAt;
    console.log('\nResults:');
    console.log(`  Timing events available : ${totalEvents} (${uniqueBibs} unique bibs)`);
    console.log(`  Records sent            : ${stats.sent}`);
    console.log(`  Messages sent           : ${stats.messages}`);
    console.log(`  ACKs received           : ${stats.acks}`);
    console.log(`  Elapsed                 : ${(ms / 1000).toFixed(1)}s`);
    console.log(`  Throughput              : ${(stats.sent / ms * 1000).toFixed(1)} records/sec`);
    console.log('  Per source:');
    for (const [src, count] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${src.padEnd(14)}: ${count}`);
    }
    console.log(`\n  TimeFinish records sent = ${stats.bySource['TimeFinish'] || 0} finisher(s) -> this is what drives the finisher counters.`);
    console.log('  Remember: run `node reset-finisher-counters.js --yes` before using this server for a real race.');
}

// Groups already-chronologically-sorted events by sourceName (each group
// stays chronological, so e.g. TimeFinish batches still reflect real placing
// order for rank correctness), then chunks each group for sending.
function groupBySource(events) {
    const groups = new Map();
    for (const e of events) {
        if (!groups.has(e.sourceName)) groups.set(e.sourceName, []);
        groups.get(e.sourceName).push(e);
    }
    return groups;
}

async function runBurst(socket, events) {
    const groups = groupBySource(events);
    for (const [sourceName, group] of groups) {
        for (let i = 0; i < group.length; i += CHUNK) {
            const batch = group.slice(i, i + CHUNK);
            await writeAndDrain(socket, passingMessage(sourceName, batch));
            recordSent(batch);
        }
    }
}

async function runTimeline(socket, events) {
    let prevEpoch = events.length ? events[0].epoch : 0;
    for (const evt of events) {
        const realGapMs = Math.max(0, (evt.epoch - prevEpoch) * 1000);
        prevEpoch = evt.epoch;
        const waitMs = realGapMs / SPEED;
        if (waitMs > 1) await new Promise(r => setTimeout(r, waitMs));
        await writeAndDrain(socket, passingMessage(evt.sourceName, [evt]));
        recordSent([evt]);
    }
}

async function main() {
    const resultsData = await loadResultsData();
    const events = buildEvents(resultsData);
    const uniqueBibs = new Set(events.map(e => e.bib)).size;

    console.log(`Loaded ${events.length} timing events for ${uniqueBibs} unique bibs.`);
    if (SOURCE_FILTER) {
        console.log(`Source filter: ${[...SOURCE_FILTER].join(', ')}`);
    }
    console.log(`Target: ${HOST}:${PORT}  mode=${MODE}${MODE === 'timeline' ? `  speed=${SPEED}x` : `  chunk=${CHUNK}`}`);
    console.log('---');

    const socket = net.createConnection({ host: HOST, port: PORT }, async () => {
        console.log('Connected. Replaying...');
        const startedAt = Date.now();

        const progressTimer = setInterval(() => {
            process.stdout.write(`\rSent ${stats.sent} / ${events.length} records...`);
        }, 1000);

        try {
            if (MODE === 'burst') {
                await runBurst(socket, events);
            } else {
                await runTimeline(socket, events);
            }
        } finally {
            clearInterval(progressTimer);
            process.stdout.write('\n');
        }

        setTimeout(() => {
            printSummary(startedAt, uniqueBibs, events.length);
            socket.destroy();
        }, 500);
    });

    socket.on('data', () => { stats.acks += 1; });
    socket.on('error', (err) => {
        console.error('Connection error:', err.message);
        process.exit(1);
    });
    socket.on('close', () => {
        console.log('Connection closed.');
    });
}

main().catch(err => { console.error(err); process.exit(1); });
