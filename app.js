const https = require('https');

https.get('https://apiavl.easytrack.com.ar', (res) => {
  console.log('Status Code:', res.statusCode);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
}).on('error', (e) => {
  console.error('Error connecting to EasyTrack API:', e);
});