const net = require('net');
const sqlite3 = require('sqlite3').verbose(); // For SQLite
const fs = require('fs');
const { join } = require('node:path');
const express = require('express');
import yes from 'yes-https';
const { createServer } = require('node:http');
const { Server } = require('socket.io');

const app = express();
app.use(yes());
const server = createServer(app);
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

// Database Configuration (replace with your actual path)
const db = new sqlite3.Database('mylaps_data.db'); // Use /tmp for App Engine

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
    Wave TEXT
  )
`);

const TCP_PORT = 3389; //3097; // Use the PORT environment variable for App Engine

// read bibs csv file and store in memory
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

function matchChipToBib(bibs, chip) {
    const bib = bibs.find(bib => bib.Chip === chip);
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
  const data = ['Store','Passing'].includes(function_) ? parts.slice(2, -2).join('@') : parts.slice(2, -1).join('@'); // Join in case data contains '@'
  const messageNumber = ['Store','Passing'].includes(function_) ? parts[parts.length - 2] : undefined;
  
  if (function_ === "Pong"){
    socket.write('Tije@AckPong@Version2.1@$');
      let pongLog = log.entry(metadata, 'ackpong written');
      log.write(pongLog);
  } else if (function_.indexOf('Ack') === -1){
    socket.write(`Tije@Ack${function_}${['Store','Passing'].includes(function_) ? '@'+messageNumber:''}@$`);
    console.log(`Tije@Ack${function_}${['Store','Passing'].includes(function_) ? '@'+messageNumber:''}@$`);
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

// Store messages in the database
function storeMessage(parsedMessage) {
    for(const d of parsedMessage.data) {
        db.run(`
        INSERT INTO messages (sourceName, function, messageNumber, c, d, l, b, n, t, Bib, Name, Info, Cat, Wave)
        VALUES (?, ?, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [parsedMessage.sourceName, parsedMessage.function, parsedMessage.messageNumber, d.c, d.d, d.l, d.b, d.n, d.t, d.Bib, d.Name, d.Info, d.Cat, d.Wave])
    }
}




async function main(){
    const bibs = await parseCsv("Bibs_202408280939.csv");

    app.get('/:room', (req, res) => {
        console.log("requested index html")
        console.log(`room name: ${req.params.room}`)
        res.sendFile(join(__dirname, 'index.html'));
    });
    app.get('/', (req, res) => {
        console.log("requested index html")
        console.log(`room name: everywhere (non specified)`)
        res.sendFile(join(__dirname, 'index.html'));
    });




// Socket.IO connection
    io.on('connection', (iosocket) => {
        console.log('A user connected');

        let query = iosocket.handshake.query;
        let roomName = query.roomName || "everywhere"; // TimeFinish, TimeR1
           iosocket.join(roomName);
            console.log(`User joined room: ${roomName}`);

        // Get data from the last 3 minutes
        const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
        console.log(threeMinutesAgo.toISOString())
        //        SELECT * FROM messages        WHERE timestamp >= ?            `, [threeMinutesAgo.toISOString()]
        db.all(`SELECT * FROM messages ${roomName && roomName != "everywhere" ? "WHERE sourceName LIKE \"%"+roomName+"%\"" : ""} ORDER BY timestamp DESC LIMIT 30;`, (err, rows) => {
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
        });

        iosocket.on('disconnect', () => {
            console.log('user disconnected');
        });
    });


// TCP server
    const tcpServer = net.createServer((socket) => {
        console.log('TCP client connected');
        let clog = log.entry(metadata, 'TCP client connected');
        log.write(clog);


        var rawData = ""; // variable that collects chunks
        var sep = "$";

        socket.on('data', function(chunk) {
            rawData += chunk;

            var sepIndex = rawData.indexOf(sep);
            var didFindMsg = sepIndex != -1;

            if (didFindMsg) {
                var pass = rawData.slice(0, sepIndex);
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
                    storeMessage(parsedMessage);
                    io.to(parsedMessage.sourceName).to("everywhere").emit('new message', parsedMessage);
                }

            }
        });


        socket.on('end', () => {
            console.log('Client disconnected');
        });

        socket.on('error', (err) => {
            console.error('Socket error:', err);
        });

    });


    // Start the HTTP Server to start the web interface
    server.listen(443);

    // Start the TCP/IP Server to listen to Mylaps Exporter
    tcpServer.listen(TCP_PORT, () => {
        console.log(`TCP server listening on port ${TCP_PORT}`);
    });

}

main();