const express    = require('express');
const axios      = require('axios');
const xmlbuilder = require('xmlbuilder');
require('dotenv').config(); // Load environment variables

const app = express();
app.use(express.json()); // Handle JSON request bodies

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const MAX_XML_AGE_MINUTES = Number(process.env.MAX_XML_AGE_MINUTES) || 10; // Freshness threshold

// Registration numbers
const buses = {
    bus_1: 'BVU044',
    bus_2: 'HFO904',
    bus_3: 'GQP413',
    bus_4: 'FMD808',
    bus_5: 'DPH418',
    bus_6: 'FXT634',
};

// Holds latest XML and its timestamp for each bus
let latestXml = {};
Object.keys(buses).forEach(key => {
    latestXml[key] = { xml: null, timestamp: null };
});

// ─────────────────────────────────────────────────────────────
// Helper: request locations from WP proxy
// ─────────────────────────────────────────────────────────────
async function fetchLocationsFromProxy() {
    const url = 'https://proprop.com.ar/wp-json/custom-api/v1/triangulation/';

    console.log('Requesting data from WordPress proxy…');
    const response = await axios.post(url, null, {
        headers: { 'X-API-Key': process.env.PROXY_API_KEY },
        timeout: 10000,
    });
    console.log('Proxy data received:', response.data);
    return response.data;
}

// ─────────────────────────────────────────────────────────────
// Helper: generate XML for one bus
// ─────────────────────────────────────────────────────────────
function buildXml(text) {
    return xmlbuilder.create('Response')
        .ele('Say', {}, text)
        .up()
        .ele('Redirect', { method: 'POST' }, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
        .end({ pretty: true });
}

// ─────────────────────────────────────────────────────────────
// Core: update XML for every bus
// ─────────────────────────────────────────────────────────────
async function updateAllBusXml() {
    try {
        const positions = await fetchLocationsFromProxy();

        for (const [busKey, plate] of Object.entries(buses)) {
            const position = positions[plate];

            if (position && position.trim()) {
                const now   = new Date();
                const time  = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
                const date  = now.toLocaleDateString('es-AR');
                const addr  = position.split(',').slice(0, 2).join(',').trim();
                const speak = `${addr}, a las ${time} del ${date}`;

                latestXml[busKey] = {
                    xml: buildXml(speak),
                    timestamp: now.toISOString(),
                };

                console.log(`XML generated for ${busKey} (${plate})`);
            } else {
                // Position missing – store fallback with current timestamp
                latestXml[busKey] = {
                    xml: buildXml('Lo sentimos, no se pudo obtener la información en este momento. Por favor, intente nuevamente más tarde.'),
                    timestamp: new Date().toISOString(),
                };
                console.warn(`No position for ${busKey} (${plate}); stored fallback XML.`);
            }
        }
    } catch (err) {
        console.error('Failed to refresh bus locations:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// Route: manual refresh trigger (Twilio Studio hits this)
// ─────────────────────────────────────────────────────────────
app.post('/update', async (_req, res) => {
    console.log('POST /update received – refreshing all buses');
    await updateAllBusXml();
    res.status(200).json({ message: 'Bus XML refresh initiated.' });
});

// ─────────────────────────────────────────────────────────────
// Route: Twilio voice fetch per bus
// ─────────────────────────────────────────────────────────────
app.get('/voice/:busKey', (req, res) => {
    const { busKey } = req.params;
    console.log(`GET /voice/${busKey}`);

    if (!buses.hasOwnProperty(busKey)) {
        return res.status(400).json({ message: 'Invalid bus key' });
    }

    const record = latestXml[busKey];
    if (record.xml && record.timestamp) {
        const ageMinutes = (Date.now() - Date.parse(record.timestamp)) / 60000;

        if (ageMinutes <= MAX_XML_AGE_MINUTES) {
            res.type('application/xml').send(record.xml);
            return;
        }

        console.warn(`${busKey} data is stale (${ageMinutes.toFixed(1)} min old) – serving fallback`);
    }

    // Fallback if missing or stale
    const fallback = buildXml('En este momento no es posible conocer la ubicación. Intente de nuevo más tarde.');
    res.type('application/xml').send(fallback);
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await updateAllBusXml(); // Initial pre‑warm
});