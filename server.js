const net = require('net');
const sqlite3 = require('sqlite3').verbose(); // For SQLite
const fs = require('fs');

const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');

const app = express();
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
    data TEXT,
    messageNumber TEXT
  )
`);

const TCP_PORT = 3389; //3097; // Use the PORT environment variable for App Engine

function bufferToString(buffer) {
  return buffer.toString(); // Assuming UTF-8 encoding
}


function handleAckPing(socket, message) {
  // Extract the version and parameters from the parsed message
  const version = message.data.version;
  const parameters = message.data.parameters;

  // Construct the AckPong message (Version 2)
  const ackPongMessage = `T&S@AckPong@${version || 'Version2.1'}@${parameters.join('|')}$`;

  // Send the AckPong message
  socket.write(ackPongMessage);

  console.log('Sent AckPong message:', ackPongMessage);
}

function parseMessage(rawMessage, socket) {
  const parts = rawMessage.split('@');
  if (parts.length < 3) {
    return { error: 'Invalid message format' };
  }

  const sourceName = parts[0];
  const function_ = parts[1];
  const data = parts.slice(2, -1).join('@'); // Join in case data contains '@'
  const messageNumber = ['Store','Passing'].includes(function_) ? parts[parts.length - 2] : undefined;
  
  if (function_ === "Pong"){
    socket.write('Tije@AckPong@Version2.1@$');
      let pongLog = log.entry(metadata, 'ackpong written');
      log.write(pongLog);
  } else if (function_.indexOf('Ack') === -1){
    socket.write(`Tije@Ack${function_}${['Store','Passing'].includes(function_) ? '@'+messageNumber:''}@$`);
  }

  let parsedData;
  switch (function_) {
    case 'Store':
      parsedData = parseStoreMessage(data);
      break;
    case 'Passing':
      parsedData = parsePassingMessage(data);
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
    sourceName,
    function: function_,
    data: parsedData,
    messageNumber,
  };
}

function parseStoreMessage(data) {
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const [transponder, time, count, status] = record.split(' ');
        return { transponder, time, count: parseInt(count), status };
    });
}

function parsePassingMessage(data) {
    const records = data.split('@').filter(r => r.trim() !== '');
    return records.map(record => {
        const pairs = record.split('|');
        const passingData = {};
        pairs.forEach(pair => {
            const [key, value] = pair.split('=');
            passingData[key] = value;
        });
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
  db.run(`
    INSERT INTO messages (sourceName, function, data, messageNumber)
    VALUES (?, ?, ?, ?)
  `, [parsedMessage.sourceName, parsedMessage.function, JSON.stringify(parsedMessage.data), parsedMessage.messageNumber]);
}

app.get('/', (req, res) => {
		console.log("requested index html")
		res.sendFile('index.html');
	});

// Socket.IO connection
io.on('connection', (iosocket) => {
  console.log('A user connected');

  // Get data from the last 3 minutes
  const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
  db.all(`
    SELECT * FROM messages
    WHERE timestamp >= ?
  `, [threeMinutesAgo.toISOString()], (err, rows) => {
    if (err) {
      console.error('Error fetching data:', err);
    } else {
      iosocket.emit('initial data', rows);
    }
  });
  
  iosocket.on('disconnect', () => {
    console.log('user disconnected');
  });
});


server.listen(80); // Use the PORT environment variable for App Engine



// TCP server
const tcpServer = net.createServer((socket) => {
  console.log('TCP client connected');
let clog = log.entry(metadata, 'TCP client connected');
log.write(clog);
  // Send a Ping message upon connection (for Version 2)
  //socket.write('Tije@Ping@$');

  socket.on('data', (data) => {
    console.log(data);
    const rawMessage = data.toString().trim();
    console.log('Received:', rawMessage);
    let mlog = log.entry(metadata, rawMessage);
    log.write(mlog)
    const messageString = bufferToString(data);
    console.log('Received message:', messageString);
    
    /*
    if(rawMessage.indexOf('Pong') > -1){
      socket.write('Tije@AckPong@Version2.1@$');
      let pongLog = log.entry(metadata, 'ackpong written');
      log.write(pongLog);
    }
    */
      
    const parsedMessage = parseMessage(messageString, socket);
    console.log('Parsed:', JSON.stringify(parsedMessage, null, 2));
    let plog = log.entry(metadata, rawMessage);
    log.write(plog)
    if (parsedMessage.function === 'AckPing') {
        handleAckPing(socket, parsedMessage);
    }
      
    storeMessage(parsedMessage);
    io.emit('new message', parsedMessage);
  });
  
  socket.on('end', () => {
        console.log('Client disconnected');
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err);
    });

  // ... (rest of your TCP server code)
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server listening on port ${TCP_PORT}`);
});

// HTTP server
