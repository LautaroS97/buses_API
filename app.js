const https = require('https');
require('dotenv').config(); // Cargar variables de entorno desde .env

const data = JSON.stringify({
  username: process.env.API_USERNAME,
  password: process.env.API_PASSWORD
});

const options = {
  hostname: 'apiavl.easytrack.com.ar',
  path: '/sessions/auth/',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  },
  timeout: 5000 // Timeout de 5 segundos
};

const req = https.request(options, (res) => {
  console.log('Status Code:', res.statusCode);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
});

req.on('timeout', () => {
  console.error('Request timed out');
  req.destroy(); // Cancelar la solicitud si tarda más de lo esperado
});

req.on('error', (e) => {
  console.error('Error connecting to EasyTrack API:', e);
});

// Enviar los datos de autenticación
req.write(data);
req.end();