const net = require('net');
const sqlite3 = require('sqlite3').verbose(); // For SQLite
const redis = require('redis');
const { v4: uuidv4 } = require('uuid'); // Voor unieke IDs
const fs = require('fs');
const { join } = require('node:path');
const express = require('express');
const https = require('https');
const { createServer } = require('node:http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
// const options = {
//   key: fs.readFileSync('key.pem'),
//   cert: fs.readFileSync('cert.pem')
// };

// const server = https.createServer(options, app);
const io = new Server(server);


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

function matchChipToBib(bibs, chip) {
    const bib = bibs[chip]; //bibs.find(bib => bib.Chip === chip);
    return bib && bib[0] ? bib[0] : null;
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
  // Handle additional parameters for Version 2 if needed
  // ...

  return { deviceName, status, computerName };
}

function parsePongMessage(data) {
  const parts = data.split('@');
  const version = parts[0] || null; // Extract version (e.g., 'Version2.1')
  const parameters = parts[1] ? parts[1].split('|') : []; // Extract parameters

  // Check if it's a Version 2 message
  if (version && version.startsWith('Version2')) {
    return {
      version: version,
      parameters: parameters,
    };
  } else {
    // Handle as Version 1 message
    return {
      version: null, // No version specified in Version 1
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
            ...item, // velden c, d, l, b, n, t, Bib, Name, etc.
            sourceName: parsedMessage.sourceName,
            function: parsedMessage.function,
            originalMessageNumber: parsedMessage.messageNumber || '', // Van het TCP packet
            receivedTimestamp: receivedTimestamp.toString() // Sla op als string
        };

        // Verwijder null/undefined waarden om Redis opslag cleaner te houden
        for (const key in messagePayload) {
            if (messagePayload[key] == null) {
                delete messagePayload[key];
            }
        }


        multi.hSet(messageId, messagePayload);
        multi.zAdd(`z:messages:source:${parsedMessage.sourceName}`, { score: receivedTimestamp, value: messageId });
        multi.zAdd(`z:messages:everywhere`, { score: receivedTimestamp, value: messageId });
        // Optioneel: trim oude berichten om de sets beheersbaar te houden
        // multi.zRemRangeByRank(`z:messages:source:${parsedMessage.sourceName}`, 0, -1001); // Behoud de laatste 1000
        // multi.zRemRangeByRank(`z:messages:everywhere`, 0, -5001); // Behoud de laatste 5000
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
        // Belangrijk: zorg dat 't' (markerTime) goed geconverteerd wordt als je die als score wilt.
        // Voor nu gebruiken we receivedTimestamp voor consistentie.
        const markerPayload = {
            ...item, // velden t, mt, n
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
        // multi.zRemRangeByRank(`z:markers:all`, 0, -1001); // Behoud de laatste 1000 markers
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


async function main(){

    await redisClient.connect();

    const bibs2023 = JSON.parse(fs.readFileSync('bib2023.json', 'utf8')); // await parseCsv("Bibs_202408280939.csv");
    const bibs2024 =  JSON.parse(fs.readFileSync('bib2024.json', 'utf8')); //await parseCsv("Bibs_2024.csv");
    // const bibs = [...bibs2023, ...bibs2024];
    const bibs = {...bibs2023, ...bibs2024};

    app.use(express.static('public'));

    app.get('/:room', (req, res) => {
        console.log("Requested index html: ", `room name: ${req.params.room.split("?")[0]}`, `, query: ${req.query}`)
        res.sendFile(join(__dirname, 'index.html'));
    });
    app.get('/', (req, res) => {
        console.log("Requested index html: ", `room name: everywhere (non specified)`)
        res.sendFile(join(__dirname, 'index.html'));
    });



// Socket.IO connection
    io.on('connection', async (iosocket) => {
        console.log('A user connected');

        let query = iosocket.handshake.query
        console.log(query);
        let roomName = query.roomName || "everywhere"; // TimeFinish, TimeR1
           iosocket.join(roomName);
            console.log(`User joined room: ${roomName}`);

        /* // SQLITE3 Versie
        // Get data from the last 3 minutes

        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
        console.log(threeMinutesAgo.toISOString())
        //        SELECT * FROM messages        WHERE timestamp >= ?            `, [threeMinutesAgo.toISOString()]
        db.all(`SELECT * FROM messages ${roomName && roomName != "everywhere" ? `WHERE sourceName LIKE "%${roomName}%"`: ""} ${query.bibnr ? `AND Bib = ${query.bibnr}` : ""} ${query.laps ? `AND l > ${query.laps}` : ""}  ORDER BY t DESC LIMIT 30;`, (err, rows) => {
            if (err) {
                console.error('Error fetching data:', err);
            } else {
                console.log(rows);
                // split rows in packages of 20
                let chunks = [];
                let i = 0;
                let n = rows.length;
                while (i < n) {
                    chunks.push(rows.slice(i, i += 20));
                }
                chunks.forEach(function (chunk, i) {
                    if(i===0) {
                        iosocket.emit('initial data', chunk);
                    } else {
                        iosocket.emit('more messages', chunk);
                    }
                });

            }
        })

        db.all(`SELECT * FROM markers`, (err, rows) => {
            if(err) {
                console.error('Error fetching data:', err);
            }  else {
                console.log(rows);
                // split rows in packages of 20
                let chunks = [];
                let i = 0;
                let n = rows.length;
                while (i < n) {
                    chunks.push(rows.slice(i, i += 20));
                }
                chunks.forEach(function (chunk, i) {
                    if (i === 0) {
                        iosocket.emit('initial markers', chunk);
                    } else {
                        iosocket.emit('more markers', chunk);
                    }
                });
            }
        })
        */


        const fetchLimit = 100; // Haal meer op om te filteren, stuur max 30
        const sendLimit = 30;

        try {
            // Fetch initial messages
            let messageKeys = [];
            if (roomName && roomName !== "everywhere") {
                messageKeys = await redisClient.zRevRange(`z:messages:source:${roomName}`, 0, fetchLimit -1);
            } else {
                messageKeys = await redisClient.zRevRange(`z:messages:everywhere`, 0, fetchLimit -1);
            }

            let messages = [];
            if (messageKeys.length > 0) {
                const multiGet = redisClient.multi();
                messageKeys.forEach(key => multiGet.hGetAll(key));
                const rawMessages = await multiGet.exec();
                messages = rawMessages.map(msg => msg).filter(msg => msg != null); // Verwijder nulls als een key niet gevonden werd
            }

            // Filter messages
            let filteredMessages = messages;
            if (query.bibnr) {
                filteredMessages = filteredMessages.filter(msg => msg.Bib === query.bibnr);
            }
            if (query.laps) {
                filteredMessages = filteredMessages.filter(msg => msg.l && parseInt(msg.l) > parseInt(query.laps));
            }
            // sourceName LIKE filter (als roomName niet "everywhere" was, is dit al deels gebeurd door de key keuze)
            // Voor nu is dit een simpele filter, LIKE is lastiger.
            if (roomName && roomName !== "everywhere" && query.roomName && query.roomName.includes('%')) {
                // Dit is een placeholder. Echte LIKE functionaliteit is complexer.
                // We filteren hier op de reeds geselecteerde sourceName berichten.
                // Als query.roomName een patroon is, zou je verder moeten filteren.
                const pattern = new RegExp(query.roomName.replace(/%/g, '.*'));
                filteredMessages = filteredMessages.filter(msg => msg.sourceName && pattern.test(msg.sourceName));
            }


            // Sorteer opnieuw op tijd (receivedTimestamp) DESC na filtering, indien nodig.
            // De ZREVRANGE doet dit al, maar filtering kan de volgorde verstoren als niet alle items voldoen.
            // In de praktijk is de volgorde van Redis meestal al goed genoeg.
            // Hier sorteren we de in-memory array
            filteredMessages.sort((a, b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp));


            const finalMessages = filteredMessages.slice(0, sendLimit);

            if (finalMessages.length > 0) {
                // Opsplitsen in chunks is niet meer nodig zoals bij SQLite db.all
                iosocket.emit('initial data', finalMessages);
            } else {
                iosocket.emit('initial data', []);
            }

            // Fetch initial markers
            const markerKeys = await redisClient.zRevRange('z:markers:all', 0, fetchLimit -1);
            let markers = [];
            if (markerKeys.length > 0) {
                const multiGetMarkers = redisClient.multi();
                markerKeys.forEach(key => multiGetMarkers.hGetAll(key));
                const rawMarkers = await multiGetMarkers.exec();
                markers = rawMarkers.map(m => m).filter(m => m !=null);
                markers.sort((a,b) => parseInt(b.receivedTimestamp) - parseInt(a.receivedTimestamp)); // Sorteer
            }

            if (markers.length > 0) {
                iosocket.emit('initial markers', markers.slice(0, sendLimit));
            } else {
                iosocket.emit('initial markers', []);
            }

        } catch (err) {
            console.error('Error fetching initial data from Redis:', err);
            iosocket.emit('initial data', []); // Stuur lege data bij error
            iosocket.emit('initial markers', []);
            let xlog = log.entry(metadata, { severity: 'ERROR', message: `Error fetching initial data from Redis: ${err.message}` });
            log.write(xlog);
        }


            iosocket.on('disconnect', () => {
            console.log('user disconnected');
        });
    });


// TCP server
    const tcpServer = net.createServer(async (socket) => {
        console.log('TCP client connected');
        let clog = log.entry(metadata, 'TCP client connected');
        log.write(clog);


        let rawData = ""; // variable that collects chunks
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
                    // storeMessage(parsedMessage);
                    await storeMessageInRedis(parsedMessage);
                    // Stuur het volledige parsedMessage object naar de clients.
                    // De clients moeten de 'data' array binnen dit object verwerken.
                    io.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
                }

                if(parsedMessage.function === 'Marker') {
                    // storeMarker(parsedMessage);
                    await storeMarkerInRedis(parsedMessage);
                    // Stuur het volledige parsedMessage object naar de clients
                    io.to(parsedMessage.sourceName).to("everywhere").emit('new marker', parsedMessage);
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


    // Start the HTTP Server to start the web interface
    server.listen(8080, () => {
        console.log('HTTP-server luistert op poort 8080');
      });

    // server.listen(443, () => {
    //   console.log('HTTPS-server luistert op poort 443');
    // });



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
// Graceful shutdown handler
async function shutdownGracefully(signal) {
    console.log(`${signal} signal received: closing Redis client and servers.`);
    try {
        if (redisClient.isOpen) {
            await redisClient.quit();
        }
        let xlog = log.entry(metadata, `${signal} signal received, shutting down.`);
        log.write(xlog);
        server.close(() => console.log('HTTP server closed.'));
        tcpServer.close(() => console.log('TCP server closed.'));
    } catch (err) {
        console.error(`Error during shutdown: ${err.message}`);
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));