# Décisions Architecturales — Ami, Agent Vocal IA

> **Document de référence** — Pourquoi on a choisi cette stack, et pourquoi on a écarté les alternatives.
> Mis à jour : 2026-03-28

---

## 1. Le Problème Central

### L'expérience utilisateur cible

L'utilisateur ouvre une **application légère** (web ou mobile). Il voit un bouton. Il appuie. Une conversation démarre avec Ami.

En parallèle — sur le même écran ou un écran dédié — on voit le navigateur Chromium naviguer en direct via noVNC.

```
[App mobile / web]                    [Écran parallèle — noVNC]
┌─────────────────────┐               ┌──────────────────────────┐
│                     │               │ http://VPS:6080/vnc.html │
│   🎙️  [Parler à Ami] │               │                          │
│                     │               │  Chromium navigue...     │
│  Ami : "Je cherche  │               │  → Doctolib.fr           │
│  sur Doctolib..."   │               │  → Filtres Paris         │
│                     │               │  → 8 résultats           │
└─────────────────────┘               └──────────────────────────┘
```

**Pas de numéro de téléphone.** Pas d'appel PSTN. Un bouton dans une app, un WebSocket, une conversation.

### La contrainte technique centrale

> **Le navigateur web prend 5 à 30 secondes pour exécuter une tâche.**
> Pendant ce temps, que se passe-t-il côté vocal ?

C'est cette contrainte qui dicte tous les choix architecturaux qui suivent.

---

## 2. Pourquoi pas Nanobrowser ?

**Nanobrowser** ([nanobrowser.ai](https://nanobrowser.ai)) est un agent web IA open-source que nous avons sérieusement évalué. Notre projet a bien une interface visuelle parallèle (noVNC montre Chromium naviguer en direct sur le VPS pour les juges). Alors pourquoi pas Nanobrowser ?

### 2.1 Nanobrowser n'expose pas d'API HTTP — il ne peut pas être contrôlé programmatiquement

C'est la raison fondamentale. Nanobrowser est une **extension Chrome** conçue pour être utilisée **interactivement par un humain** : on clique sur l'icône de l'extension, on tape une requête, on lit le résultat à l'écran.

Notre orchestrateur Node.js a besoin de faire ceci :
```javascript
// Ce dont on a besoin : appel programmatique depuis Node.js
const result = await fetch('http://localhost:18789/v1/chat/completions', {
  method: 'POST',
  body: JSON.stringify({
    model: 'openclaw/default',
    messages: [{ role: 'user', content: 'trouve un dentiste à Paris demain' }]
  })
});
const text = result.choices[0].message.content;
// → passe 'text' au TTS ElevenLabs
```

**OpenClaw** expose exactement cette API (format OpenAI-compatible). On l'appelle depuis Node.js, on reçoit le résultat, on le pipe dans le TTS. C'est son design natif.

**Nanobrowser** ne propose pas d'API HTTP. Pour s'en servir, il faut :
- Un humain qui ouvre Chrome et clique sur l'extension
- Ou une automatisation via Puppeteer/Playwright pour simuler des clics sur l'UI de l'extension — ce qui revient à écrire un wrapper custom autour d'un outil qui n'est pas conçu pour ça

### 2.2 Nanobrowser tourne sur la machine de l'utilisateur, pas sur le VPS

Nanobrowser est installé dans Chrome **là où Chrome est ouvert** — typiquement l'ordinateur de l'utilisateur. Pour que Nanobrowser tourne sur notre VPS (et soit visible via noVNC), il faudrait :
1. Lancer Chrome sur le VPS (déjà fait avec Xvfb + DISPLAY=:99) ✅
2. Installer l'extension Nanobrowser dans ce Chrome
3. **Contrôler l'extension à distance depuis Node.js** ← impossible nativement

On se retrouverait à simuler des clics sur l'UI de Nanobrowser via Playwright — c'est plus de code, moins fiable, et moins performant qu'OpenClaw qui a été conçu pour ça.

### 2.3 OpenClaw vs Nanobrowser — comparaison directe

| Critère | OpenClaw | Nanobrowser |
|---------|----------|-------------|
| API HTTP programmable | ✅ `POST /v1/chat/completions` | ❌ Pas d'API |
| Tourne comme daemon serveur | ✅ systemd service | ❌ Extension Chrome interactive |
| Intégration Node.js directe | ✅ fetch() | ❌ Nécessite un wrapper Playwright |
| Format de réponse structuré | ✅ JSON OpenAI-compatible | ❌ Résultat affiché dans l'UI |
| Déjà installé et configuré | ✅ | ❌ |
| Open-source | ✅ | ✅ |

### 2.4 Ce que Nanobrowser fait mieux (pour d'autres cas d'usage)

Nanobrowser est excellent pour un utilisateur voyant qui veut un agent IA dans son propre Chrome, sur son propre ordinateur. C'est une alternative crédible à OpenAI Operator pour usage personnel. Ce n'est simplement pas conçu pour être intégré comme composant serveur dans un pipeline vocal automatisé.

**Conclusion :** Si notre projet était "donne à l'utilisateur un agent IA dans son navigateur", Nanobrowser serait le bon choix. Notre projet est "un serveur répond à des appels téléphoniques et pilote un navigateur sur un VPS" — OpenClaw est le bon choix.

---

## 3. Pourquoi pas Vapi ?

**Vapi.ai** est une plateforme Voice AI SaaS qui gère STT + LLM + TTS + téléphonie.

### Ce que Vapi fait bien
- Gestion de la téléphonie (numéros, appels)
- STT/TTS intégrés
- Support des "tools" (fonction calls)
- Bonne documentation

### Pourquoi on l'a écarté

**Raison 1 — Pas de crédits hackathon gratuits**
Vapi est payant dès le premier appel. Pour un hackathon avec des dizaines de tests, le coût monte vite.

**Raison 2 — Même problème de silence que Reecall**
Vapi utilise un modèle de tool calling **bloquant** : quand un tool est appelé, la conversation est en pause jusqu'à ce que le tool réponde. Avec OpenClaw qui prend 10-15s, cela crée 10-15s de silence. Inacceptable pour un utilisateur aveugle.

**Raison 3 — Pas de contrôle sur le pipeline audio**
Vapi gère le stream audio en interne. Impossible d'implémenter la narration parallèle (parler pendant qu'OpenClaw tourne) sans contrôler le pipeline soi-même.

**Raison 4 — Dépendance SaaS**
Si Vapi change ses prix, son API, ou ferme — le projet meurt. Avec une stack custom, on est indépendants.

```
❌ Vapi
   → Payant dès le 1er appel
   → Tool calls bloquants → silence 10-15s
   → Pipeline audio opaque → narration parallèle impossible
   → Dépendance SaaS
```

---

## 4. Pourquoi pas Reecall ?

**Reecall** est la plateforme Voice AI qu'on avait initialement choisie. On l'a abandonnée après analyse approfondie.

### Ce que Reecall fait bien
- Support natif du protocole MCP
- Crédits hackathon gratuits
- STT/TTS/LLM managés
- Intégration ElevenLabs native
- Très peu de code à écrire

### Pourquoi on l'a écarté

**La raison fondamentale : le silence de 13 secondes.**

Reecall utilise MCP (Model Context Protocol) pour appeler des "tools" externes. Le fonctionnement est **synchrone** :

```
Reecall (cloud)
  → Appelle ton VPS via HTTP POST (MCP tool)
  → ATTEND... (le thread est bloqué)
  → Reçoit la réponse (10-15s plus tard)
  → Reprend la conversation
```

Pendant ces 10-15s : **silence total**. Le LLM de Reecall ne peut pas continuer la conversation pendant qu'il attend le résultat du tool. C'est une limitation architecturale du protocole MCP tel qu'implémenté par Reecall.

**Pour un utilisateur voyant**, 10s de silence avec un spinner à l'écran, c'est acceptable.
**Pour un utilisateur aveugle**, 10s de silence au téléphone = appel qui semble avoir planté = expérience catastrophique.

```
Timeline Reecall :
t=0s    Utilisateur parle
t=1s    STT transcrit
t=2s    LLM décide
t=2.5s  🔊 "Je cherche..." (phrase filler avant le tool)
t=3s    ████████████ SILENCE 12s ████████████
t=15s   🔊 "J'ai trouvé..."

Timeline Orchestrateur custom :
t=0s    Utilisateur parle
t=0.3s  STT transcrit (streaming)
t=0.5s  LLM décide + lance OpenClaw en parallèle
t=0.8s  🔊 "Je cherche sur Doctolib..."
t=3s    🔊 "Je parcours les résultats..."
t=6s    🔊 "Encore quelques secondes..."
t=12s   🔊 "J'ai trouvé 8 dentistes..."

Silence ressenti : 12s vs 0s
```

**Autres raisons d'écarter Reecall :**
- Pas de contrôle sur le pipeline audio → impossible d'interrompre le TTS quand l'utilisateur parle
- Dépendance à un SaaS tiers → risque de disponibilité
- Les crédits gratuits s'épuisent en production

---

## 5. Pourquoi pas une stack 100% locale (Whisper local + LLM local) ?

On a envisagé une stack entièrement auto-hébergée :
- Whisper (STT local)
- Ollama + Llama3 (LLM local)
- Piper ou Coqui (TTS local)

### Problèmes

**CPU/GPU insuffisants :** Whisper large en temps réel nécessite un GPU. Notre VPS Hetzner CX33 a 4 vCPU sans GPU. La transcription en temps réel serait trop lente (3-5s de latence STT).

**Qualité du TTS :** Les TTS locaux (Piper, Coqui) ont une qualité nettement inférieure à ElevenLabs. Pour un utilisateur aveugle qui passe des heures à écouter l'agent, la qualité vocale est critique.

**Temps de développement :** Configurer Whisper streaming + Ollama + Piper sur un VPS représente plusieurs jours de travail supplémentaires pour un résultat inférieur.

**Conclusion :** On garde les APIs cloud (Deepgram, OpenAI, ElevenLabs) mais on garde le **contrôle de l'orchestration** sur le VPS.

---

## 6. La Stack Choisie — Justification Composant par Composant

### 6.1 WebSocket natif — Transport Audio (pas de téléphonie)

**Pourquoi on n'a pas besoin de Twilio :**

L'utilisateur n'appelle pas un numéro de téléphone. Il ouvre une app et clique un bouton. Le transport audio est un **WebSocket standard** entre l'app et le VPS — pas de réseau téléphonique (PSTN), pas de SIM, pas de minutes facturées.

```
[App web/mobile]  ──── WebSocket WSS ────►  [VPS Orchestrateur]
  getUserMedia()        audio PCM 16kHz       Deepgram STT
  (microphone)     ◄───────────────────        ElevenLabs TTS
                        audio PCM 16kHz        OpenClaw
```

**Avantages par rapport à Twilio :**
- Zéro coût de téléphonie
- Pas de numéro à acheter
- Latence plus faible (WebSocket direct vs réseau téléphonique)
- Format audio libre (PCM 16kHz, pas de conversion mu-law)
- App intègre noVNC dans la même interface

**Stack côté app :**
- Web : `getUserMedia()` + `WebSocket` natif (~50 lignes JS)
- Mobile : React Native + `expo-av` ou `react-native-webrtc`
- Pour la démo : une simple page HTML suffit

**Alternative envisagée — Twilio :** écarté car ajoute une couche inutile (PSTN → Twilio cloud → VPS) et un coût, alors qu'un WebSocket direct est plus simple, plus rapide et gratuit.

### 6.2 Deepgram — STT

**Pourquoi Deepgram :**
- **Streaming natif** : premier transcript en 200ms (vs 1-2s pour Whisper API)
- **Accepte mu-law 8kHz nativement** : format exact de Twilio, zéro conversion audio
- Modèle `nova-2` : meilleur rapport qualité/latence pour le français
- VAD (Voice Activity Detection) intégré via `endpointing`
- $200 de crédits gratuits à l'inscription

**Alternative écartée :** OpenAI Whisper API — pas de streaming (fichier audio entier requis), latence 500ms-2s incompatible avec une conversation temps réel.

### 6.3 OpenAI GPT-4o — LLM

**Pourquoi GPT-4o :**
- Streaming avec function calling — indispensable pour la narration parallèle
- Meilleure compréhension du français naturel, avec les nuances (ambiguïté, humour, empathie)
- Function calling fiable : décide correctement quand appeler `browser_task`
- API déjà configurée sur le VPS (clé dans `.env`)

**Alternative possible :** Claude Sonnet — qualité similaire, légèrement moins cher. Peut être utilisé en fallback.

### 6.4 ElevenLabs — TTS

**Pourquoi ElevenLabs :**
- **Streaming** : premier chunk audio en 300ms
- Qualité vocale supérieure à tous les concurrents pour le français
- Voix naturelles, expressives — crucial pour un utilisateur qui écoute longtemps
- Plan gratuit suffisant pour le hackathon

**Alternative écartée :** OpenAI TTS — bonne qualité mais pas de streaming vrai (répond en batch), latence plus élevée.

### 6.5 OpenClaw — Browser Agent

**Pourquoi OpenClaw :**
- **Daemon serveur** : tourne en permanence sur le VPS, accessible via API HTTP
- API **OpenAI-compatible** : `POST /v1/chat/completions` — simple à intégrer
- Chromium **headless** en production, **visible** (DISPLAY=:99) pour la démo noVNC
- Déjà installé, configuré et testé ✅
- `headless=false` + noVNC = effet "glass box" pour les juges

**Alternative écartée :** Nanobrowser — extension Chrome côté client (voir section 2). Playwright direct — n'a pas l'intelligence de naviguer de façon autonome.

### 6.6 Orchestrateur Node.js custom — Le Cœur du Projet

**Pourquoi custom (et pas un framework existant) :**

C'est la décision la plus importante. Un framework comme LangChain, LlamaIndex, ou même Livekit Agents aurait pu être utilisé. On a choisi le code custom pour une raison : **le parallélisme entre OpenClaw et le TTS**.

Aucun framework vocal existant ne gère nativement ce pattern :
```
→ Lancer OpenClaw (async, non-bloquant)
→ Continuer à streamer du TTS pendant ce temps
→ Détecter les interruptions de l'utilisateur
→ Annuler OpenClaw si interruption
→ Reprendre quand OpenClaw finit
```

C'est une machine d'état custom avec 5 states. ~500 lignes de Node.js. Pas besoin de framework pour ça.

---

## 7. Récapitulatif des Choix

```
PROBLÈME RÉSOLU              SOLUTION CHOISIE              ALTERNATIVE ÉCARTÉE
────────────────────         ─────────────────             ──────────────────
Interface utilisateur        App web (bouton + micro)       Numéro de téléphone Twilio
Transport audio              WebSocket natif PCM 16kHz      Twilio PSTN, Vonage
Transcription voix           Deepgram streaming             OpenAI Whisper, Reecall STT
Compréhension + décision     GPT-4o streaming               Reecall LLM, Claude
Synthèse vocale              ElevenLabs streaming           OpenAI TTS, Reecall TTS
Navigation web               OpenClaw (daemon VPS)          Nanobrowser (extension), Playwright
Orchestration parallèle      Node.js custom                 Reecall, Vapi, LangChain
Visualisation démo           noVNC intégré dans l'app       Screen recording séparé
```

---

## 8. Ce Qu'on a Sacrifié

Cette architecture est plus complexe que Reecall+MCP. Voici ce qu'on a perdu en abandonnant les SaaS :

| Sacrifié | Impact | Mitigation |
|---|---|---|
| Facilité de setup | +2 jours de dev | Stories détaillées, code commenté |
| Numéro téléphone "clé en main" | Twilio trial limité | Vérifier les numéros de test |
| Moins de code | +500 lignes orchestrateur | Architecture modulaire (1 fichier = 1 responsabilité) |

**Ce qu'on a gagné :** zéro silence, conversation naturelle, contrôle total, indépendance des SaaS, expérience utilisateur radicalement meilleure pour un malvoyant.

---

## 9. Pour les Juges du Hackathon

**Ce que vous verrez pendant la démo — une seule interface, tout visible :**

```
┌──────────────────────────────────────────────────────────────────┐
│                    APP AMI (navigateur / mobile)                  │
│                                                                  │
│  ┌─────────────────────────┐   ┌──────────────────────────────┐  │
│  │   CONVERSATION          │   │   NAVIGATEUR EN DIRECT       │  │
│  │                         │   │   (noVNC intégré)            │  │
│  │  🎙️  [Parler à Ami]     │   │                              │  │
│  │                         │   │  Doctolib.fr                 │  │
│  │  Ami : "Je cherche      │   │  → tape "dentiste Paris"     │  │
│  │  sur Doctolib..."       │   │  → filtre "demain matin"     │  │
│  │                         │   │  → 8 résultats affichés      │  │
│  │  Ami : "J'ai trouvé     │   │    en direct...              │  │
│  │  8 dentistes..."        │   │                              │  │
│  └─────────────────────────┘   └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Ce qui est révolutionnaire dans cette démo :**
1. **Un bouton** — pas de numéro à composer, pas d'appel téléphonique
2. **Zéro silence** — Ami parle pendant toute la navigation, la conversation ne s'arrête jamais
3. **Glass box** — on voit exactement ce que l'IA fait sur le web, en temps réel, dans la même interface
4. **Pour les malvoyants** — 100% vocal, zéro interaction visuelle requise côté utilisateur

**La différence avec les autres projets :** l'agent ne s'arrête jamais de parler. Il narre en temps réel ce qu'il fait, comme un humain voyant qui aiderait son ami aveugle au téléphone. Pas un robot qui "traite une requête".
