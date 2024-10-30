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
};

// Matrículas de los buses
const buses = {
    bus_1: 'GQP413',
    bus_2: 'DPH418',
    bus_3: 'FMD808',
};

// Credenciales para autenticación en la API
const apiCredentials = {
    username: process.env.API_USERNAME,
    password: process.env.API_PASSWORD,
};

// Variables para caché del token
let cachedToken = null;
let tokenExpirationTime = 0;

// Función para obtener el token de autenticación con caché
async function obtenerToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpirationTime) {
        return cachedToken;
    }

    try {
        const response = await axios.post('https://apiavl.easytrack.com.ar/sessions/auth/', {
            username: apiCredentials.username,
            password: apiCredentials.password,
        });

        cachedToken = response.data.jwt;
        tokenExpirationTime = now + 60 * 60 * 1000; // Asumimos que el token dura 1 hora
        return cachedToken;
    } catch (error) {
        console.error('Error en la autenticación con la API:');
        if (error.response) {
            // El servidor respondió con un código de estado fuera del rango 2xx
            console.error(`Error en la respuesta de la API: Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // La solicitud fue hecha pero no hubo respuesta
            console.error('No se recibió respuesta de la API:', error.request);
        } else {
            // Otro tipo de error, como un error de configuración
            console.error('Error en la configuración de la solicitud:', error.message);
        }
        console.error('Configuración de la solicitud que falló:', error.config);
        throw new Error('Error en la autenticación');
    }
}

// Función para obtener la ubicación de un bus a partir de su matrícula
async function obtenerUbicacionBus(token, matricula) {
    try {
        const response = await axios.get(`https://apiavl.easytrack.com.ar/positions/${matricula}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        const busData = response.data[0]; // Tomamos el primer elemento del array
        if (busData && busData.position) {
            const direccionTruncada = busData.position.split(',').slice(0, 2).join(',').trim();
            console.log(`Matrícula ${matricula} - Dirección: ${direccionTruncada}`);
            return { success: true, text: direccionTruncada };
        } else {
            console.log(`No se encontró la dirección para la matrícula ${matricula}.`);
            return { success: false, text: '' };
        }
    } catch (error) {
        console.error(`Error al obtener la ubicación del bus ${matricula}:`);
        if (error.response) {
            console.error(`Error en la respuesta de la API: Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error('No se recibió respuesta de la API:', error.request);
        } else {
            console.error('Error en la configuración de la solicitud:', error.message);
        }
        console.error('Configuración de la solicitud que falló:', error.config);
        return { success: false, text: '' };
    }
}

// Función para extraer datos de los buses y generar el XML
async function extractDataAndGenerateXML() {
    try {
        console.log('Obteniendo token de autenticación...');
        const token = await obtenerToken();

        const busEntries = Object.entries(buses);

        // Paralelizar las solicitudes
        const results = await Promise.all(
            busEntries.map(async ([key, matricula]) => {
                console.log(`Buscando la ubicación de la matrícula ${matricula}...`);
                const result = await obtenerUbicacionBus(token, matricula);
                return { key, result };
            })
        );

        results.forEach(({ key, result }) => {
            if (result.success) {
                // Generar el XML correspondiente
                const xml = xmlbuilder.create('Response')
                    .ele('Say', {}, result.text)
                    .up()
                    .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
                    .end({ pretty: true });

                console.log(`XML generado para ${key}:\n${xml}`);
                latestXml[key] = xml;
            } else {
                // Generar un XML de error en caso de no obtener la ubicación
                const xml = xmlbuilder.create('Response')
                    .ele('Say', {}, 'Lo sentimos, no se pudo obtener la información en este momento. Por favor, intente nuevamente más tarde.')
                    .up()
                    .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
                    .end({ pretty: true });

                latestXml[key] = xml;
            }
        });
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
        // Generar un XML de error en caso de no tener datos recientes
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
    // Actualizar los XML por primera vez después del despliegue
    await extractDataAndGenerateXML();
});