import './load-env.js';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSTTStream } from './stt.js';
import { Session } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Sert l'UI
app.use(express.static(path.join(__dirname, '../../app')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/audio' });

wss.on('connection', (ws, req) => {
  console.log(`[WS] Nouvelle session depuis ${req.socket.remoteAddress}`);

  const session = new Session(ws);

  // ── STT ───────────────────────────────────────────────────────────────────
  let stt = null;
  try {
    stt = createSTTStream(
      (transcript) => session.onTranscript(transcript),
      (interim) => {
        // Afficher l'interim dans l'UI seulement
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'interim', text: interim }));
        // Note : l'interruption se fait désormais via tap/Espace côté client,
        // pas via la voix. L'audio n'est envoyé que quand clientState === 'listening'.
      }
    );
  } catch (err) {
    console.error(`[STT] Init échouée: ${err.message}`);
  }

  // KeepAlive Deepgram toutes les 8s pour éviter la déconnexion par inactivité.
  // Deepgram coupe après ~10-12s sans audio — on envoie un ping léger.
  const keepAliveInterval = setInterval(() => {
    if (stt) stt.keepAlive();
  }, 8000);

  // Message de bienvenue + init état
  session.init().catch(err => console.error('[Session] Erreur init:', err.message));

  // Messages client : JSON (contrôle) ou binaire (audio PCM)
  ws.on('message', (data) => {
    if (typeof data === 'string') {
      // Message de contrôle JSON
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'interrupt') {
          console.log('[WS] Interruption utilisateur reçue');
          session.onUserInterrupt();
        }
        if (msg.type === 'finalize_stt') {
          stt?.finalize();
        }
        if (msg.type === 'reset') {
          console.log('[WS] Réinitialisation conversation');
          session.resetHistory();
        }
      } catch { /* ignore */ }
    } else {
      // Audio PCM binaire → STT (envoyé seulement quand client est en mode listening)
      if (stt) stt.send(data);
    }
  });

  // Nettoyage à la fin d'appel (2.6.3)
  ws.on('close', () => {
    console.log('[WS] Session fermée');
    clearInterval(keepAliveInterval);
    session.destroy();
    stt?.close();
  });

  ws.on('error', (err) => {
    console.error('[WS] Erreur:', err.message);
    clearInterval(keepAliveInterval);
    session.destroy();
    stt?.close();
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Orchestrateur Ami démarré sur :${PORT}`);
});
