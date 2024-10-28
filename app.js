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

// Credenciales para autenticación en la API (ahora usando variables de entorno)
const apiCredentials = {
    username: process.env.API_USERNAME,
    password: process.env.API_PASSWORD,
};

// Función para obtener el token de autenticación
async function obtenerToken() {
    try {
        const response = await axios.post('https://apiavl.easytrack.com.ar/sessions/auth/', {
            username: apiCredentials.username,
            password: apiCredentials.password,
        });

        return response.data.jwt; // Retornar el token JWT
    } catch (error) {
        console.error('Error de la API. El servidor no responde.');
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
        console.error(`Error de la API. El servidor no responde al obtener la ubicación del bus ${matricula}.`);
        return { success: false, text: '' };
    }
}

// Función para extraer datos de los buses y generar el XML
async function extractDataAndGenerateXML() {
    try {
        console.log('Obteniendo token de autenticación...');
        const token = await obtenerToken();

        for (const [key, matricula] of Object.entries(buses)) {
            console.log(`Buscando la ubicación de la matrícula ${matricula}...`);
            const result = await obtenerUbicacionBus(token, matricula);
            if (result.success) {
                // Generar el XML correspondiente
                const xml = xmlbuilder.create('Response')
                    .ele('Say', {}, result.text)
                    .up()
                    .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
                    .end({ pretty: true });

                console.log(`XML generado para ${key}:\n${xml}`);
                latestXml[key] = xml;
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
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});