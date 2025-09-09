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

## Start Remote Server

```
sudo systemctl start redis-server
sudo systemctl enable redis-server
sudo node server.js   # or: sudo pm2 start server
```