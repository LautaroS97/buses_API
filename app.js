require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const xmlbuilder = require('xmlbuilder');

const app = express();
app.use(express.json());

let latestXml = {
  bus_1: null,
  bus_2: null,
  bus_3: null
};

// Matrículas de los buses
const buses = {
  bus_1: 'GQP413',
  bus_2: 'DPH418',
  bus_3: 'FMD808'
};

// Función para obtener el token de autenticación de la API con un timeout de 15 segundos
async function obtenerToken() {
  try {
    const response = await axios.post(
      'https://apiavl.easytrack.com.ar/sessions/auth/',
      {
        username: process.env.API_USERNAME,
        password: process.env.API_PASSWORD,
      },
      {
        timeout: 15000 // Tiempo límite de 15 segundos para obtener el token
      }
    );
    return response.data.jwt; // Retornar el token JWT si la solicitud es exitosa
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error('Error: Tiempo de espera superado al intentar obtener el token de la API.');
    } else {
      console.error('Error al autenticar con la API:', error.message);
    }
    throw new Error('Error en la autenticación con la API');
  }
}

// Función para obtener la ubicación de un bus desde la API
async function obtenerUbicacionBusAPI(token, matricula) {
  try {
    const response = await axios.get(
      `https://apiavl.easytrack.com.ar/positions/${matricula}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000 // Establecer timeout de 15 segundos para la consulta de posición
      }
    );

    const busData = response.data[0]; // Tomar el primer elemento del array devuelto por la API
    if (busData && busData.position) {
      const direccionTruncada = busData.position.split(',').slice(0, 2).join(',').trim();
      console.log(`Matrícula ${matricula} - Dirección desde API: ${direccionTruncada}`);
      return { success: true, text: direccionTruncada }; // Retornar la dirección si se encuentra
    } else {
      console.log(`No se encontró la dirección para la matrícula ${matricula} en la API.`);
      return { success: false, text: '' };
    }
  } catch (error) {
    console.error(`Error de la API al obtener la ubicación del bus ${matricula}.`);
    return { success: false, text: '' };
  }
}

// Función principal para obtener los datos de los buses y generar el XML
async function extractDataAndGenerateXML() {
  let token;
  let useScraping = false;

  try {
    console.log('Intentando obtener el token de la API...');
    token = await obtenerToken(); // Intentar obtener el token de la API
  } catch (error) {
    console.error('Fallo al obtener el token de la API. Procediendo con el plan B (scraping).');
    useScraping = true; // Si falla, utilizar scraping como alternativa
  }

  if (!useScraping) {
    // Intentar obtener los datos a través de la API
    for (const [key, matricula] of Object.entries(buses)) {
      console.log(`Buscando la ubicación del bus ${matricula} desde la API...`);
      const result = await obtenerUbicacionBusAPI(token, matricula);
      if (result.success) {
        const xml = xmlbuilder
          .create('Response')
          .ele('Say', {}, result.text)
          .up()
          .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
          .end({ pretty: true });

        latestXml[key] = xml; // Guardar el XML generado si se obtuvo la información con éxito
      } else {
        useScraping = true; // Si algún bus no se encuentra, pasar al plan B
        break;
      }
    }
  }

  // Ejecutar el plan B si la API falla o si no se obtienen todos los datos
  if (useScraping) {
    console.log('Iniciando scraping como plan B...');
    await extractDataAndGenerateXMLScraping();
  }
}

// Función de respaldo para obtener los datos mediante scraping usando Puppeteer
async function extractDataAndGenerateXMLScraping() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  try {
    console.log('Navegando a la URL de login...');
    await page.goto('https://avl.easytrack.com.ar/login', {
      waitUntil: 'domcontentloaded',
    });

    console.log('Esperando que el formulario de login esté disponible...');
    await page.waitForSelector('app-root app-login.ng-star-inserted');

    console.log('Ingresando credenciales...');
    await page.type(
      'app-root app-login.ng-star-inserted #mat-input-0',
      'usuarioexterno@transportesversari'
    );
    await page.type(
      'app-root app-login.ng-star-inserted #mat-input-1',
      'usu4rio3xt3rn0'
    );

    console.log('Presionando Enter...');
    await page.keyboard.press('Enter');
    await page.waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    console.log('Navegando al dashboard principal...');
    await page.goto('https://avl.easytrack.com.ar/dashboard/1000', {
      waitUntil: 'domcontentloaded',
    });

    const notFoundBuses = [];

    // Intentar obtener los datos de los buses mediante scraping
    for (let busKey in buses) {
      const success = await extractDataForBus(page, busKey, buses[busKey]);
      if (!success) {
        notFoundBuses.push(busKey); // Agregar buses no encontrados a la lista
      }
    }

    // Si no se encuentran todas las matrículas, buscar en la segunda URL
    if (notFoundBuses.length > 0) {
      console.log('Navegando a la segunda URL...');
      await page.goto('https://avl.easytrack.com.ar/dashboard/1007', {
        waitUntil: 'domcontentloaded',
      });

      const notFoundBusesSecond = [];

      for (let busKey of notFoundBuses) {
        const success = await extractDataForBus(page, busKey, buses[busKey]);
        if (!success) {
          notFoundBusesSecond.push(busKey); // Agregar buses no encontrados a la segunda lista
        }
      }

      // Si aún no se encuentran, buscar en la tercera URL
      if (notFoundBusesSecond.length > 0) {
        console.log('Navegando a la tercera URL...');
        await page.goto('https://avl.easytrack.com.ar/dashboard/1006', {
          waitUntil: 'domcontentloaded',
        });

        for (let busKey of notFoundBusesSecond) {
          await extractDataForBus(page, busKey, buses[busKey]); // Último intento
        }
      }
    }
  } catch (error) {
    console.error('Error al extraer los datos mediante scraping:', error);
  } finally {
    console.log('Cerrando el navegador...');
    await browser.close();
  }
}

// Función para buscar la matrícula y extraer la dirección usando XPath (scraping)
async function extractDataForBus(page, busKey, busMatricula) {
  async function findBusData() {
    try {
      console.log(`Buscando la matrícula ${busMatricula}...`);

      // Ejecutar XPath dentro del contexto de la página
      const busDiv = await page.evaluate((matricula) => {
        const xpath = `//div[contains(text(), '${matricula}')]`;
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
        return result ? result.textContent : null;
      }, busMatricula);

      if (!busDiv) {
        console.log(`No se encontró la matrícula ${busMatricula}.`);
        return { success: false, text: '' };
      }

      // Subir al div padre y luego extraer el último div hijo para obtener la dirección
      const address = await page.evaluate((matricula) => {
        const xpath = `//div[contains(text(), '${matricula}')]/../div[last()]`;
        const result = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
        return result ? result.textContent.trim() : null;
      }, busMatricula);

      if (address) {
        console.log(`Dirección encontrada para ${busMatricula}: ${address}`);
        return { success: true, text: address };
      } else {
        console.log(`No se encontró la dirección para ${busMatricula}.`);
        return { success: false, text: '' };
      }
    } catch (error) {
      console.error(`Error buscando la dirección para ${busMatricula}:`, error);
      return { success: false, text: '' };
    }
  }

  let result = await findBusData();
  if (result.success) {
    // Generar el XML si se encuentra la dirección
    const xml = xmlbuilder
      .create('Response')
      .ele('Say', { voice: 'Polly.Andres-Neural', language: 'es-MX' }, result.text)
      .up()
      .ele('Redirect', {}, `${process.env.TWILIO_WEBHOOK_URL}?FlowEvent=return`)
      .end({ pretty: true });
    latestXml[busKey] = xml;
  }
  return result.success;
}

// Manejo de la solicitud POST para actualizar el XML
app.post('/update', async (req, res) => {
  console.log('Solicitud POST entrante para actualizar los XML de todos los buses');
  try {
    await extractDataAndGenerateXML();
    res.status(200).send({ message: 'Solicitud recibida, XML se está actualizando.' });
  } catch (error) {
    console.error('Error al actualizar los XML:', error);
    res.status(500).send({ message: 'Error al actualizar los XML.' });
  }
});

// Manejo de la solicitud GET para obtener el XML de cada bus
app.get('/voice/:busKey', (req, res) => {
  const busKey = req.params.busKey;
  console.log(`Solicitud entrante a /voice/${busKey}`);

  if (latestXml[busKey]) {
    res.type('application/xml');
    res.send(latestXml[busKey]);
  } else {
    const xml = xmlbuilder
      .create('Response')
      .ele('Say', { voice: 'Polly.Andres-Neural', language: 'es-MX' }, 'Lo sentimos, no se pudo obtener la información en este momento. Por favor, intente nuevamente más tarde.')
      .end({ pretty: true });

    res.type('application/xml');
    res.send(xml);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});