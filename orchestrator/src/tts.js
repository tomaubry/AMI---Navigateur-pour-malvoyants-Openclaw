import { ElevenLabsClient } from 'elevenlabs';

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

/**
 * Emballe du PCM Int16 LE 16kHz mono dans un container WAV.
 * Le navigateur peut décoder WAV via AudioContext.decodeAudioData().
 */
function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);                           // taille chunk fmt PCM
  wav.writeUInt16LE(1, 20);                            // format PCM = 1
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // byte rate
  wav.writeUInt16LE(channels * (bitDepth / 8), 32);   // block align
  wav.writeUInt16LE(bitDepth, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav;
}

/**
 * Synthétise du texte via ElevenLabs (streaming PCM) et envoie l'audio WAV
 * au WebSocket navigateur pour lecture via AudioContext.decodeAudioData().
 *
 * @param {string} text          Texte à synthétiser
 * @param {WebSocket} browserWs  WebSocket du client navigateur
 * @param {object} opts
 * @param {Function} opts.onDone Callback appelé quand l'audio est envoyé
 * @param {AbortSignal} opts.signal  Signal pour annuler le stream (interruption)
 */
export async function streamTTS(text, browserWs, { onDone, signal } = {}) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID manquant dans .env');

  console.log('[TTS] Synthèse:', text.slice(0, 60));

  const pcmChunks = [];

  try {
    const audioStream = await client.textToSpeech.convertAsStream(voiceId, {
      text,
      model_id: 'eleven_turbo_v2_5',
      output_format: 'pcm_16000',
      voice_settings: {
        stability: 0.10,          // max variation, très vivant et spontané
        similarity_boost: 0.75,
        style: 0.90,              // fun, souriant, enthousiaste
        use_speaker_boost: true,
      },
    });

    for await (const chunk of audioStream) {
      if (signal?.aborted) {
        console.log('[TTS] Stream annulé (interruption)');
        break;
      }
      if (chunk?.length > 0) {
        pcmChunks.push(Buffer.from(chunk));
      }
    }
  } catch (err) {
    console.error('[TTS] Erreur ElevenLabs:', err.message);
    onDone?.();
    return;
  }

  // Ne pas envoyer l'audio si le stream a été annulé (interruption utilisateur)
  if (!signal?.aborted && pcmChunks.length > 0 && browserWs.readyState === 1 /* OPEN */) {
    const pcm = Buffer.concat(pcmChunks);
    const wav = pcmToWav(pcm);
    browserWs.send(wav);
    console.log(`[TTS] Envoyé ${wav.length} bytes WAV (${(pcm.length / 32000).toFixed(1)}s audio)`);
  } else if (signal?.aborted) {
    console.log('[TTS] Annulé — audio non envoyé');
  }

  onDone?.();
}
