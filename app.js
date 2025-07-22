const express    = require('express');
const axios      = require('axios');
const xmlbuilder = require('xmlbuilder');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

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
const latestXml = {};
for (const key of Object.keys(buses)) {
    latestXml[key] = { xml: null, timestamp: null };
}

// ─────────────────────────────────────────────────────────────
// Helper: request locations from WP proxy
// ─────────────────────────────────────────────────────────────
async function fetchLocationsFromProxy() {
    const url = 'https://proprop.com.ar/wp-json/custom-api/v1/triangulation/';

    console.log('Requesting data from WordPress proxy…');
    const response = await axios.post(
        url,
        null,
        { headers: { 'X-API-Key': process.env.PROXY_API_KEY }, timeout: 10_000 }
    );
    console.log('Proxy data received:', response.data);
    return response.data;
}

// ─────────────────────────────────────────────────────────────
// Helper: generate TwiML XML
// ─────────────────────────────────────────────────────────────
function buildXml(text) {
    return xmlbuilder.create('Response')
        .ele('Say', {}, text)
        .up()
        .ele('Redirect', { method: 'POST' }, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
        .end({ pretty: true });
}

// ─────────────────────────────────────────────────────────────
// Core: refresh XML for all buses
// ─────────────────────────────────────────────────────────────
async function updateAllBusXml() {
    try {
        const positions = await fetchLocationsFromProxy();

        for (const [busKey, plate] of Object.entries(buses)) {
            const position = positions[plate];
            if (!position || !position.trim()) {
                console.warn(`No fresh position for ${busKey} (${plate}); keeping previous data.`);
                continue; // keep previous XML and timestamp
            }

        const now  = DateTime.now().setZone('America/Argentina/Buenos_Aires');
        const time = now.toFormat('HH:mm');
        const date = now.toFormat('dd/MM/yyyy');
        const addr = position.split(',').slice(0, 2).join(',').trim();
        const speak = `${addr}, a las ${time} del ${date}`;

            latestXml[busKey] = {
                xml: buildXml(speak),
                timestamp: now.toISOString(),
            };

            console.log(`XML updated for ${busKey} (${plate})`);
        }
    } catch (err) {
        console.error('Failed to refresh bus locations:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// Route: manual refresh trigger (Twilio Studio can hit this)
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

    if (record?.xml) {
        const ageMin =
            record.timestamp ? (Date.now() - Date.parse(record.timestamp)) / 60000 : null;

        if (ageMin !== null && ageMin > MAX_XML_AGE_MINUTES) {
            console.warn(`${busKey} data is stale (${ageMin.toFixed(1)} min old) – serving anyway`);
        }

        res.type('application/xml').send(record.xml);
        return;
    }

    // No data yet (e.g. first call and proxy failed)
    const xml = buildXml('Aún no hay datos disponibles. Intente nuevamente en unos instantes.');
    res.type('application/xml').send(xml);
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await updateAllBusXml(); // Initial pre‑warm
});