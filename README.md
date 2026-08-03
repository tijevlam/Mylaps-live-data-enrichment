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

## Finisher Counters (Socket.IO)

Reliable, dedup'd counters for finish-line passings, broadcast alongside the
existing `new message` stream. This is purely additive — it does not change
`initial data`, `new message`, rooms, or anything documented above.

Every bib is counted **once** the first time it crosses the finish mat
(`sourceName === 'TimeFinish'`, or whatever `FINISH_SOURCE_NAME` is set to).
Duplicate reads (double beeps, retried messages) never increment the counters
twice — the dedup happens atomically server-side.

For every counted finisher, four **dimensions** are tracked:

| Dimension        | Meaning                                    | Example key            |
|-------------------|---------------------------------------------|-------------------------|
| `overall`         | Total finishers, no breakdown                | —                       |
| `distance`        | Per `raceType` (e.g. `"long distance"`)      | `"long distance"`       |
| `gender`          | Per `gender` (e.g. `"Male"` / `"Female"`)     | `"Female"`              |
| `distanceGender`  | Per distance **and** gender combined         | `"long distance\|Female"` |

Each dimension is reported twice:
* **`counters`** — the live count since the last reset (see `reset-finisher-counters.js`).
* **`allTime`** — `counters` plus a historical base offset (see `finisher-counters-config.json`), i.e. the "ever" total. This is what you want for "you are the xxx-th finisher ever" messaging.

### Events

| Event Name                   | Direction        | When | Description |
|-------------------------------|------------------|------|--------------|
| `initial finisher counters`   | server → client  | On connect | Full current snapshot of all counters (`counters` + `allTime`), so a freshly-loaded page isn't blank until the next finisher. |
| `finisher counters`           | server → client  | Every time a new (non-duplicate) finisher is counted | That finisher's identity plus their updated `counters`/`allTime` in every dimension. |
| `special finish`              | server → client  | Only when a finisher's `allTime` count in some dimension exactly matches a configured milestone | Same payload as `finisher counters`, plus a `specialFinishes` array describing which milestone(s) were hit. Use this to trigger a celebratory banner without inspecting every `finisher counters` event. |

No extra query params or room joins are required — these fire on whatever
room you're already connected to (see "Rooms" above); joining `TimeFinish` or
`everywhere` both work.

### Payload shapes

**`initial finisher counters`** (emitted once, right after connecting):

```json
{
  "finish": {
    "counters": {
      "overall": 238,
      "distance": { "long distance": 150, "middle distance": 88, "unknown": 0 },
      "gender": { "Male": 130, "Female": 108, "unknown": 0 },
      "distanceGender": { "long distance|Male": 90, "long distance|Female": 60, "...": 0 }
    },
    "allTime": {
      "overall": 30000,
      "distance": { "long distance": 20150, "middle distance": 9850, "unknown": 0 },
      "gender": { "Male": 15630, "Female": 14370, "unknown": 0 },
      "distanceGender": { "long distance|Male": 10590, "long distance|Female": 9560, "...": 0 }
    }
  }
}
```

`"finish"` is the counter-event name (there's only one today, but the key lets
more be added later without breaking clients that read `data.finish`).

**`finisher counters`** (emitted per counted finisher):

```json
{
  "event": "finish",
  "sourceName": "TimeFinish",
  "bib": "1042",
  "chip": "VG46373",
  "name": "Yaron Danieli",
  "gender": "Male",
  "raceType": "long distance",
  "counters": { "overall": 238, "distance": 150, "gender": 130, "distanceGender": 90 },
  "allTime":  { "overall": 30000, "distance": 20150, "gender": 15630, "distanceGender": 10590 },
  "timestamp": 1751234567890
}
```

Note `counters`/`distance`/`gender`/`distanceGender` here are single numbers
(this finisher's own rank in that dimension), unlike the nested object shape
in `initial finisher counters` (which reports every group's count).
`bib`/`chip`/`name`/`gender`/`raceType` can be `null` if the chip wasn't
matched to a known bib.

**`special finish`** (same shape as `finisher counters`, plus):

```json
{
  "...": "...same fields as finisher counters...",
  "specialFinishes": [
    { "dimension": "overall", "group": "_all", "target": 30000, "label": "30,000th finisher ever!" }
  ]
}
```

`specialFinishes` is an array because one finisher can hit more than one
milestone at once (e.g. an overall milestone and a gender milestone on the
same finish).

### Example: frontend integration

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
  const socket = io('https://YOUR_DEPLOYMENT_HOST', {
    query: { roomName: 'TimeFinish' } // or 'everywhere'
  });

  // Snapshot on load — use this to populate the UI before the first live event.
  socket.on('initial finisher counters', (snapshot) => {
    console.log('Current totals:', snapshot.finish.counters);
    console.log('All-time totals:', snapshot.finish.allTime);
  });

  // Fires once per new (deduplicated) finisher.
  socket.on('finisher counters', (update) => {
    console.log(
      `${update.name || update.bib} is finisher #${update.counters.overall} today ` +
      `(#${update.allTime.overall} ever), ` +
      `#${update.counters.distanceGender} on ${update.raceType} for ${update.gender}s ` +
      `(#${update.allTime.distanceGender} ever).`
    );
  });

  // Fires only on milestone finishes — good for a banner/confetti moment.
  socket.on('special finish', (update) => {
    // Optional: vibrate on supporting devices (mostly Android; iOS Safari has
    // no Vibration API at all, so `navigator.vibrate` is simply undefined
    // there — the `if` guard skips it silently instead of throwing).
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 400]); // buzz-pause-buzz-pause-buzz (ms)
    }

    for (const milestone of update.specialFinishes) {
      showConfetti(); // your own confetti trigger
      alert(`${update.name || 'Someone'} is ${milestone.label}`);
    }
  });
</script>
```

> **Mobile vibration note:** `navigator.vibrate()` only works on browsers that
> implement the Vibration API (mainly Android Chrome/Firefox). iOS Safari
> (including installed PWAs) never implements it, so on iPhone the confetti/
> banner will still show, just without the buzz.

### Configuration (backend/ops — not needed by the frontend)

| File / Command | Purpose |
|-----------------|---------|
| `finisher-counters-config.json` | `baseOffsets` (historical carry-over per dimension/group) and `specialFinishes` (milestones to flag). Edited before a new race, requires a server restart to take effect. See `finisher-counters-config.example.json`. |
| `node reset-finisher-counters.js --yes` | Resets live counters (`cnt:finish:*` in Redis) to 0 ahead of a new race. Does not touch message/marker history. |
| `FINISH_SOURCE_NAME` (env var) | Which `sourceName` counts as "finish". Defaults to `TimeFinish`. |

### Data Model (Redis) — finisher counters

| Key Pattern | Type | Contents |
|-------------|------|----------|
| `cnt:finish:seen` | Set | Bib/chip identities already counted (dedup) |
| `cnt:finish:overall` | String (int) | Live overall finisher count |
| `cnt:finish:distance:<raceType>` | String (int) | Live count per distance |
| `cnt:finish:gender:<gender>` | String (int) | Live count per gender |
| `cnt:finish:distance-gender:<raceType>\|<gender>` | String (int) | Live count per distance+gender |

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
