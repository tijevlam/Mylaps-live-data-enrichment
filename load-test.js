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

const COUNT      = parseInt(arg('--count',      '100'));
const HOST       = arg('--host',       '127.0.0.1');
const PORT       = parseInt(arg('--port',       '3389'));
const MODE       = arg('--mode',       'burst');       // burst | stream
const DELAY      = parseInt(arg('--delay',      '0')); // ms between stream messages
const REPEAT     = parseInt(arg('--repeat',     '1')); // how many times to send the batch
const DISTRIBUTE = arg('--distribute', 'roundrobin'); // roundrobin | wave

// Rooms: --rooms overrides, --room is a single-room shorthand, otherwise use all 4 defaults
const DEFAULT_ROOMS = ['TimeFinish', 'TimeR1', 'TimeES', 'TimeEB'];
const roomsArg = arg('--rooms', '') || arg('--room', '');
const ROOMS = roomsArg
    ? roomsArg.split(',').map(r => r.trim()).filter(Boolean)
    : DEFAULT_ROOMS;

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

if (chips.length < COUNT) {
    console.warn(`Warning    : only ${chips.length} chips available, requested ${COUNT}`);
}

// ---- Print config ----
console.log(`Bib source : ${bibFile} (${allChips.length} chips available)`);
console.log(`Target     : ${HOST}:${PORT}`);
console.log(`Rooms      : ${ROOMS.join(', ')}`);
console.log(`Mode       : ${MODE}  distribute=${DISTRIBUTE}  count=${chips.length}  repeat=${REPEAT}${DELAY > 0 ? `  delay=${DELAY}ms` : ''}`);
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

let msgNum = 1;
function passingMsg(room, chipList) {
    return `${room}@Passing@${chipList.map(makeRecord).join('@')}@${msgNum++}@$`;
}

// ---- Stats ----
let totalSent = 0;
let totalAcks = 0;
const roomStats = Object.fromEntries(ROOMS.map(r => [r, 0]));
const startTime = Date.now();

function send(room, chipList) {
    client.write(passingMsg(room, chipList));
    totalSent += chipList.length;
    roomStats[room] = (roomStats[room] || 0) + chipList.length;
}

// ---- Distribute chips across rooms ----
//
// roundrobin: chips are interleaved evenly across rooms
//   bib[0] → rooms[0], bib[1] → rooms[1], bib[2] → rooms[2], bib[3] → rooms[0], …
//   In burst mode each room gets one message with its share.
//   In stream mode each message alternates rooms.
//
// wave: all chips go to rooms[0] first, then rooms[1], etc.
//   Simulates a race where a full field passes each timing point in succession.
//   In burst mode: one big burst per room, sent sequentially.
//   In stream mode: all bibs streamed through room[0], then room[1], etc.

function buildBurstBatches() {
    if (DISTRIBUTE === 'wave') {
        return ROOMS.map(room => ({ room, chips: [...chips] }));
    }
    // roundrobin: partition chips by index mod rooms.length
    const buckets = Object.fromEntries(ROOMS.map(r => [r, []]));
    chips.forEach((chip, i) => buckets[ROOMS[i % ROOMS.length]].push(chip));
    return ROOMS.filter(r => buckets[r].length > 0).map(r => ({ room: r, chips: buckets[r] }));
}

function buildStreamSequence() {
    if (DISTRIBUTE === 'wave') {
        return ROOMS.flatMap(room => chips.map(chip => [room, chip]));
    }
    // roundrobin: interleave rooms for each chip
    return chips.map((chip, i) => [ROOMS[i % ROOMS.length], chip]);
}

// ---- Connect and run ----
const client = net.createConnection({ host: HOST, port: PORT }, () => {
    console.log('Connected.');

    if (MODE === 'burst') {
        const batches = buildBurstBatches();
        for (let r = 0; r < REPEAT; r++) {
            for (const { room, chips: chipList } of batches) {
                send(room, chipList);
            }
        }
        const msgs = batches.length * REPEAT;
        console.log(`Sent ${totalSent} records in ${msgs} message(s) across ${ROOMS.length} room(s). Waiting for ACKs…`);
        setTimeout(finish, 500 + msgs * 20);

    } else {
        // stream: one Passing message per chip
        const seq = buildStreamSequence();
        const full = Array.from({ length: REPEAT }, () => seq).flat();
        let idx = 0;

        function sendNext() {
            if (idx >= full.length) { finish(); return; }
            const [room, chip] = full[idx++];
            send(room, [chip]);
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
    for (const room of ROOMS) {
        console.log(`    ${room.padEnd(14)}: ${roomStats[room] || 0} records`);
    }
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
