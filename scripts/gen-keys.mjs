#!/usr/bin/env node
// Generate Ed25519 key pair for JWT signing.
// Usage: node scripts/gen-keys.mjs
// Add the output lines to apps/api/.env

import { generateKeyPairSync } from 'crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const privateB64 = Buffer.from(privateKey).toString('base64');
const publicB64 = Buffer.from(publicKey).toString('base64');

console.log('# Add these to apps/api/.env:\n');
console.log(`JWT_PRIVATE_KEY=${privateB64}`);
console.log(`JWT_PUBLIC_KEY=${publicB64}`);
