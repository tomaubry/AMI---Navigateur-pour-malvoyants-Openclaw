/**
 * Test E2E pipeline LLM → TTS : simule ce que fera le serveur quand STT donne un transcript.
 * Vérifie que les phrases arrivent et que chacune génère de l'audio.
 *
 * Usage: node --env-file=.env test_llm_tts.js
 */
import 'dotenv/config';
import { streamLLM } from './src/llm.js';
import { streamTTS } from './src/tts.js';

// Mock WebSocket — capture les octets audio sans vraie connexion
function makeMockWs() {
  let totalBytes = 0;
  return {
    readyState: 1,
    chunks: [],
    send(data) {
      if (Buffer.isBuffer(data)) {
        totalBytes += data.length;
        this.chunks.push(data.length);
      }
    },
    get totalBytes() { return totalBytes; },
  };
}

async function testPipeline(label, userMessage) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`🧪  ${label}`);
  console.log('═'.repeat(65));

  const mockWs = makeMockWs();
  const t0 = Date.now();
  let sentenceCount = 0;
  let functionCalls = [];

  await streamLLM(
    [{ role: 'user', content: userMessage }],
    {
      onText: async (sentence) => {
        sentenceCount++;
        const t1 = Date.now();
        console.log(`  [LLM] Phrase ${sentenceCount} : "${sentence.slice(0, 60)}"`);
        await streamTTS(sentence, mockWs);
        console.log(`  [TTS] ✅ Audio envoyé en ${Date.now() - t1}ms`);
      },
      onFunctionCall: async (name, args) => {
        functionCalls.push({ name, args });
        console.log(`  [LLM] 🌐 function_call: ${name}(${JSON.stringify(args)})`);
      },
    }
  );

  const elapsed = Date.now() - t0;
  console.log(`\n  ⏱️  Temps total     : ${elapsed}ms`);
  console.log(`  💬  Phrases TTS     : ${sentenceCount}`);
  console.log(`  🔊  Chunks WAV      : ${mockWs.chunks.length} (${(mockWs.totalBytes / 1024).toFixed(0)} KB)`);
  console.log(`  🔧  Function calls  : ${functionCalls.length}`);
  if (functionCalls.length > 0) {
    console.log(`  ✅  browser_task    : "${functionCalls[0].args.task}"`);
  }
}

// Test 1 : réponse directe
await testPipeline(
  'Test "Bonjour" — réponse directe sans navigation web',
  'Bonjour !'
);

// Test 2 : recherche web
await testPipeline(
  'Test "dentiste Paris" — doit émettre function_call',
  'Trouve-moi un dentiste disponible demain à Paris.'
);

console.log('\n✅ Pipeline LLM→TTS opérationnel');
