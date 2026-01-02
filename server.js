const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

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
}); app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard server running at http://0.0.0.0:${PORT}`);
});
