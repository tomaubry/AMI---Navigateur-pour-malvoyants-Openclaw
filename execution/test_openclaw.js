/**
 * test_openclaw.js — Script de test OpenClaw Gateway
 * Utilise l'API HTTP compatible OpenAI exposée par le gateway local.
 * 
 * Prérequis :
 *   - OpenClaw gateway actif : systemctl status openclaw
 *   - OPENCLAW_GATEWAY_TOKEN défini dans `.env` à la racine du dépôt (ou AMI_ENV_FILE)
 *   - Un modèle LLM configuré dans OpenClaw (clé API Anthropic/OpenAI/etc.)
 * 
 * Usage :
 *   node test_openclaw.js "Va sur wikipedia.org et lis le premier paragraphe sur l'IA"
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultEnv = join(__dirname, '..', '.env');

// Charger le token depuis .env (racine du dépôt par défaut)
function loadEnv(envPath = process.env.AMI_ENV_FILE || defaultEnv) {
  try {
    const lines = readFileSync(resolve(envPath), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) env[key.trim()] = rest.join('=').trim();
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();
const GATEWAY_URL = env.OPENCLAW_ENDPOINT || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  console.error('❌ OPENCLAW_GATEWAY_TOKEN manquant (.env à la racine du dépôt ou AMI_ENV_FILE)');
  process.exit(1);
}

const instruction = process.argv[2];
if (!instruction) {
  console.error('Usage: node test_openclaw.js "<instruction>"');
  process.exit(1);
}

async function testOpenClaw(task) {
  console.log('=== TEST OPENCLAW GATEWAY ===');
  console.log(`Gateway : ${GATEWAY_URL}`);
  console.log(`Instruction : "${task}"\n`);

  // 1. Health check
  const health = await fetch(`${GATEWAY_URL}/healthz`);
  const healthData = await health.json();
  if (!healthData.ok) throw new Error(`Gateway health KO : ${JSON.stringify(healthData)}`);
  console.log('✅ Gateway health : live');

  // 2. Lister les agents disponibles
  const modelsRes = await fetch(`${GATEWAY_URL}/v1/models`, {
    headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` }
  });
  const models = await modelsRes.json();
  console.log(`✅ Agents disponibles : ${models.data?.map(m => m.id).join(', ')}\n`);

  // 3. Envoyer l'instruction de navigation
  console.log('⏳ Envoi de la tâche au gateway...');
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openclaw/default',
      messages: [{ role: 'user', content: task }],
      stream: false
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status} : ${err}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content;
  console.log('\n✅ Réponse OpenClaw :');
  console.log('─'.repeat(60));
  console.log(reply);
  console.log('─'.repeat(60));
}

testOpenClaw(instruction).catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
