const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
require('dotenv').config(); // Cargar variables de entorno desde el archivo .env

const app = express();
app.use(express.json()); // Para manejar el cuerpo de solicitudes POST

// Variable para almacenar el XML generado
let latestXml = {
    bus_1: null,
    bus_2: null,
    bus_3: null,
    bus_4: null,
    bus_5: null,
    bus_6: null,
};

// Matrículas de los buses
const buses = {
    bus_1: 'BVU044',
    bus_2: 'HFO904',
    bus_3: 'GQP413',
    bus_4: 'FMD808',
    bus_5: 'DPH418',
    bus_6: 'FXT634',
};

// Función para obtener las ubicaciones desde el proxy de WordPress
async function obtenerUbicacionesDesdeProxy() {
    try {
        console.log('Solicitando datos al proxy de WordPress...');
        const response = await axios.post('https://proprop.com.ar/wp-json/custom-api/v1/triangulation/', null, {
            headers: {
                'X-API-Key': process.env.PROXY_API_KEY,
            },
        });
        console.log('Datos recibidos del proxy:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error al obtener datos del proxy:', error);
        throw error;
    }
}

// Función para extraer datos y generar el XML
async function extractDataAndGenerateXML() {
    try {
        const positions = await obtenerUbicacionesDesdeProxy();

        for (const [busKey, matricula] of Object.entries(buses)) {
            const position = positions[matricula];

            if (position) {
                const direccionTruncada = position.split(',').slice(0, 2).join(',').trim();

                const xml = xmlbuilder.create('Response')
                    .ele('Say', {}, direccionTruncada)
                    .up()
                    .ele('Redirect', { method: 'POST' }, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
                    .end({ pretty: true });

                console.log(`XML generado para ${busKey}:\n${xml}`);
                latestXml[busKey] = xml;
            } else {
                const xml = xmlbuilder.create('Response')
                    .ele('Say', {}, 'Lo sentimos, no se pudo obtener la información en este momento. Por favor, intente nuevamente más tarde.')
                    .up()
                    .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
                    .end({ pretty: true });

                latestXml[busKey] = xml;
            }
        }
    } catch (error) {
        console.error('Error al extraer los datos:', error);
    }
}

// Manejo de la solicitud POST para actualizar el XML de todos los buses
app.post('/update', async (req, res) => {
    console.log('Solicitud POST entrante para actualizar los XML de todos los buses');
    try {
        await extractDataAndGenerateXML();
        res.status(200).send({ message: 'Solicitud recibida, XML de los buses se está actualizando.' });
    } catch (error) {
        console.error('Error al actualizar los XML de los buses:', error);
        res.status(500).send({ message: 'Error al actualizar los XML.' });
    }
});

// Manejo de las solicitudes GET para cada bus
app.get('/voice/:busKey', (req, res) => {
    const busKey = req.params.busKey;
    console.log(`Solicitud entrante a /voice/${busKey}`);

    if (!buses.hasOwnProperty(busKey)) {
        return res.status(400).send({ message: 'Bus key no válida' });
    }

    if (latestXml[busKey]) {
        res.type('application/xml');
        res.send(latestXml[busKey]);
    } else {
        const xml = xmlbuilder.create('Response')
            .ele('Say', {}, 'Lo sentimos, no se pudo obtener la información en este momento. Por favor, intente nuevamente más tarde.')
            .up()
            .ele('Redirect', { method: 'POST' }, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
            .end({ pretty: true });

        res.type('application/xml');
        res.send(xml);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    await extractDataAndGenerateXML();
});