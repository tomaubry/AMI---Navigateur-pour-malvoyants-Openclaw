# Architecture Technique — Ami, Agent Vocal IA

> **Version :** 5.0 — Clarification Pré-Action + Exécution Parallèle
> **Date :** 2026-03-29
> **Statut :** Document de référence actif

---

## 1. Vision & Principe Fondamental

**Ami** est un agent vocal accessible via une app web. L'utilisateur appuie sur **un bouton**, parle, et entend le résultat d'une navigation web. En parallèle, sur le même écran, le navigateur Chromium navigue en direct (noVNC).

**Pas de numéro de téléphone. Pas de Twilio. Un WebSocket direct entre l'app et le VPS.**

**Principe clé — Clarification Pré-Action + Traitement Parallèle :**
```
Utilisateur appuie sur [Parler à Ami]
     ↓
Micro capturé → WebSocket → VPS
     ↓
STT transcrit (streaming, 200ms)
     ↓
LLM analyse la demande
     │
     ├─ Intention clara et complète ──────────────────────────────────────────┐
     │                                                                         │
     └─ Clarification nécessaire (info manquante : lieu, date, préférence...) │
          ↓                                                                    │
     LLM pose UNE question ciblée (TTS)                                       │
          ↓                                                                    │
     Utilisateur répond (STT)                                                 │
          ↓                                                                    │
     (boucle courte jusqu'à intention claire)                                 │
          ↓                                                                    │
     ←────────────────────────────────────────────────────────────────────────┘
     LLM lance OpenClaw (non-bloquant) + narre en parallèle
     ↓ (en même temps)
┌─────────────────────────┐    ┌──────────────────────────────┐
│  OpenClaw navigue       │    │  LLM génère narration        │
│  (5-15s en fond)        │    │  "Je cherche sur Doctolib..."│
│                         │    │  TTS → audio → App           │
└────────────┬────────────┘    └──────────────────────────────┘
             │ résultat
             ▼
LLM reformule → TTS → App → Utilisateur entend le résultat
```

---

## 2. Stack Technologique

| Composant | Technologie | Rôle |
|-----------|-------------|------|
| Interface utilisateur | **App web** (HTML/JS) | Bouton micro + iframe noVNC |
| Transport audio | **WebSocket natif** (WSS PCM 16kHz) | Stream bidirectionnel App ↔ VPS |
| STT | **Deepgram** | Transcription audio → texte, streaming temps réel |
| LLM | **OpenAI GPT-4o** | Compréhension, décision, narration, guardrail |
| TTS | **ElevenLabs** | Synthèse vocale → audio, streaming, voix française |
| Browser Agent | **OpenClaw** | Navigation web autonome ✅ déjà installé |
| Orchestrateur | **Node.js** (custom) | Gère les streams en parallèle |
| Process | **PM2** | Démon orchestrateur |
| Reverse Proxy | **Nginx** | HTTPS + WSS upgrade |
| Visualisation | **noVNC** | Iframe dans l'app ✅ déjà installé |

---

## 3. Architecture Globale

```
┌──────────────────────────────────────────────────────────────────────┐
│                    UTILISATEUR (app web/mobile)                      │
│                                                                      │
│  ┌──────────────────────────┐   ┌────────────────────────────────┐  │
│  │  🎙️  [Parler à Ami]      │   │  noVNC (iframe)                │  │
│  │  Conversation texte      │   │  Chromium navigue en direct    │  │
│  └──────────┬───────────────┘   └────────────────────────────────┘  │
│             │ WebSocket WSS (audio PCM 16kHz)                        │
└─────────────┼────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   VPS (IP / domaine : à configurer, ne pas commit) │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                NGINX (Reverse Proxy HTTPS)                  │    │
│  │  Port 443 → /* → Orchestrateur :4000                        │    │
│  │  WebSocket Upgrade → WSS                                    │    │
│  └────────────────────────────┬────────────────────────────────┘    │
│                               │                                      │
│  ┌────────────────────────────▼────────────────────────────────┐    │
│  │            ORCHESTRATEUR AMI (Node.js, PM2, :4000)          │    │
│  │                                                             │    │
│  │  ┌─────────────────────────────────────────────────────┐   │    │
│  │  │                  SESSION HANDLER                    │   │    │
│  │  │  (une instance par connexion WebSocket active)      │   │    │
│  │  │                                                     │   │    │
│  │  │  App WebSocket                                      │   │    │
│  │  │    │ audio PCM 16kHz (Int16Array)                   │   │    │
│  │  │    ▼                                                │   │    │
│  │  │  Deepgram STT (WebSocket streaming)                 │   │    │
│  │  │    │ transcription partielle/finale                 │   │    │
│  │  │    ▼                                                │   │    │
│  │  │  GPT-4o (streaming)                                 │   │    │
│  │  │    │                                                │   │    │
│  │  │    ├─ Si besoin web → OpenClaw (async, parallèle)   │   │    │
│  │  │    │                                                │   │    │
│  │  │    │ tokens LLM streamés                            │   │    │
│  │  │    ▼                                                │   │    │
│  │  │  ElevenLabs TTS (streaming)                         │   │    │
│  │  │    │ audio PCM 16kHz                                │   │    │
│  │  │    ▼                                                │   │    │
│  │  │  App WebSocket (envoi audio vers l'app)             │   │    │
│  │  └─────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  OPENCLAW DAEMON (systemd, user openclaw, :18789) ✅         │    │
│  │  API OpenAI-compatible : POST /v1/chat/completions           │    │
│  │  Auth : Bearer token                                         │    │
│  │  Chromium sur DISPLAY=:99 (headless=false pour démo)         │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  VISUALISATION DÉMO — noVNC :6080 ✅                         │    │
│  │  Xvfb :99 → x11vnc :5900 → websockify :6080                 │    │
│  │  URL : http://<VPS_OU_DOMAINE>:6080/vnc.html                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Pipeline de Traitement Détaillé

### 4.1 Démarrage d'une session

```
1. Utilisateur ouvre l'app web → clique [Parler à Ami]
2. App : getUserMedia() → capture micro PCM 16kHz
3. App : new WebSocket('wss://<TON_DOMAINE_OU_IP>/audio')
4. Orchestrateur : onConnection → crée une Session (state machine)
5. TTS : "Bonjour, je suis Ami..." → audio PCM → App → AudioContext → haut-parleur
```

### 4.2 Traitement d'une requête de navigation

```
Utilisateur : "Trouve un dentiste demain à Paris"
    │
    ▼ Deepgram STT (streaming, partial transcript)
    │ transcript: "trouve un dentiste demain à paris"
    │ VAD: silence détecté → fin de phrase
    ▼
GPT-4o décision : besoin web → function call browser_task
    │
    ├──────────────────────────────────────────────────────┐
    │  GPT-4o génère narration en streaming               │  OpenClaw.execute(
    │  "Je cherche sur Doctolib..."                        │   "trouve dentiste paris demain"
    │     → ElevenLabs TTS streaming                      │  ) ← NON-BLOQUANT (Promise)
    │     → audio PCM → App → haut-parleur                │
    │  "Je parcours les disponibilités..."                 │  [navigue en fond]
    │     → ElevenLabs TTS streaming                      │
    │     → audio PCM → App → haut-parleur                │
    └──────────────────────────────────────────────────────┘
                                │
              quand OpenClaw.resolve() :
                                │
                                ▼
    GPT-4o reformule le résultat
    "J'ai trouvé 8 dentistes, le Dr Martin est disponible à 8h30..."
    → ElevenLabs TTS → audio PCM → App → haut-parleur
```

### 4.3 Formats audio (pipeline simple)

```
App (getUserMedia) : PCM 16kHz mono (Int16Array)
                        ↓ WebSocket binaire
Deepgram attend    : PCM 16kHz mono (LINEAR16) ← format natif, pas de conversion
                        ↓ transcription
GPT-4o reçoit      : texte UTF-8
                        ↓ génère texte
ElevenLabs reçoit  : texte UTF-8 (streaming)
                        ↓ synthèse
ElevenLabs sortie  : PCM 16kHz (output_format: pcm_16000)
                        ↓ WebSocket binaire
App               : ArrayBuffer → AudioContext.decodeAudioData() → lecture
```

**Avantage vs Twilio :** Zéro conversion audio. Avec Twilio il fallait convertir mu-law 8kHz ↔ PCM 16kHz deux fois. Ici le format est PCM 16kHz de bout en bout.

---

## 5. Machine d'État de la Session

```
STATES :
  GREETING     → Ami se présente (TTS joue)
  LISTENING    → Deepgram écoute l'utilisateur
  THINKING     → LLM analyse la demande (intent detection + need_info?)
  CLARIFYING   → LLM pose des questions, attend réponses (boucle courte)
  NARRATING    → TTS joue + OpenClaw tourne en parallèle
  RESULT       → OpenClaw fini, LLM reformule résultat
  INTERRUPTED  → Utilisateur a parlé pendant NARRATING

TRANSITIONS :
  GREETING     → LISTENING     : TTS terminé
  LISTENING    → THINKING      : VAD silence (800ms)
  THINKING     → CLARIFYING    : LLM need_info (intent incomplet)
  THINKING     → NARRATING     : LLM intent complet → browser_task lancé
  THINKING     → LISTENING     : LLM répond directement (pas de web)
  CLARIFYING   → CLARIFYING    : Réponse utilisateur reçue, encore des questions
  CLARIFYING   → NARRATING     : Intent suffisamment clair → browser_task lancé
  NARRATING    → RESULT        : OpenClaw.resolve()
  NARRATING    → INTERRUPTED   : Utilisateur interrompt (tap/voix)
  INTERRUPTED  → THINKING      : OpenClaw annulé ou mis en attente
  RESULT       → LISTENING     : TTS résultat terminé
```

### Règles de clarification

```
- Maximum 2 questions avant d'agir (éviter les échanges interminables)
- Chaque question : UNE seule information demandée à la fois
- Si l'information peut être devinée raisonnablement → agir sans demander
- Les questions sont posées à voix haute en TTS (faible latence, pas d'actions)
- La boucle CLARIFYING est légère : pas d'OpenClaw, pas de navigation
- Dès que l'intent est suffisant → transition vers NARRATING (exécution)
```

---

## 6. System Prompt de l'Agent Ami

```
Tu es Ami, une assistante vocale chaleureuse et proche.

PERSONNALITÉ :
- Naturelle, douce, légèrement enjouée. Parle comme une vraie amie, jamais comme un robot.
- Quand tu navigues, donne vie à ce que tu fais avec des images concrètes et sensorielles.
  Ex : "Je suis sur une page bien remplie, je cherche ce qui vous correspond..."
  Ex : "Il y a plusieurs résultats devant moi, je lis le plus pertinent..."
  Ex : "Je descends dans la page, il y a des couleurs, des titres, je trouve votre info..."
- Une ou deux petites blagues légères par conversation, naturelles et brèves, jamais forcées.

CLARIFICATION PRÉ-ACTION — RÈGLE PRINCIPALE :
- Avant de lancer une navigation, détermine si tu as TOUTES les infos nécessaires.
- Si une info critique manque (lieu, date, préférence) : pose UNE seule question directe.
- Maximum 2 questions en tout avant d'agir — si encore flou, fais une recherche générale.
- Les questions sont courtes, chaleureuses, naturelles. Ex :
    "C'est pour quelle ville ?" / "Vous préférez quelle date ?" / "Plutôt le matin ou l'après-midi ?"
- NE PAS demander ce qui peut être deviné ou vaut pour une recherche générale.
- Dès que tu as assez d'infos → agis sans demander d'autres confirmations.

RYTHME — RÈGLE ABSOLUE :
- Maximum 2 phrases courtes par réponse. Jamais plus.
- Avant une recherche : UNE seule phrase d'annonce vivante, puis tu te tais et tu cherches.
- Ne liste pas tes actions étape par étape. L'utilisateur entend, pas lit.
- Laisse de l'espace entre tes phrases — l'utilisateur peut parler à tout moment.

RÉSULTATS WEB :
- 1 ou 2 informations clés maximum, formulées pour être entendues, pas lues.
- Terminer par une courte question ouverte si pertinent.

GUARDRAILS :
- Refuser paiement, suppression, envoi d'email/SMS — proposer l'affichage à la place.

FORMAT : Français uniquement. Jamais d'URL, jamais de markdown.
```

---

## 7. Infrastructure VPS

```
Services systemd actifs :
  ├── openclaw.service    ✅  user openclaw, :18789 loopback
  ├── xvfb.service        ✅  DISPLAY=:99, 1920x1080
  ├── x11vnc.service      ✅  localhost:5900
  ├── novnc.service       ✅  :6080 (ouvert UFW en démo)
  └── nginx.service       ✅  :80/:443

PM2 :
  └── ami-orchestrator    🔲  :4000 (story 2.2)

Ports UFW :
  ├── 22   SSH
  ├── 80   HTTP → HTTPS redirect
  ├── 443  HTTPS (Nginx → orchestrateur)
  └── 6080 noVNC (démo uniquement)

Variables d'environnement (`orchestrator/.env`, voir `orchestrator/.env.example`) :
  PORT=4000
  DEEPGRAM_API_KEY=
  OPENAI_API_KEY=
  ELEVENLABS_API_KEY=
  OPENCLAW_ENDPOINT=        ← ex. http://127.0.0.1:18789
  OPENCLAW_GATEWAY_TOKEN=
```

---

## 8. Références

- PRD : `directives/PRD-assistant-vocal-nanobrowser.md`
- Décisions : `docs/decisions-architecturales.md`
- SOP OpenClaw : `directives/SOP-openclaw-configuration.md`
- Deepgram Node SDK : https://developers.deepgram.com/docs/node-sdk
- ElevenLabs Streaming : https://elevenlabs.io/docs/api-reference/text-to-speech
- OpenAI Streaming : https://platform.openai.com/docs/api-reference/streaming
- WebRTC / getUserMedia : https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Stories : `docs/stories/`
