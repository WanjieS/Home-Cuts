/**
 * Safaricom Daraja C2B URL Registration Script for Home-Cuts Butchery
 * 
 * Registers your live Render webhook URLs with Safaricom Daraja so that
 * payments to Meat Till (201039) and Chips Till (9387337) flow directly to:
 * https://home-cuts.onrender.com/api/mpesa/c2b-confirmation
 * 
 * Usage:
 *   node register-daraja.js
 * 
 * Make sure DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET are in .env
 * or passed as environment variables.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET;
const ENV_MODE = process.env.DARAJA_ENV || 'production'; // 'production' or 'sandbox'

const DARAJA_BASE_URL = ENV_MODE === 'production' 
  ? 'https://api.safaricom.co.ke' 
  : 'https://sandbox.safaricom.co.ke';

const CONFIRMATION_URL = process.env.MPESA_CONFIRMATION_URL || 'https://home-cuts.onrender.com/api/mpesa/c2b-confirmation';
const VALIDATION_URL = process.env.MPESA_VALIDATION_URL || 'https://home-cuts.onrender.com/api/mpesa/c2b-validation';

const TILLS = [
  { name: 'Meat Till', shortCode: process.env.MPESA_MEAT_TILL || '201039' },
  { name: 'Chips Till', shortCode: process.env.MPESA_SNACK_TILL || '9387337' }
];

async function getAccessToken() {
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error('DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET are missing in .env!');
  }
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to get OAuth token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function registerTill(accessToken, till) {
  console.log(`\n⏳ Registering URLs for ${till.name} (ShortCode: ${till.shortCode})...`);
  console.log(`   ConfirmationURL: ${CONFIRMATION_URL}`);
  console.log(`   ValidationURL:   ${VALIDATION_URL}`);

  const payload = {
    ShortCode: till.shortCode,
    ResponseType: 'Completed',
    ConfirmationURL: CONFIRMATION_URL,
    ValidationURL: VALIDATION_URL
  };

  const res = await fetch(`${DARAJA_BASE_URL}/mpesa/c2b/v1/registerurl`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(`❌ Failed to register ${till.name}:`, data);
  } else {
    console.log(`✅ ${till.name} registered successfully! Response:`, data);
  }
}

async function main() {
  try {
    console.log(`🚀 Starting Safaricom Daraja URL Registration [Mode: ${ENV_MODE.toUpperCase()}]`);
    console.log(`📡 Target Render Host: ${CONFIRMATION_URL}`);
    const token = await getAccessToken();
    console.log(`🔑 Obtained Daraja Access Token successfully.`);

    for (const till of TILLS) {
      await registerTill(token, till);
    }

    console.log(`\n🎉 Done! Safaricom will now post all incoming C2B payments to Render.`);
  } catch (err) {
    console.error('\n⚠️ Registration error:', err.message);
    console.log('\nTip: If you do not have Daraja API keys and are using a physical Till phone, you can forward payments using an Android SMS Webhook app pointed to:');
    console.log(`   ${CONFIRMATION_URL}`);
  }
}

main();
