/**
 * Test isolé du pipeline LLM — sans WebSocket ni TTS réel.
 * Vérifie que GPT-4o répond phrase par phrase et détecte les function calls.
 *
 * Usage: node --env-file=.env test_llm.js
 */
import 'dotenv/config';
import { streamLLM } from './src/llm.js';

async function test(label, messages) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🧪 Test : ${label}`);
  console.log('─'.repeat(60));

  const sentences = [];
  const calls = [];
  const t0 = Date.now();

  const full = await streamLLM(messages, {
    onText: async (sentence) => {
      const elapsed = Date.now() - t0;
      sentences.push(sentence);
      console.log(`  [${elapsed}ms] 💬 "${sentence}"`);
    },
    onFunctionCall: async (name, args) => {
      calls.push({ name, args });
      console.log(`  🌐 function_call: ${name}(${JSON.stringify(args)})`);
    },
  });

  console.log(`\n  ⏱️  Temps total : ${Date.now() - t0}ms`);
  console.log(`  📦  Phrases TTS : ${sentences.length}`);
  console.log(`  🔧  Function calls : ${calls.length}`);
  if (calls.length > 0) console.log('  ✅ browser_task détecté');
  else console.log('  ✅ Réponse directe (pas de function call)');
}

// Test 1 : question simple sans recherche web
await test('Bonjour (pas de function call attendu)', [
  { role: 'user', content: 'Bonjour !' },
]);

// Test 2 : question nécessitant une navigation web
await test('Dentiste Paris (function_call browser_task attendu)', [
  { role: 'user', content: 'Trouve-moi un dentiste disponible demain à Paris.' },
]);

console.log('\n✅ Tests LLM terminés');
