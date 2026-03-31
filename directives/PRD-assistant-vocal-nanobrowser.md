# PRODUCT REQUIREMENTS DOCUMENT (PRD)

> **Version :** 3.0 — Pivot Option 3 : Orchestration Twilio custom sur VPS
> **Projet :** Ami — Assistant Vocal IA pour Non-Voyants (Hackathon SHIFT)
> **Date :** 2026-03-28

---

## 1. Goals & Background

- **Contexte :** Les interfaces numériques actuelles (souris, clavier, écran) excluent les personnes non-voyantes ou malvoyantes. Un assistant vocal capable de naviguer sur le web à leur place résout ce problème fondamentalement.
- **Objectif :** Construire **Ami** — un agent vocal IA conversationnel qui répond au téléphone, comprend ce que l'utilisateur veut faire, navigue sur internet en parallèle, et parle en continu pendant qu'il cherche. Zéro silence. Zéro attente.
- **Cible :** Personnes non-voyantes ou malvoyantes.

---

## 2. Expérience Utilisateur Cible

```
👤 L'utilisateur ouvre l'app Ami sur son téléphone/ordinateur
   → Il appuie sur UN bouton : "Parler à Ami"
   → La conversation démarre immédiatement

🔊 Ami répond : "Bonjour, je suis Ami. Qu'est-ce que je peux faire pour vous ?"

👤 "Je voudrais trouver un dentiste disponible demain à Paris"

🔊 Ami : "Je cherche sur Doctolib..."          ← parle pendant que le browser tourne
          [OpenClaw navigue en arrière-plan]
🔊 Ami : "Je parcours les disponibilités..."   ← 4s plus tard, toujours en train de parler
          [OpenClaw filtre les résultats]
🔊 Ami : "J'ai trouvé 8 dentistes demain matin. Le premier disponible est le Dr Martin à 8h30,
          cabinet rue de Rivoli. Voulez-vous que je cherche d'autres informations ?"

👤 "Oui, est-ce qu'il parle anglais ?"
🔊 Ami : "Je vérifie sur son profil..."
          [OpenClaw consulte le profil]
🔊 Ami : "Oui, le Dr Martin parle anglais et accepte la carte vitale."
```

**Caractéristiques clés de l'expérience :**
- **Zéro silence** — Ami parle pendant toute la navigation (narration en continu)
- **Conversation naturelle** — l'utilisateur peut parler à tout moment, même pendant la navigation
- **Parallèle** — OpenClaw tourne en fond pendant qu'Ami continue la conversation
- **Empathique** — Ami est chaleureux, patient, fait des petites blagues

---

## 3. Requirements

### Fonctionnelles (FR)

- L'utilisateur doit pouvoir démarrer une conversation en appuyant sur **un bouton dans une app** (web ou mobile)
- L'app doit capturer le micro et streamer l'audio via **WebSocket** vers le VPS — pas de numéro de téléphone
- L'app doit afficher en parallèle le flux **noVNC** (le navigateur qui navigue en direct)
- L'agent Ami doit parler en continu pendant la navigation web — aucun silence > 2 secondes
- OpenClaw doit s'exécuter en parallèle de la conversation (non-bloquant)
- L'agent doit pouvoir recevoir une interruption de l'utilisateur même pendant la navigation
- L'agent doit refuser les actions irréversibles (paiement, suppression, envoi d'email)

### Non-fonctionnelles (NFR)

- **Latence STT :** Transcription du premier mot < 300ms (Deepgram streaming)
- **Latence TTS :** Premier token audio < 400ms (ElevenLabs streaming)
- **Silence max ressenti :** jamais plus de 2s sans parole de l'agent
- **100% vocal côté utilisateur** — un seul bouton, zéro navigation d'écran requise
- **Sécurité :** WSS (WebSocket sécurisé), OpenClaw sur loopback uniquement, pas d'actions irréversibles

---

## 4. Stack Technique (Orchestration VPS + App)

| Couche | Technologie | Rôle |
|--------|-------------|------|
| Interface utilisateur | **App web** (HTML/JS) ou React Native | Bouton micro + vue noVNC intégrée |
| Transport audio | **WebSocket natif** (WSS) | Stream audio PCM 16kHz bidirectionnel |
| STT | **Deepgram** | Transcription streaming temps réel |
| LLM | **OpenAI GPT-4o** | Compréhension + décision + narration |
| TTS | **ElevenLabs** | Synthèse vocale streaming français |
| Browser | **OpenClaw** | Navigation web autonome (déjà installé ✅) |
| Orchestrateur | **Node.js custom** | Gère les streams en parallèle |
| Process manager | **PM2** | Démon orchestrateur |
| Reverse proxy | **Nginx** | HTTPS + WSS public |
| Visualisation | **noVNC** | Chromium visible dans l'app (déjà installé ✅) |

**Pourquoi pas Twilio/téléphonie :**
Un WebSocket direct App → VPS est plus simple, moins cher (zéro coût téléphonie), et plus performant (pas de PSTN). Twilio ajoutait une couche inutile (App → réseau téléphonique → Twilio cloud → VPS) avec conversion audio mu-law 8kHz.

**Pourquoi pas Reecall/MCP :**
Reecall et tout système MCP-based bloquent la conversation pendant l'exécution du tool (10-15s de silence). L'orchestration custom sur VPS permet le traitement **parallèle** : OpenClaw tourne pendant qu'Ami continue de parler. La différence UX est radicale.

---

## 5. Architecture Haut Niveau

```
👤 Utilisateur (app mobile/web)
       │
       │  appuie sur [Parler à Ami]
       │
       ▼
┌────────────────────────────────┐
│  APP AMI (front-end)           │
│  - getUserMedia() micro        │
│  - WebSocket WSS               │
│  - iframe noVNC intégré        │
└────────────────┬───────────────┘
                 │ WebSocket WSS (audio PCM 16kHz)
                 ▼
┌─────────────────────────────────────────────────────────┐
│              VPS HETZNER — ORCHESTRATEUR AMI            │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │           Node.js Orchestrator (PM2)             │  │
│  │                                                  │  │
│  │  App WS ──► Deepgram STT ──► GPT-4o ──► ElevenLabs TTS ──► App WS  │
│  │                                    │                           │
│  │                          si besoin web                         │
│  │                                    │                           │
│  │                                    ▼  (non-bloquant)           │
│  │                              OpenClaw API                      │
│  │                              localhost:18789                   │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │           OpenClaw Daemon (systemd) ✅            │  │
│  │           Chromium sur DISPLAY=:99               │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │    Visualisation Démo — noVNC port 6080 ✅        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Roadmap d'Implémentation

### Phase 1 — Socle Technique ✅ TERMINÉ
| Story | Description | Statut |
|-------|-------------|--------|
| 1.1 | VPS Hetzner + Node.js + Chromium + Nginx | ✅ |
| 1.2 | OpenClaw installé et configuré | ✅ |
| 1.3 | noVNC — visualisation live navigateur | ✅ |

### Phase 2 — Orchestrateur Vocal
| Story | Description | Statut |
|-------|-------------|--------|
| 2.1 | Squelette Node.js + WebSocket audio navigateur | ✅ |
| 2.2 | Pipeline STT : Deepgram streaming (audio → texte) | ✅ |
| 2.3 | Pipeline TTS : ElevenLabs streaming (texte → WAV → browser WS) | ✅ |
| 2.4 | Pipeline LLM : GPT-4o streaming + system prompt Ami | ✅ |
| 2.5 | OpenClaw parallèle : exécution non-bloquante + narration | ✅ |

**Notes OpenClaw (story 2.5) :**
- `OPENCLAW_ENDPOINT` contient l'URL complète (avec `/v1/chat/completions`) — ne pas rajouter le path
- Timeout réel observé : ~8-35s selon les sites. Réglé à 50s (Doctolib est lourd)
- Narration : 1 phrase toutes les ~4s (300ms TTS + 1.5s pause). Pour 30s de navigation = ~7 phrases
- Reformulation via `streamLLM(..., { noTools: true })` — évite les boucles de function calls

**Notes TTS (story 2.3) :**
- Voix Charlotte — `XB0fDUnXU5powFXDhCwa` — excellente en français avec `eleven_turbo_v2_5`
- Format : `pcm_16000` → bufferisé → WAV (header 44 bytes) → envoyé binaire via WS
- Latence mesurée : **~330ms** (objectif < 400ms ✅)
- `AudioContext.decodeAudioData()` navigateur gère WAV nativement (mulaw non nécessaire)
- `.env` de production : `orchestrator/.env` à la racine du dépôt (chargé par `load-env.js`)
- PM2 : toujours utiliser `pm2 restart --update-env` pour recharger les variables

### Phase 3 — Intégration & Tests
| Story | Description |
|-------|-------------|
| 3.1 | Machine d'état : gestion interruptions + parallel state |
| 3.2 | Test E2E : appel → navigation → réponse vocale |

### Phase 4 — Qualité & Démo
| Story | Description |
|-------|-------------|
| 4.1 | Gestion erreurs, timeouts, reconnexions |
| 4.2 | Démo finale : noVNC + appel en direct devant les juges |
