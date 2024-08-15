const net = require('net');
const http = require('http');
const io = require('socket.io')(http);
const express = require('express');
const sqlite3 = require('sqlite3').verbose(); // For SQLite

// Database Configuration (replace with your actual path)
const db = new sqlite3.Database('/tmp/mylaps_data.db'); // Use /tmp for App Engine

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

const TCP_PORT = process.env.PORT || 3097; // Use the PORT environment variable for App Engine

// ... (rest of your parsing functions - parseMessage, parseStoreMessage, etc.)

// Store messages in the database
function storeMessage(parsedMessage) {
  db.run(`
    INSERT INTO messages (sourceName, function, data, messageNumber)
    VALUES (?, ?, ?, ?)
  `, [parsedMessage.sourceName, parsedMessage.function, JSON.stringify(parsedMessage.data), parsedMessage.messageNumber]);
}

// Socket.IO connection
io.on('connection', (socket) => {
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
      socket.emit('initial data', rows);
    }
  });
});

// TCP server
const tcpServer = net.createServer((socket) => {
  console.log('TCP client connected');

  socket.on('data', (data) => {
    const rawMessage = data.toString().trim();
    const parsedMessage = parseMessage(rawMessage);
    storeMessage(parsedMessage);
    io.emit('new message', parsedMessage);
  });

  // ... (rest of your TCP server code)
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server listening on port ${TCP_PORT}`);
});

// HTTP server
const server = http.createServer((req, res) => {
  // ... (your existing HTTP server code)
});

server.listen(process.env.PORT || 8080); // Use the PORT environment variable for App Engine

// ... (rest of your code)
