// Genera las claves VAPID para las notificaciones push (ejecutar UNA vez y guardarlas en Render).
const webpush = require('web-push');
const k = webpush.generateVAPIDKeys();
console.log('\nCopiá estas variables en Render (Environment):\n');
console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
console.log('VAPID_SUBJECT=mailto:TU_CORREO@ejemplo.com\n');
console.log('La clave privada es secreta: no la subas a GitHub ni la compartas.\n');
