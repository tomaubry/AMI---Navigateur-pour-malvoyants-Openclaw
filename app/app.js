// ── État global ────────────────────────────────────────────────────────────────
//
// États client :
//   disconnected  →  avant connexion WebSocket
//   loading       →  session ouverte, message de bienvenue en cours
//   waiting       →  Ami idle, attend que l'utilisateur tape Espace / bouton
//   listening     →  micro actif, audio envoyé à Deepgram
//   busy          →  Ami réfléchit ou parle (tap = interruption)

let clientState = 'disconnected';

let ws = null;

let mediaStream = null;
let audioCtx = null;
let processor = null;

// Scheduler audio : enchaîne les chunks WAV sans chevauchement
let nextAudioAt = 0;
let activeAudioSources = [];

// WSS en prod (HTTPS), WS en dev (HTTP/localhost)
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/audio`;

// ── Gestion des états ──────────────────────────────────────────────────────────

function setClientState(state) {
  clientState = state;
  const btn = document.getElementById('btn');
  const status = document.getElementById('status');
  const btnReset = document.getElementById('btn-reset');

  btn.className = 'btn-talk ' + state;

  // Bouton reset : visible seulement quand une session est active
  if (btnReset) btnReset.disabled = (state === 'disconnected' || state === 'loading');

  switch (state) {
    case 'disconnected':
      btn.textContent = 'Démarrer';
      btn.disabled = false;
      status.textContent = 'Appuyez sur le bouton ou sur Espace pour démarrer';
      break;
    case 'loading':
      btn.textContent = '…';
      btn.disabled = true;
      status.textContent = 'Ami se présente…';
      break;
    case 'waiting':
      btn.textContent = 'Parler  [Espace]';
      btn.disabled = false;
      status.textContent = 'Prêt — appuyez sur le bouton ou sur Espace';
      break;
    case 'listening':
      btn.textContent = 'J\'écoute…';
      btn.disabled = false;
      status.textContent = 'Parlez maintenant…';
      break;
    case 'busy':
      btn.textContent = 'Ami répond…';
      btn.disabled = false;
      status.textContent = 'Espace pour interrompre';
      break;
  }
}

// ── Bouton principal + raccourci clavier ───────────────────────────────────────

function handleTap() {
  if (clientState === 'disconnected') {
    connect();
    return;
  }
  if (clientState === 'loading') return; // attendre la fin du bonjour

  if (clientState === 'waiting') {
    // Reprendre l'AudioContext si suspendu (politique autoplay navigateur)
    // IMPORTANT : doit être appelé dans le handler d'un geste utilisateur
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => { });
    playBeep('start');
    setClientState('listening');
    return;
  }

  if (clientState === 'busy') {
    // Couper Ami et revenir à l'attente — un deuxième tap relance l'écoute
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'interrupt' }));
    }
    clearAudioQueue();
    playBeep('stop');
    setClientState('waiting');
    return;
  }

  // clientState === 'listening' : presser Espace envoie un Finalize rapide
  // mais NE change PAS l'état — c'est le VAD Deepgram qui stoppe automatiquement
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'finalize_stt' }));
  }
}

// Touche Espace (et Entrée en bonus) → handleTap
// Touche Ctrl → fin de conversation / reset
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
    e.preventDefault();
    handleTap();
  }
  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    e.preventDefault();
    resetConversation();
  }
});

// ── Connexion WebSocket + session ──────────────────────────────────────────────

async function connect() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    setClientState('disconnected');
    document.getElementById('status').textContent = 'Micro refusé : ' + err.message;
    return;
  }

  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    resetAudioQueue();
    setupAudioCapture();
    setClientState('loading'); // bonjour en cours
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'transcript') {
          addMessage('user', msg.text);
          setClientState('busy');
        }
        if (msg.type === 'interim') {
          document.getElementById('status').textContent = '… ' + msg.text;
        }
        if (msg.type === 'ami') {
          addMessage('ami', msg.text);
        }
        if (msg.type === 'ami_done') {
          // Ami a fini de parler → prêt pour la prochaine question
          setClientState('waiting');
        }
        if (msg.type === 'function_call') {
          addMessage('nav', msg.args.task);
        }
        if (msg.type === 'audio_clear') {
          clearAudioQueue();
        }
      } catch { /* ignore JSON malformé */ }
    } else {
      playAudioChunk(e.data);
    }
  };

  ws.onclose = () => disconnect();
  ws.onerror = () => {
    document.getElementById('status').textContent = 'Erreur de connexion';
    disconnect();
  };
}

function disconnect() {
  resetAudioQueue();
  processor?.disconnect();
  audioCtx?.close();
  mediaStream?.getTracks().forEach(t => t.stop());
  ws?.close();
  ws = null;
  mediaStream = null;
  audioCtx = null;
  processor = null;
  setClientState('disconnected');
}

// ── Capture audio ──────────────────────────────────────────────────────────────

function setupAudioCapture() {
  audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(mediaStream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    // N'envoyer de l'audio QUE quand l'utilisateur a activé l'écoute
    if (clientState !== 'listening') return;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const pcm = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32768));
    }
    ws.send(int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
}

// ── Lecture audio TTS ──────────────────────────────────────────────────────────

function playAudioChunk(arrayBuffer) {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 16000 });
  audioCtx.decodeAudioData(arrayBuffer.slice(0))
    .then((buf) => {
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);

      const startAt = Math.max(audioCtx.currentTime, nextAudioAt);
      src.start(startAt);
      nextAudioAt = startAt + buf.duration;

      activeAudioSources.push(src);
      src.onended = () => {
        activeAudioSources = activeAudioSources.filter(s => s !== src);
      };
    })
    .catch(() => { });
}

function resetAudioQueue() {
  nextAudioAt = 0;
  activeAudioSources = [];
}

/** Coupe tout l'audio en file d'attente immédiatement (interruption). */
function clearAudioQueue() {
  activeAudioSources.forEach(src => { try { src.stop(); } catch { } });
  activeAudioSources = [];
  nextAudioAt = audioCtx ? audioCtx.currentTime : 0;
}

// ── Sons d'activation / désactivation ─────────────────────────────────────────

/**
 * Bip court via Web Audio API.
 * 'start' → ton montant agréable (écoute activée)
 * 'stop'  → ton descendant neutre (écoute désactivée / coupure)
 */
function playBeep(type) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'start') {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    } else {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.12);
    }

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => ctx.close(), 300);
  } catch { /* ignore si AudioContext non disponible */ }
}

// ── Affichage conversation ─────────────────────────────────────────────────────

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  document.getElementById('transcript').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth' });
}

// ── Init ───────────────────────────────────────────────────────────────────────

setClientState('disconnected');

// ── Fin de conversation ────────────────────────────────────────────────────────

function resetConversation() {
  if (clientState === 'disconnected') return;

  // Couper l'audio en cours
  clearAudioQueue();

  // Vider le transcript à l'écran
  document.getElementById('transcript').innerHTML = '';

  // Envoyer reset au serveur (vide l'historique + jokeTold)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'reset' }));
  }

  // Revenir à l'état d'attente
  setClientState('waiting');
}
