const https = require('https');

https.get('https://jsonplaceholder.typicode.com/todos/1', (res) => {
  console.log('Status Code:', res.statusCode);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
}).on('error', (e) => {
  console.error('Error testing connection to external URL:', e);
});