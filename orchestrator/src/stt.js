import WebSocket from 'ws';

const DEEPGRAM_URL = [
  'wss://api.deepgram.com/v1/listen',
  '?model=nova-2',
  '&language=fr',
  '&encoding=linear16',
  '&sample_rate=16000',
  '&channels=1',
  '&punctuate=true',
  '&interim_results=true',
  '&endpointing=800',
  '&utterance_end_ms=1000',
].join('');

/**
 * Crée un stream Deepgram STT avec :
 * - Auto-reconnect si la connexion se ferme inopinément (inactivité, erreur réseau)
 * - Méthode keepAlive() pour envoyer un KeepAlive Deepgram sans audio
 *
 * Format audio attendu : PCM Int16 mono, 16kHz (getUserMedia navigateur).
 */
export function createSTTStream(onTranscript, onInterim = null) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY manquant dans .env');

  let ws = null;
  let isOpen = false;
  let isClosed = false;   // true quand close() est appelé manuellement → pas de reconnect
  const audioBuffer = [];

  function connect() {
    ws = new WebSocket(DEEPGRAM_URL, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    ws.on('open', () => {
      console.log('[STT] Connexion Deepgram ouverte');
      isOpen = true;
      if (audioBuffer.length > 0) {
        console.log(`[STT] Flush de ${audioBuffer.length} chunks bufferisés`);
        audioBuffer.forEach((chunk) => ws.send(chunk));
        audioBuffer.length = 0;
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const transcript = msg?.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        if (msg.is_final) {
          console.log('[STT] Final:', transcript);
          onTranscript(transcript);
        } else if (onInterim) {
          onInterim(transcript);
        }
      } catch { /* ignore JSON parse errors */ }
    });

    ws.on('error', (err) => {
      console.error('[STT] Erreur Deepgram:', err.message);
    });

    ws.on('close', (code) => {
      console.log('[STT] Connexion Deepgram fermée, code:', code);
      isOpen = false;

      // Reconnect automatique sauf si close() a été appelé volontairement
      if (!isClosed) {
        const delay = code === 1011 ? 500 : 2000; // plus rapide sur inactivité
        console.log(`[STT] Reconnexion dans ${delay}ms...`);
        setTimeout(() => {
          if (!isClosed) connect();
        }, delay);
      }
    });
  }

  connect();

  return {
    send: (audioChunk) => {
      if (isOpen) {
        ws.send(audioChunk);
      } else if (ws?.readyState === WebSocket.CONNECTING) {
        if (audioBuffer.length < 200) audioBuffer.push(Buffer.from(audioChunk));
      }
    },

    // Envoie un message KeepAlive Deepgram pour éviter la déconnexion par inactivité.
    // À appeler toutes les 8s quand aucun audio n'est envoyé.
    keepAlive: () => {
      if (isOpen && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    },

    // Force Deepgram à émettre le transcript final pour l'audio reçu jusqu'ici.
    // À appeler quand l'utilisateur tape "stop" pendant l'écoute.
    finalize: () => {
      if (isOpen && ws?.readyState === WebSocket.OPEN) {
        console.log('[STT] Finalize envoyé à Deepgram');
        ws.send(JSON.stringify({ type: 'Finalize' }));
      }
    },

    close: () => {
      isClosed = true;
      audioBuffer.length = 0;
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
