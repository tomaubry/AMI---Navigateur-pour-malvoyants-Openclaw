/**
 * Test isolé du pipeline TTS — sans appel téléphonique ni WebSocket réel.
 * Vérifie que ElevenLabs génère bien de l'audio et que le WAV est valide.
 *
 * Usage: node --env-file=../.env test_tts.js
 */
import 'dotenv/config';
import { streamTTS } from './src/tts.js';
import fs from 'fs';

const OUTPUT_FILE = '/tmp/test_tts_output.wav';

// Mock WebSocket navigateur : capture les bytes envoyés
const mockWs = {
  readyState: 1, // OPEN
  received: [],
  send(data) {
    this.received.push(data);
    console.log('[Mock WS] Chunk audio reçu:', data.length, 'bytes');

    // Vérifier l'en-tête WAV
    const header = data.slice(0, 4).toString('ascii');
    if (header === 'RIFF') {
      const dataSize = data.readUInt32LE(4) - 36;
      const sampleRate = data.readUInt32LE(24);
      const bitDepth = data.readUInt16LE(34);
      console.log(`  ✅ WAV valide — sampleRate=${sampleRate}Hz, bitDepth=${bitDepth}bit, audio=${(dataSize / (sampleRate * 2)).toFixed(2)}s`);
      fs.writeFileSync(OUTPUT_FILE, data);
      console.log(`  💾 Fichier sauvegardé : ${OUTPUT_FILE}`);
    } else {
      console.error('  ❌ Format invalide — pas de header RIFF');
    }
  },
};

console.log('🎙️  Test TTS ElevenLabs\n');
const t0 = Date.now();

await streamTTS(
  "Bonjour, je suis Ami, votre assistant vocal. Je suis là pour vous aider à naviguer sur internet.",
  mockWs,
  {
    onDone: () => {
      const elapsed = Date.now() - t0;
      console.log(`\n⏱️  Temps total : ${elapsed}ms`);
      console.log(`📦  Chunks envoyés au browser : ${mockWs.received.length}`);
      console.log('\n✅ Test TTS OK');
    },
  }
);
