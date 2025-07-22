const express    = require('express');
const axios      = require('axios');
const xmlbuilder = require('xmlbuilder');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const MAX_XML_AGE_MINUTES = Number(process.env.MAX_XML_AGE_MINUTES) || 10;

const buses = {
    bus_1: 'BVU044',
    bus_2: 'HFO904',
    bus_3: 'GQP413',
    bus_4: 'FMD808',
    bus_5: 'DPH418',
    bus_6: 'FXT634',
};

const latestXml = {};
for (const key of Object.keys(buses)) {
    latestXml[key] = { xml: null, timestamp: null };
}

async function fetchLocationsFromProxy() {
    const url = 'https://proprop.com.ar/wp-json/custom-api/v1/triangulation/';
    const response = await axios.post(
        url,
        null,
        { headers: { 'X-API-Key': process.env.PROXY_API_KEY }, timeout: 10_000 }
    );
    return response.data;
}

function buildXml(text) {
    return xmlbuilder.create('Response')
        .ele('Say', {}, text)
        .up()
        .ele('Redirect', { method: 'POST' }, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
        .end({ pretty: true });
}

async function updateAllBusXml() {
    try {
        const positions = await fetchLocationsFromProxy();
        for (const [busKey, plate] of Object.entries(buses)) {
            const position = positions[plate];
            if (!position || !position.trim()) continue;
            const now  = DateTime.now().setZone('America/Argentina/Buenos_Aires');
            const time = now.toFormat('HH:mm');
            const addr = position.split(',').slice(0, 2).join(',').trim();
            const speak = `${addr}, a las ${time}`;
            latestXml[busKey] = {
                xml: buildXml(speak),
                timestamp: now.toISO(),
            };
        }
    } catch (err) {
        console.error('Failed to refresh bus locations:', err.message);
    }
}

app.post('/update', async (_req, res) => {
    await updateAllBusXml();
    res.status(200).json({ message: 'Bus XML refresh initiated.' });
});

app.get('/voice/:busKey', (req, res) => {
    const { busKey } = req.params;
    if (!Object.prototype.hasOwnProperty.call(buses, busKey)) {
        return res.status(400).json({ message: 'Invalid bus key' });
    }
    const record = latestXml[busKey];
    if (record?.xml) {
        const ageMin = record.timestamp ? (Date.now() - Date.parse(record.timestamp)) / 60000 : null;
        if (ageMin !== null && ageMin > MAX_XML_AGE_MINUTES) {
            console.warn(`${busKey} data is stale (${ageMin.toFixed(1)} min old) – serving anyway`);
        }
        return res.type('application/xml').send(record.xml);
    }
    const xml = buildXml('Aún no hay datos disponibles. Intente nuevamente en unos instantes.');
    res.type('application/xml').send(xml);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`Server listening on port ${PORT}`);
    await updateAllBusXml();
});