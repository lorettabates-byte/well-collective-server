const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();

console.log("Add these to your .env file (and Railway environment variables):\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("\nThe VAPID_PUBLIC_KEY also goes into the frontend's VITE_VAPID_PUBLIC_KEY env var.");
