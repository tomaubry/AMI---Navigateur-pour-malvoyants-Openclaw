/**
 * Test complet pipeline OpenClaw + Narration + Reformulation LLM→TTS.
 * Simule exactement ce que fait handleBrowserTask() dans server.js.
 *
 * Usage: node --env-file=.env test_openclaw_pipeline.js
 */
import 'dotenv/config';
import { executeTask, NARRATION_PHRASES } from './src/openclaw.js';
import { streamLLM } from './src/llm.js';
import { streamTTS } from './src/tts.js';

// Mock WebSocket
const mockWs = {
  readyState: 1,
  totalBytes: 0,
  messages: [],
  send(data) {
    if (Buffer.isBuffer(data)) {
      this.totalBytes += data.length;
    } else {
      const msg = JSON.parse(data);
      this.messages.push(msg);
      if (msg.type === 'ami') console.log(`  🤖 Ami : "${msg.text}"`);
      if (msg.type === 'function_call') console.log(`  🌐 function_call: ${msg.name}(${JSON.stringify(msg.args)})`);
    }
  },
};

console.log('═'.repeat(65));
console.log('🧪  Test pipeline OpenClaw → Narration → Reformulation LLM+TTS');
console.log('═'.repeat(65));
console.log('  Tâche : "Trouve la météo à Paris demain"\n');

const t0 = Date.now();
const TASK = 'Cherche la météo à Paris demain et donne-moi la température maximale';

// ── Reproduire handleBrowserTask ─────────────────────────────────────────

const history = [
  { role: 'assistant', content: 'Bonjour ! Je suis Ami.' },
  { role: 'user', content: 'Quelle météo demain à Paris ?' },
];

// 1. Lancer OpenClaw en arrière-plan
const doneFlag = { done: false };
const openclawPromise = executeTask(TASK)
  .finally(() => { doneFlag.done = true; });

// 2. Narration parallèle
let phraseCount = 0;
async function narrate() {
  let i = 0;
  while (!doneFlag.done) {
    const phrase = NARRATION_PHRASES[i % NARRATION_PHRASES.length];
    i++; phraseCount++;
    console.log(`  [+${Date.now()-t0}ms] 🗣️  Narration : "${phrase}"`);
    mockWs.send(JSON.stringify({ type: 'ami', text: phrase }));
    await streamTTS(phrase, mockWs);
    console.log(`  [+${Date.now()-t0}ms] 🔊 TTS envoyé`);
    if (!doneFlag.done) await new Promise(r => setTimeout(r, 1500));
  }
}
const narrationPromise = narrate();

// 3. Attendre OpenClaw + fin narration
let result;
try {
  result = await openclawPromise;
} catch (e) {
  result = null;
  console.error('  ❌ OpenClaw erreur:', e.message);
}
await narrationPromise;

console.log(`\n  [+${Date.now()-t0}ms] ⏹️  OpenClaw terminé. Résultat : ${result ? result.slice(0,100)+'...' : 'null'}`);

// 4. Reformulation LLM
if (result) {
  console.log(`\n  [+${Date.now()-t0}ms] 🧠 Reformulation GPT-4o...`);
  const ctx = [
    ...history,
    { role: 'user', content: `[Résultat de la recherche web pour : "${TASK}"]\n\n${result}\n\nRéforme ce résultat en 2-3 phrases naturelles et parlées pour l'utilisateur. Ne donne pas d'URL. Termine par une ouverture.` },
  ];
  await streamLLM(ctx, {
    noTools: true,
    onText: async (sentence) => {
      console.log(`  [+${Date.now()-t0}ms] 💬 "${sentence}"`);
      await streamTTS(sentence, mockWs);
    },
    onFunctionCall: async () => {},
  });
} else {
  console.log('  ℹ️  Pas de résultat — Ami s\'excuse');
}

console.log(`\n${'─'.repeat(65)}`);
console.log(`  ⏱️  Temps total    : ${Date.now()-t0}ms`);
console.log(`  🗣️  Phrases narr. : ${phraseCount}`);
console.log(`  🔊  Audio total   : ${(mockWs.totalBytes/1024).toFixed(0)} KB`);
console.log(`\n✅ Pipeline OpenClaw complet`);
