const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const MAX_XML_AGE_MINUTES = Number(process.env.MAX_XML_AGE_MINUTES) || 10;

const buses = {
    bus_1: 'BVU044',
    bus_2: 'HFO904',
    bus_3: 'FBG600',
    bus_4: 'FMD808',
    bus_5: 'DPH418',
    bus_6: 'FXT634',
};

const latestXml = {};
for (const key of Object.keys(buses)) {
    latestXml[key] = { xml: null, timestamp: null, addr: null, ts: null };
}

async function fetchLocationsFromProxy() {
    const url = 'https://proprop.com.ar/wp-json/custom-api/v1/triangulation/';
    console.log('[FETCH] Solicitando datos al proxy de WordPress…');
    const response = await axios.post(
        url,
        null,
        { headers: { 'X-API-Key': process.env.PROXY_API_KEY }, timeout: 10_000 }
    );
    console.log('[FETCH] Datos recibidos del proxy');
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
    console.log('[UPDATE] Iniciando actualización de ubicaciones…');
    const t0 = Date.now();
    try {
        const positions = await fetchLocationsFromProxy();
        let updatedCount = 0;
        let skippedCount = 0;

        for (const [busKey, plate] of Object.entries(buses)) {
            const rec = positions[plate];
            let addr = '';
            let tsStr = null;

            if (typeof rec === 'string') {
                addr = rec.trim();
            } else if (rec && typeof rec === 'object') {
                addr = (rec.addr || '').trim();
                tsStr = rec.ts || null;
            }

            if (!addr) {
                console.warn(`[SKIP] ${busKey} (${plate}) sin dirección válida`);
                skippedCount++;
                continue;
            }

            const prev = latestXml[busKey];
            const isUnchanged = addr === prev.addr && tsStr === prev.ts;

            console.log(`[UPDATE] ${busKey} – dirección: "${addr}", ts: ${tsStr || 'N/A'}${isUnchanged ? ' (sin cambios)' : ''}`);

            if (isUnchanged) {
                skippedCount++;
                continue;
            }

            const timeDt = tsStr
                ? DateTime.fromISO(tsStr).setZone('America/Argentina/Buenos_Aires')
                : DateTime.now().setZone('America/Argentina/Buenos_Aires');
            const time = timeDt.toFormat('HH:mm');
            const shortAddr = addr.split(',').slice(0, 2).join(',').trim();
            const speak = `${shortAddr}, a las ${time}`;

            latestXml[busKey] = {
                xml: buildXml(speak),
                timestamp: Date.now(),
                addr,
                ts: tsStr,
            };

            console.log(`[UPDATE] XML actualizado para ${busKey} (${plate})`);
            updatedCount++;
        }

        const duration = Date.now() - t0;
        console.log(`[UPDATE] Finalizada en ${duration} ms – actualizados: ${updatedCount}, sin cambios: ${skippedCount}`);
    } catch (err) {
        console.error('[ERROR] Falló la actualización de ubicaciones:', err.message);
    }
}

app.post('/update', async (_req, res) => {
    console.log('[HTTP] POST /update recibido');
    await updateAllBusXml();
    res.status(200).json({ message: 'Bus XML refresh initiated.' });
});

app.get('/voice/:busKey', (req, res) => {
    const { busKey } = req.params;
    console.log(`[HTTP] GET /voice/${busKey} solicitado`);
    if (!Object.prototype.hasOwnProperty.call(buses, busKey)) {
        console.warn(`[HTTP] ${busKey} inválido`);
        return res.status(400).json({ message: 'Invalid bus key' });
    }
    const record = latestXml[busKey];
    if (record?.xml) {
        const ageMin = record.timestamp ? (Date.now() - record.timestamp) / 60000 : null;
        if (ageMin !== null && ageMin > MAX_XML_AGE_MINUTES) {
            console.warn(`[STALE] ${busKey} datos de ${ageMin.toFixed(1)} min atrás – sirviendo igual`);
        }
        return res.type('application/xml').send(record.xml);
    }
    const xml = buildXml('Aún no hay datos disponibles. Intente nuevamente en unos instantes.');
    res.type('application/xml').send(xml);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`[BOOT] Servidor escuchando en el puerto ${PORT}`);
    await updateAllBusXml();
});