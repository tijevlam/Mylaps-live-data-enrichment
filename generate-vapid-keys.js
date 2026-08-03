'use strict';

// One-time setup: generates a VAPID key pair for Web Push notifications.
// Run once, then put the values in your environment (NOT in git):
//
//   node generate-vapid-keys.js

const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('Add these to your environment (the private key is a secret - never commit it):\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
