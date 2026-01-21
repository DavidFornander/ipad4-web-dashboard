const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const protobuf = require('protobufjs');
const AdmZip = require('adm-zip');

// Load .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  });
}

const app = express();
const PORT = 8083;

// Trafiklab API keys
const TRAFIKLAB_API_KEY = process.env.TRAFIKLAB_API_KEY || '';
const TRAFIKLAB_STATIC_KEY = process.env.TRAFIKLAB_STATIC_KEY || TRAFIKLAB_API_KEY;

// Local cache path for GTFS static data
const GTFS_CACHE_PATH = path.join(__dirname, '.gtfs-cache.json');

// Bounding boxes
const BOUNDS = {
  sodermalm: {
    north: 59.33,
    south: 59.30,
    east: 18.10,
    west: 18.02
  },
  stockholm: {
    north: 59.42,
    south: 59.25,
    east: 18.20,
    west: 17.85
  }
};

// Vehicle positions cache (per bounds)
let vehicleCache = {
  sodermalm: { data: null, timestamp: 0 },
  stockholm: { data: null, timestamp: 0 }
};
const CACHE_TTL_MS = 15000; // 15 seconds - allows 30s polling during rush

// GTFS static data lookup: trip_id -> { routeShortName, routeType }
let gtfsLookup = { trips: {}, routes: {} };
let gtfsLoaded = false;

// Parse CSV line handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Load GTFS static data to get trip -> route mapping
async function loadGTFSStaticData() {
  // Try loading from local cache first
  if (fs.existsSync(GTFS_CACHE_PATH)) {
    try {
      console.log('Loading GTFS data from local cache...');
      const cached = JSON.parse(fs.readFileSync(GTFS_CACHE_PATH, 'utf8'));
      gtfsLookup = cached;
      gtfsLoaded = true;
      console.log(`Loaded ${Object.keys(gtfsLookup.routes).length} routes, ${Object.keys(gtfsLookup.trips).length} trips from cache`);
      return;
    } catch (e) {
      console.error('Cache load failed, will download fresh:', e.message);
    }
  }

  if (!TRAFIKLAB_STATIC_KEY) {
    console.log('No TRAFIKLAB_STATIC_KEY set, skipping GTFS static data');
    return;
  }

  try {
    console.log('Fetching GTFS static data (this is cached locally, only done once)...');
    const url = `https://opendata.samtrafiken.se/gtfs/sl/sl.zip?key=${TRAFIKLAB_STATIC_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('Failed to fetch GTFS static data:', response.status);
      return;
    }

    const buffer = await response.buffer();
    const zip = new AdmZip(buffer);

    // Parse routes.txt: route_id -> route_short_name, route_type
    const routesEntry = zip.getEntry('routes.txt');
    if (routesEntry) {
      const routesData = routesEntry.getData().toString('utf8');
      const lines = routesData.split('\n');
      const headers = parseCSVLine(lines[0]);
      const routeIdIdx = headers.indexOf('route_id');
      const shortNameIdx = headers.indexOf('route_short_name');
      const routeTypeIdx = headers.indexOf('route_type');

      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseCSVLine(lines[i]);
        const routeId = cols[routeIdIdx];
        gtfsLookup.routes[routeId] = {
          shortName: cols[shortNameIdx] || '?',
          type: parseInt(cols[routeTypeIdx]) || 3
        };
      }
      console.log(`Loaded ${Object.keys(gtfsLookup.routes).length} routes`);
    }

    // Parse trips.txt: trip_id -> route_id
    const tripsEntry = zip.getEntry('trips.txt');
    if (tripsEntry) {
      const tripsData = tripsEntry.getData().toString('utf8');
      const lines = tripsData.split('\n');
      const headers = parseCSVLine(lines[0]);
      const tripIdIdx = headers.indexOf('trip_id');
      const routeIdIdx = headers.indexOf('route_id');

      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseCSVLine(lines[i]);
        const tripId = cols[tripIdIdx];
        const routeId = cols[routeIdIdx];
        gtfsLookup.trips[tripId] = routeId;
      }
      console.log(`Loaded ${Object.keys(gtfsLookup.trips).length} trips`);
    }

    // Save to local cache
    fs.writeFileSync(GTFS_CACHE_PATH, JSON.stringify(gtfsLookup));
    console.log('GTFS data cached locally to .gtfs-cache.json');

    gtfsLoaded = true;
    console.log('GTFS static data loaded successfully');
  } catch (error) {
    console.error('Error loading GTFS static data:', error.message);
  }
}

// Get line info from trip ID
function getLineInfo(tripId) {
  if (!tripId || !gtfsLoaded) return { line: '?', type: 3 };
  const routeId = gtfsLookup.trips[tripId];
  if (!routeId) return { line: '?', type: 3 };
  const route = gtfsLookup.routes[routeId];
  if (!route) return { line: '?', type: 3 };
  return { line: route.shortName, type: route.type };
}

// GTFS-RT protobuf definition (embedded for simplicity)
const GTFS_RT_PROTO = `
syntax = "proto2";
package transit_realtime;

message FeedMessage {
  required FeedHeader header = 1;
  repeated FeedEntity entity = 2;
}

message FeedHeader {
  required string gtfs_realtime_version = 1;
  optional uint64 timestamp = 2;
}

message FeedEntity {
  required string id = 1;
  optional bool is_deleted = 2 [default = false];
  optional TripUpdate trip_update = 3;
  optional VehiclePosition vehicle = 4;
  optional Alert alert = 5;
}

message TripUpdate {
  optional TripDescriptor trip = 1;
  optional VehicleDescriptor vehicle = 3;
}

message VehiclePosition {
  optional TripDescriptor trip = 1;
  optional VehicleDescriptor vehicle = 8;
  optional Position position = 2;
  optional uint32 current_stop_sequence = 3;
  optional string stop_id = 7;
  optional VehicleStopStatus current_status = 4 [default = IN_TRANSIT_TO];
  optional uint64 timestamp = 5;
  optional CongestionLevel congestion_level = 6;
  optional OccupancyStatus occupancy_status = 9;
}

message Alert {
  repeated TimeRange active_period = 1;
  repeated EntitySelector informed_entity = 5;
}

message TimeRange {
  optional uint64 start = 1;
  optional uint64 end = 2;
}

message EntitySelector {
  optional string agency_id = 1;
  optional string route_id = 2;
  optional int32 route_type = 3;
  optional TripDescriptor trip = 4;
  optional string stop_id = 5;
}

message TripDescriptor {
  optional string trip_id = 1;
  optional string route_id = 5;
  optional uint32 direction_id = 6;
  optional string start_time = 2;
  optional string start_date = 3;
}

message VehicleDescriptor {
  optional string id = 1;
  optional string label = 2;
  optional string license_plate = 3;
}

message Position {
  required float latitude = 1;
  required float longitude = 2;
  optional float bearing = 3;
  optional double odometer = 4;
  optional float speed = 5;
}

enum VehicleStopStatus {
  INCOMING_AT = 0;
  STOPPED_AT = 1;
  IN_TRANSIT_TO = 2;
}

enum CongestionLevel {
  UNKNOWN_CONGESTION_LEVEL = 0;
  RUNNING_SMOOTHLY = 1;
  STOP_AND_GO = 2;
  CONGESTION = 3;
  SEVERE_CONGESTION = 4;
}

enum OccupancyStatus {
  EMPTY = 0;
  MANY_SEATS_AVAILABLE = 1;
  FEW_SEATS_AVAILABLE = 2;
  STANDING_ROOM_ONLY = 3;
  CRUSHED_STANDING_ROOM_ONLY = 4;
  FULL = 5;
  NOT_ACCEPTING_PASSENGERS = 6;
}
`;

// Load protobuf definition
let FeedMessage = null;
protobuf.parse(GTFS_RT_PROTO).root.resolveAll();
FeedMessage = protobuf.parse(GTFS_RT_PROTO).root.lookupType('transit_realtime.FeedMessage');

// Check if position is within bounds
function isInBounds(lat, lng, bounds) {
  return lat >= bounds.south &&
         lat <= bounds.north &&
         lng >= bounds.west &&
         lng <= bounds.east;
}

// Serve static files from 'public' directory
app.use(express.static('public'));

function formatDeparturesHtml(data) {
  const timestamp = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let html = '';

  if (!data.departures || data.departures.length === 0) {
    html = '<div class="departure">No departures found</div>';
    html += `<div class="update-time" hx-swap-oob="true" id="footer-update">Last updated: ${timestamp}</div>`;
    return html;
  }

  const now = new Date();
  const filteredDepartures = data.departures.filter(dep => {
    const expectedTime = new Date(dep.expected);
    const diffMinutes = (expectedTime - now) / (1000 * 60);
    return diffMinutes >= 5;
  });

  if (filteredDepartures.length === 0) {
    html = '<div class="departure">No departures found (>5 min)</div>';
    html += `<div class="update-time" hx-swap-oob="true" id="footer-update">Last updated: ${timestamp}</div>`;
    return html;
  }

  const groups = {
    'METRO': [],
    'BUS': [],
    'TRAIN': [],
    'TRAM': [],
    'SHIP': []
  };

  filteredDepartures.forEach(dep => {
    const mode = dep.line.transport_mode;
    if (groups[mode]) {
      groups[mode].push(dep);
    } else {
      if (!groups['OTHER']) groups['OTHER'] = [];
      groups['OTHER'].push(dep);
    }
  });

  const modeNames = {
    'METRO': 'Tunnelbana',
    'BUS': 'Bussar',
    'TRAIN': 'Pendeltåg',
    'TRAM': 'Spårvagn',
    'SHIP': 'Båt',
    'OTHER': 'Övrigt'
  };

  // Find the longest list to synchronize scrolling
  const activeModes = Object.entries(groups).filter(([_, deps]) => deps.length > 0);
  const maxCount = activeModes.reduce((max, [_, deps]) => Math.max(max, deps.length), 0);
  const shouldAnimate = maxCount > 5;
  const syncDuration = (maxCount + 1) * 4; // 4 seconds per item for faster speed

  for (const [mode, departures] of Object.entries(groups)) {
    if (departures.length > 0) {
      html += `<div class="mode-column mode-${mode}">`;
      html += `<h2 class="mode-header">${modeNames[mode] || mode}</h2>`;
      html += `<div class="scroll-area">`;

      let departureItems = departures.map(dep => {
        let color = '#333';
        if (mode === 'METRO') {
          color = '#dc2626'; // Red
        } else if (mode === 'BUS') {
          const lineNum = parseInt(dep.line.designation);
          if (!isNaN(lineNum) && lineNum < 10) {
            color = '#2563eb'; // Blue
          } else {
            color = '#dc2626'; // Red
          }
        }

        return `
                <div class="departure" style="border-left-color: ${color}">
                    <div style="display: flex; align-items: center;">
                        <span class="line-number" style="background-color: ${color}">${dep.line.designation}</span>
                        <span class="destination">${dep.destination}</span>
                    </div>
                    <span class="time">${dep.display}</span>
                </div>
            `;
      }).join('');

      // Pad with blanks if shorter than maxCount
      if (shouldAnimate && departures.length < maxCount) {
        const paddingCount = maxCount - departures.length;
        for (let i = 0; i < paddingCount; i++) {
          departureItems += `
                <div class="departure" style="border-left-color: #222; background: #111; opacity: 0.3;">
                    <div style="display: flex; align-items: center;">
                        <span class="line-number" style="background-color: #222; color: #222;">---</span>
                        <span class="destination" style="color: #333;">-</span>
                    </div>
                    <span class="time" style="color: #333;">-</span>
                </div>
            `;
        }
      }

      const loopSeparator = `<div class="loop-separator"><span>UPPDATERAD ${timestamp}</span></div>`;

      // Duplicate items for seamless loop if there are enough of them
      const content = shouldAnimate ? (departureItems + loopSeparator) + (departureItems + loopSeparator) : departureItems;
      const animationClass = shouldAnimate ? 'animate-scroll' : '';
      const syncDuration = (maxCount + 1) * 4; // 4 seconds per item for faster speed

      html += `<div class="scroll-content ${animationClass}" style="animation-duration: ${syncDuration}s">${content}</div>`;
      html += `</div></div>`;
    }
  }

  html += `<div class="update-time" hx-swap-oob="true" id="footer-update">Last updated: ${timestamp}</div>`;

  return html;
}// API Proxy
app.get('/api/departures', async (req, res) => {
  try {
    const siteId = req.query.siteId || '9296'; // Zinkensdamm
    const url = `https://transport.integration.sl.se/v1/sites/${siteId}/departures?transport_authority_id=1&forecast=60`;

    console.log(`Fetching: ${url}`);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`SL API responded with ${response.status}`);
    }

    const data = await response.json();

    // Check if client wants HTML (HTMX request)
    if (req.headers['hx-request']) {
      res.send(formatDeparturesHtml(data));
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('API Error:', error);
    if (req.headers['hx-request']) {
      res.status(500).send(`<div class="error">Error: ${error.message}</div>`);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Vehicle positions API for live map
app.get('/api/vehicles', async (req, res) => {
  try {
    if (!TRAFIKLAB_API_KEY) {
      return res.status(500).json({
        error: 'TRAFIKLAB_API_KEY environment variable not set',
        hint: 'Get a free API key from trafiklab.se for GTFS Regional'
      });
    }

    // Get bounds from query param (default to sodermalm)
    const boundsName = req.query.bounds === 'stockholm' ? 'stockholm' : 'sodermalm';
    const bounds = BOUNDS[boundsName];
    const cache = vehicleCache[boundsName];

    // Check cache
    const now = Date.now();
    if (cache.data && (now - cache.timestamp) < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const url = `https://opendata.samtrafiken.se/gtfs-rt/sl/VehiclePositions.pb?key=${TRAFIKLAB_API_KEY}`;
    console.log(`Fetching vehicle positions (${boundsName})...`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Trafiklab API responded with ${response.status}`);
    }

    const buffer = await response.buffer();
    const message = FeedMessage.decode(buffer);
    const feed = FeedMessage.toObject(message, { defaults: true });

    // Filter and transform vehicles
    const vehicles = [];
    for (const entity of feed.entity || []) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;

      const lat = v.position.latitude;
      const lng = v.position.longitude;

      // Filter to selected bounds
      if (!isInBounds(lat, lng, bounds)) continue;

      const lineInfo = getLineInfo(v.trip?.tripId);
      vehicles.push({
        id: entity.id,
        lat: lat,
        lng: lng,
        bearing: v.position.bearing || 0,
        speed: v.position.speed || 0,
        line: v.vehicle?.label || lineInfo.line,
        routeType: lineInfo.type,
        tripId: v.trip?.tripId || null,
        timestamp: v.timestamp ? Number(v.timestamp) : null
      });
    }

    // Limit vehicles for performance (more for wider area)
    const limit = boundsName === 'stockholm' ? 200 : 100;
    const limitedVehicles = vehicles.slice(0, limit);

    // Update cache for this bounds
    vehicleCache[boundsName] = { data: limitedVehicles, timestamp: now };

    res.json(limitedVehicles);
  } catch (error) {
    console.error('Vehicle API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Dashboard server running at http://0.0.0.0:${PORT}`);
  // Load GTFS static data in background for trip -> line mapping
  loadGTFSStaticData();
});
