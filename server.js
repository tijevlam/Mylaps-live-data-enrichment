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
// Creates a client
const logging = new Logging({projectId});

// Selects the log to write to
const log = logging.log(logName);

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

function matchChipBibToBib(bibs, chipbib) {
    // console.log(bibs[0], chip)
    const bib = Object.values(bibs).find(bib => bib.bib === chipbib);
    // console.log(bib);
    for (const k in bib) {
        if (bib.hasOwnProperty(k) && bib[k] != null) {
            bib[k] = bib[k].toString();
        }
    }
    // console.log(bib);
    return bib ? bib : null;
}


function matchChipToBib(bibs, chip) {
    // console.log(bibs[0], chip)
    const bib = bibs[chip]; //bibs.find(bib => bib.Chip === chip);
    // console.log(bib);
    for (const k in bib) {
        if (bib.hasOwnProperty(k) && bib[k] != null) {
            bib[k] = bib[k].toString();
        }
    }
    // console.log(bib);
    return bib ? bib : null;
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

function parseMessage(bibs, rawMessage, socket) {
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
        console.log(`Tije@Ack${function_}${['Store','Passing', 'Marker'].includes(function_) ? '@'+messageNumber:''}@$`);
    }

    let parsedData;
    switch (function_) {
        case 'Store':
            parsedData = parseStoreMessage(data);
            break;
        case 'Passing':
            parsedData = parsePassingMessage(bibs, data);
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

function parsePassingMessage(bibs, data) {
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
            const bib = matchChipToBib(bibs, passingData.c);
            if (bib) {
                Object.assign(passingData, bib);
            }
        }

        // If no name found, try to match based on bib number (b)
        if(!passingData.Name && passingData.b && passingData.b > -1){
            console.log("looking for athlete based on bib:", passingData.b);
            const chipbib = matchChipBibToBib(bibs, passingData.b)
            if (chipbib) {
                Object.assign(passingData, chipbib);
            }
        }

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
        console.log(`Stored ${parsedMessage.data.length} message(s) in Redis for ${parsedMessage.sourceName}`);
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
        console.log(`Stored ${parsedMessage.data.length} marker(s) in Redis for ${parsedMessage.sourceName}`);
    } catch (err) {
        console.error('Redis multi exec error (storeMarker):', err);
        let xlog = log.entry(metadata, { severity: 'ERROR', message: `Redis multi exec error (storeMarker): ${err.message}` });
        log.write(xlog);
    }
}

let httpsServer;
let tcpServer;

async function main(){

    await redisClient.connect();

    const bibs2023 = JSON.parse(fs.readFileSync('bib2023.json', 'utf8'));
    const bibs2024 = JSON.parse(fs.readFileSync('bib2024.json', 'utf8'));
    const bibs2025 =  JSON.parse(fs.readFileSync('bibs2024_enhanced.json', 'utf8')); //await parseCsv("Bibs_2024.csv");

    const bibs = bibs2025;

    app.use(express.static('public'));

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

        // Basic room whitelist to avoid unbounded growth
        const allowedRooms = new Set(['everywhere','TimeFinish','TimeR1']);
        if (!allowedRooms.has(roomName)) {
            roomName = 'everywhere';
        }

        iosocket.join(roomName);
        console.log(`User joined room: ${roomName}`);

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

            filteredMessages.sort((a, b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp));

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
                markers.sort((a,b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp));
            }

            iosocket.emit('initial markers', markers.slice(0, sendLimit));

        } catch (err) {
            console.error('Error fetching initial data from Redis:', err);
            iosocket.emit('initial data', []);
            iosocket.emit('initial markers', []);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching initial data from Redis: ${err.message}` });
            log.write(xlog);
        }

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

        // Basic room whitelist to avoid unbounded growth
        const allowedRooms = new Set(['everywhere','TimeFinish','TimeR1']);
        if (!allowedRooms.has(roomName)) {
            roomName = 'everywhere';
        }

        iosocket.join(roomName);
        console.log(`User joined room: ${roomName}`);

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

            filteredMessages.sort((a, b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp));

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
                markers.sort((a,b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp));
            }

            iosocket.emit('initial markers', markers.slice(0, sendLimit));

        } catch (err) {
            console.error('Error fetching initial data from Redis:', err);
            iosocket.emit('initial data', []);
            iosocket.emit('initial markers', []);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching initial data from Redis: ${err.message}` });
            log.write(xlog);
        }

        iosocket.on('disconnect', () => {
            console.log('user disconnected');
        });
    });


    // TCP server
    tcpServer = net.createServer(async (socket) => {
        console.log('TCP client connected');
        let clog = log.entry(metadata, 'TCP client connected');
        log.write(clog);

        let rawData = "";
        const sep = "$";

        socket.on('data', async function(chunk) {
            rawData += chunk;

            let sepIndex = rawData.indexOf(sep);
            let didFindMsg = sepIndex !== -1;

            if (didFindMsg) {
                let pass = rawData.slice(0, sepIndex);
                rawData = rawData.slice(sepIndex + 1);

                console.log(pass);
                const rawMessage = pass.toString().trim();
                console.log('Received:', rawMessage);
                let mlog = log.entry(metadata, rawMessage);
                log.write(mlog)
                const messageString = bufferToString(pass);
                console.log('Received message:', messageString);

                const parsedMessage = parseMessage(bibs, messageString, socket);
                console.log('Parsed:', JSON.stringify(parsedMessage, null, 2));
                let plog = log.entry(metadata, parsedMessage);
                log.write(plog)
                if (parsedMessage.function === 'AckPing') {
                    handleAckPing(socket, parsedMessage);
                }

                if(parsedMessage.function === 'Passing') {
                    await storeMessageInRedis(parsedMessage);
                    io.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
                    httpsio.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
                }

                if(parsedMessage.function === 'Marker') {
                    await storeMarkerInRedis(parsedMessage);
                    io.to(parsedMessage.sourceName).to("everywhere").emit('new marker', parsedMessage);
                    httpsio.to(parsedMessage.sourceName).to("everywhere").emit('new marker', parsedMessage);
                }

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
