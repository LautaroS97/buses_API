const express = require('express');
const axios = require('axios');
const xmlbuilder = require('xmlbuilder');
const jwtDecode = require('jwt-decode');
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

// Token JWT de autenticación (cargado desde las variables de entorno)
let cachedToken = process.env.API_JWT_TOKEN;
let refreshToken = process.env.API_REFRESH_TOKEN;

// Función para renovar el token si ha expirado
async function renovarToken() {
    try {
        const response = await axios.post('https://apiavl.easytrack.com.ar/sessions/auth/', {
            username: process.env.API_USERNAME, // Usar el nombre de usuario del archivo .env
            password: process.env.API_PASSWORD, // Usar la contraseña desde el archivo .env
        });

        const { jwt, refreshToken: newRefreshToken } = response.data;
        cachedToken = jwt; // Actualizar el token JWT
        refreshToken = newRefreshToken; // Actualizar el refresh token

        console.log('Token renovado exitosamente');
    } catch (error) {
        console.error('Error al renovar el token:', error.message);
    }
}

// Función para verificar si el token ha expirado
function tokenHaExpirado() {
    const now = Math.floor(Date.now() / 1000); // Tiempo actual en formato UNIX
    const exp = jwtDecode(cachedToken).exp; // Decodificar el token JWT para obtener el tiempo de expiración
    return now >= exp;
}

// Función para obtener la ubicación de un bus a partir de su matrícula
async function obtenerUbicacionBus(token, matricula) {
    try {
        const response = await axios.get(`https://apiavl.easytrack.com.ar/positions/${matricula}`, {
            headers: {
                Authorization: `Bearer ${token}`, // Usar el token cargado desde la variable de entorno
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
        console.error(`Error de la API al obtener la ubicación del bus ${matricula}:`, error.message);
        return { success: false, text: '' };
    }
}

// Función para extraer datos de los buses y generar el XML
async function extractDataAndGenerateXML() {
    try {
        // Verificar si el token ha expirado y renovarlo si es necesario
        if (tokenHaExpirado()) {
            await renovarToken();
        }

        const token = cachedToken; // Usar el token actualizado
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

app.listen(8080, async () => {
    console.log(`Servidor escuchando en el puerto 8080`);
    // Actualizar los XML por primera vez después del despliegue
    await extractDataAndGenerateXML();
});