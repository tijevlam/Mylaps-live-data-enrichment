'use strict';

const net = require('net');
const fs  = require('fs');

// ---- CLI args ----
function arg(flag, def) {
    const i = process.argv.indexOf(flag);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const kv = process.argv.find(a => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : def;
}

const COUNT  = parseInt(arg('--count',  '100'));
const HOST   = arg('--host',   '127.0.0.1');
const PORT   = parseInt(arg('--port',   '3389'));
const ROOM   = arg('--room',   'TimeFinish');
const MODE   = arg('--mode',   'burst');   // burst | stream
const DELAY  = parseInt(arg('--delay',  '0'));   // ms between stream messages
const REPEAT = parseInt(arg('--repeat', '1'));   // how many times to send the batch

// ---- Load chip codes from whatever bib file is present ----
const bibFiles = [
    'bibs2025_enhanced.json',
    'bibs2024_enhanced.json',
    'bib2024.json',
    'bib2023.json',
];
let bibs = null;
let bibFile = null;
for (const f of bibFiles) {
    try {
        bibs = JSON.parse(fs.readFileSync(f, 'utf8'));
        bibFile = f;
        break;
    } catch { /* try next */ }
}
if (!bibs) {
    console.error('No bib JSON file found. Put bibs2025_enhanced.json (or similar) in this directory.');
    process.exit(1);
}

const allChips = Object.keys(bibs);
const chips    = allChips.slice(0, Math.min(COUNT, allChips.length));

// ---- Print config ----
console.log(`Bib source : ${bibFile} (${allChips.length} chips available)`);
console.log(`Target     : ${HOST}:${PORT}  room=${ROOM}`);
console.log(`Mode       : ${MODE}  count=${chips.length}  repeat=${REPEAT}${MODE === 'stream' && DELAY > 0 ? `  delay=${DELAY}ms` : ''}`);
if (chips.length < COUNT) {
    console.warn(`Warning    : only ${chips.length} chips available, requested ${COUNT}`);
}
console.log('---');

// ---- Build a single pipe-delimited record ----
function makeRecord(chip) {
    const now = new Date();
    const t = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const y = String(now.getFullYear()).slice(2);
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `c=${chip}|ct=CX|t=${t}|d=${y}${m}${d}|l=1|dv=2|re=0|an=-1|g=-1|n=${chip}|b=-1`;
}

// ---- Build a Passing message (one or many records in one TCP write) ----
let msgNum = 1;

function burstMsg(chipList) {
    return `${ROOM}@Passing@${chipList.map(makeRecord).join('@')}@${msgNum++}@$`;
}

function streamMsg(chip) {
    return `${ROOM}@Passing@${makeRecord(chip)}@${msgNum++}@$`;
}

// ---- Stats ----
let totalSent = 0;
let totalAcks = 0;
const startTime = Date.now();

// ---- Connect and run ----
const client = net.createConnection({ host: HOST, port: PORT }, () => {
    console.log('Connected.');

    if (MODE === 'burst') {
        // All records packed into a single Passing message per repeat
        for (let r = 0; r < REPEAT; r++) {
            client.write(burstMsg(chips));
            totalSent += chips.length;
        }
        console.log(`Sent ${totalSent} records across ${REPEAT} burst message(s). Waiting for ACKs…`);
        setTimeout(() => finish(), 500 + REPEAT * 50);

    } else {
        // One Passing message per record, sent round-robin across repeats
        const total = chips.length * REPEAT;
        let sent = 0;

        function sendNext() {
            if (sent >= total) { finish(); return; }
            const chip = chips[sent % chips.length];
            client.write(streamMsg(chip));
            totalSent++;
            sent++;
            DELAY > 0 ? setTimeout(sendNext, DELAY) : setImmediate(sendNext);
        }
        sendNext();
    }
});

function finish() {
    const ms = Date.now() - startTime;
    const rate = (totalSent / ms * 1000).toFixed(1);
    console.log(`\nResults:`);
    console.log(`  Records sent : ${totalSent}`);
    console.log(`  ACKs received: ${totalAcks}`);
    console.log(`  Elapsed      : ${ms} ms`);
    console.log(`  Throughput   : ${rate} bibs/sec`);
    client.destroy();
}

client.on('data', () => { totalAcks++; });

client.on('error', (err) => {
    console.error('Connection error:', err.message);
    process.exit(1);
});

client.on('close', () => {
    console.log('Connection closed.');
});
