# Mylaps-live-data-enrichment

### TODO
* [ ] fix redis filtering
* [ ] fix redis data
* [ ] get more test data

---

## Cross-Site Socket.IO Access

This server now supports controlled cross-origin (cross-site) WebSocket access so that other domains can subscribe to:
* Recent passings (messages) from Redis
* Recent markers from Redis
* Live incoming passings (`new message`)
* Live incoming markers (`new marker`)

### Configuration

Set the environment variable `ALLOWED_ORIGINS` with a comma-separated list of allowed origins:

```
ALLOWED_ORIGINS=https://history.hollandtriathlon.nl,https://challengealmere.s3.eu-west-1.amazonaws.com
```

For temporary development you can allow all origins (NOT recommended for production):

```
ALLOWED_ORIGINS=*
```

If `ALLOWED_ORIGINS` is not set, a default whitelist is used:
```
https://history.hollandtriathlon.nl
https://challengealmere.s3.eu-west-1.amazonaws.com
```

### Environment Variables (summary)

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | Redis host | `127.0.0.1` |
| `REDIS_PORT` | Redis port | `6379` |
| `PROJECT_ID` | GCP Project ID for logging | (none) |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins or `*` | (internal default list) |

### Events

| Event Name        | Direction | Description |
|-------------------|-----------|-------------|
| `initial data`    | server -> client | Array (max 30) of most recent passings (filtered by room / query) |
| `initial markers` | server -> client | Array (max 30) of most recent markers |
| `new message`     | server -> client | Full parsed Mylaps message object for new passings (contains `data` array) |
| `new marker`      | server -> client | Full parsed marker message object (contains `data` array) |

### Rooms

Clients can join a specific source room (e.g. `TimeFinish`, `TimeR1`) or the global room `everywhere` by passing `roomName` in the connection query. Only a limited whitelist is allowed to prevent arbitrary room creation.

Example rooms:
```
everywhere
TimeFinish
TimeR1
```

### Optional Query Filters

When connecting you may also pass:
* `bibnr` — Only return messages whose `Bib` matches.
* `laps` — Only return messages with lap count `l` greater than this value.

### Example: External Client Integration

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
  // Replace with your deployed host (including https://)
  const socket = io('https://YOUR_DEPLOYMENT_HOST', {
    query: {
      roomName: 'TimeFinish', // or 'everywhere'
      bibnr: '123',           // optional
      laps: '2'               // optional (fetch messages where l > 2)
    }
  });

  socket.on('connect', () => {
    console.log('Connected:', socket.id);
  });

  socket.on('initial data', (messages) => {
    console.log('Initial passings (trimmed):', messages);
  });

  socket.on('initial markers', (markers) => {
    console.log('Initial markers (trimmed):', markers);
  });

  socket.on('new message', (parsedPacket) => {
    // parsedPacket.data is an array of passing objects
    console.log('Live passing batch:', parsedPacket);
  });

  socket.on('new marker', (parsedPacket) => {
    console.log('Live marker batch:', parsedPacket);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected');
  });
</script>
```

### Data Model (Redis)

| Key Pattern | Type | Contents |
|-------------|------|----------|
| `message:<uuid>` | Hash | Single passing enriched with metadata |
| `z:messages:source:<sourceName>` | Sorted Set | Message IDs (score = received timestamp) |
| `z:messages:everywhere` | Sorted Set | All message IDs (score = received timestamp) |
| `marker:<uuid>` | Hash | Marker item |
| `z:markers:all` | Sorted Set | Marker IDs (score = received timestamp) |

### Trimming Strategy

Currently trimming lines are commented out. To limit memory growth, you can enable them (example keeps last 1000 per source, 5000 global):

```js
// multi.zRemRangeByRank(`z:messages:source:${parsedMessage.sourceName}`, 0, -1001);
// multi.zRemRangeByRank(`z:messages:everywhere`, 0, -5001);
// multi.zRemRangeByRank(`z:markers:all`, 0, -1001);
```

### Security Notes

1. Do not leave `ALLOWED_ORIGINS=*` in production.
2. Consider adding an auth token (query param or header) if you need restricted access.
3. Room whitelist prevents uncontrolled memory usage from arbitrary room creation.

---

## Load Testing

`load-test.js` simulates Mylaps `Passing` traffic against the TCP listener so you can benchmark throughput. It reads chip numbers from whichever bib file it finds first: `bibs2025_enhanced.json`, `bibs2024_enhanced.json`, `bib2024.json`, `bib2023.json`.

```
node load-test.js [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--count` | `100` | Number of chips/bibs to send |
| `--host` | `127.0.0.1` | TCP target host |
| `--port` | `3389` | TCP target port |
| `--mode` | `burst` | `burst` (pack records into as few messages as possible) or `stream` (one message per chip) |
| `--distribute` | `roundrobin` | How chips are spread across rooms — see below |
| `--rooms` | `TimeFinish,TimeR1,TimeES,TimeEB` | Comma-separated list of rooms to send to |
| `--room` | — | Shorthand for a single room (overridden by `--rooms`) |
| `--delay` | `0` | Milliseconds to wait between messages in `stream` mode |
| `--repeat` | `1` | How many times to repeat the whole batch |

### Distribution modes

* **`roundrobin`** — chips are interleaved evenly across all rooms, simulating simultaneous activity at every timing point.
  * `burst`: one message per room, each containing its share of chips.
  * `stream`: each successive message alternates to the next room.
* **`wave`** — the full set of chips is sent to one room at a time, in order, simulating a field of runners passing each timing point in sequence (e.g. everyone crosses `TimeFinish`, then `TimeR1`, then `TimeES`, then `TimeEB`).
  * `burst`: one big message per room, sent sequentially.
  * `stream`: every chip streamed through room 1, then every chip through room 2, etc.

### Examples

```bash
# 100 bibs split evenly across the 4 default rooms, sent as 4 burst messages
node load-test.js --count 100

# Same, but one message per bib, alternating rooms
node load-test.js --count 100 --mode stream --distribute roundrobin

# Simulate a race: full field of 500 through each timing point in sequence
node load-test.js --count 500 --distribute wave --repeat 3

# Target only one room
node load-test.js --count 100 --room TimeFinish

# Target a custom subset of rooms
node load-test.js --count 100 --rooms TimeFinish,TimeR1

# Against a remote server
node load-test.js --host example.com --port 3389 --count 1000
```

---

## Start Remote Server

```
sudo systemctl start redis-server
sudo systemctl enable redis-server
sudo node server.js   # or: sudo pm2 start server
```
=======

#### Start remote server:
* `sudo systemctl start redis-server`
* `sudo systemctl enable redis-server`
* `sudo node server.js` of `sudo pm2 start server`
