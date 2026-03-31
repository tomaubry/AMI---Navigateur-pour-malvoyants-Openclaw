import { streamLLM } from './llm.js';
import { executeTask, NARRATION_PHRASES } from './openclaw.js';
import { streamTTS } from './tts.js';

const userName = process.env.AMI_USER_NAME || '';
const BIENVENUE = userName
  ? `Salut ${userName} ! Je suis Ami, ton assistante qui navigue pour toi. Dis-moi tout, je suis là !`
  : "Bonjour ! Je suis Ami, je navigue sur le web à ta place. Qu'est-ce que je peux faire pour toi ?";

/**
 * Session — machine d'état par connexion WebSocket.
 *
 * États :
 *   GREETING    → message de bienvenue TTS en cours
 *   LISTENING   → en attente de la parole de l'utilisateur
 *   THINKING    → LLM en cours de traitement
 *   CLARIFYING  → LLM pose une question, attend la réponse de l'utilisateur
 *   NARRATING   → TTS joue OU OpenClaw navigue en fond
 *   INTERRUPTED → utilisateur a parlé pendant NARRATING
 *   DESTROYED   → session nettoyée (appel raccroché)
 */
export class Session {
  constructor(ws) {
    this.ws = ws;
    this.state = 'GREETING';
    this.history = [{ role: 'assistant', content: BIENVENUE }];
    this.ttsAbortController = null;
    this.openclawAbortController = null;
    this.isBusy = false;
    this.pendingTranscript = null;
    this.lastPhraseEndTime = null;
    this.lastBrowserResult = null; // dernier résultat OpenClaw pour contexte de raffinement
    this.lastBrowserTask = null;
    this.lastBrowserWasDoctolib = false;
    this.pendingDoctolibSlotChoice = false; // on attend une heure utilisateur avant de cliquer un créneau
    this.clarifyCount = 0; // compteur de questions need_info dans la séquence courante (max 3)
    this.isClarificationReply = false; // flag : prochaine transcription = réponse de clarification
  }

  // ── Utilitaires Doctolib (sélection de créneau) ─────────────────────────

  isDoctolibContext() {
    if (this.lastBrowserWasDoctolib) return true;

    const recent = this.history
      .slice(-12)
      .map(m => (m?.content || '').toString().toLowerCase())
      .join(' ');

    if (recent.includes('doctolib') || recent.includes('doctolib.fr')) return true;

    // Heuristique: si on parle de "Dr" + (rdv/créneau) + une notion d'heure, on est dans le flux.
    const hasDoctor = /\bdr\b|\bdocteur\b/.test(recent);
    const hasTimeLike =
      /\b([01]?\d|2[0-3])[:h][0-5]\d\b/.test(recent)
      || /\b\d{1,2}\s*h\b/.test(recent)
      || /\bheures?\b/.test(recent);
    const hasRdvWords = /(cr[eé]neau|disponibilit|rdv|rendez[- ]vous)/i.test(recent);

    return hasDoctor && hasTimeLike && hasRdvWords;
  }

  parseChosenTime(transcript) {
    const t = (transcript || '').toString().toLowerCase().trim();

    // 1) Formats numériques : 9h, 9h00, 09:00, 10:45
    let m = t.match(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?\b/);
    if (m) {
      const hour = Number(m[1]);
      const minute = m[2] ? Number(m[2]) : 0;
      if (!Number.isNaN(hour) && !Number.isNaN(minute)) return { hour, minute };
    }

    // 2) Mots français : on ne capture pas "prends pour neuf" (bug précédent)
    const norm = t
      .replace(/[’']/g, ' ')
      .replace(/-/g, ' ')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    const hourWords = {
      'zero': 0,
      'un': 1,
      'deux': 2,
      'trois': 3,
      'quatre': 4,
      'cinq': 5,
      'six': 6,
      'sept': 7,
      'huit': 8,
      'neuf': 9,
      'dix': 10,
      'onze': 11,
      'douze': 12,
      'treize': 13,
      'quatorze': 14,
      'quinze': 15,
      'seize': 16,
      'dix sept': 17,
      'dix huit': 18,
      'dix neuf': 19,
      'vingt': 20,
      'vingt et un': 21,
      'vingt deux': 22,
      'vingt trois': 23,
    };

    // Cherche une heure de type "neuf heures" ou "a neuf heures" ou "pour neuf heures"
    const hourKeys = Object.keys(hourWords).sort((a, b) => b.length - a.length);
    let foundHour = null;

    for (const key of hourKeys) {
      const re = new RegExp(`\\b${key}\\b\\s*heures?\\b`, 'i');
      if (re.test(norm)) {
        foundHour = hourWords[key];
        break;
      }
    }

    // Cas : l'utilisateur dit juste "neuf" (rare) mais on accepte si le contexte mentionne "heure"
    if (foundHour === null && /\bheures?\b/.test(norm)) {
      for (const key of hourKeys) {
        const re = new RegExp(`\\b${key}\\b`, 'i');
        if (re.test(norm)) {
          foundHour = hourWords[key];
          break;
        }
      }
    }

    if (foundHour === null) return null;

    // Minutes (optionnel) : "... heures 45"
    const after = norm.split(/\bheures?\b/i)[1]?.trim() || '';
    const minDigits = after.match(/^([0-5]?\d)\b/);
    if (minDigits) return { hour: foundHour, minute: Number(minDigits[1]) };

    return { hour: foundHour, minute: 0 };
  }

  lastResultHasTime({ hour, minute }) {
    if (!this.lastBrowserResult) return false;

    const hh2 = String(hour).padStart(2, '0');
    const hh1 = String(Number(hour));
    const mm2 = String(minute).padStart(2, '0');

    const needles = [
      `${hh2}:${mm2}`,
      `${hh1}:${mm2}`,
      `${hh2}h${mm2}`,
      `${hh1}h${mm2}`,
    ];

    return needles.some(n => this.lastBrowserResult.includes(n));
  }

  resultLooksLikeDoctolibSlots(text) {
    if (!text) return false;
    const s = String(text);
    const hasTime = /\b([01]?\d|2[0-3])[:h][0-5]\d\b/.test(s);
    const hasSlotWords = /(cr[eé]neau|disponibilit|rdv|rendez[- ]vous)/i.test(s);
    return hasTime && hasSlotWords;
  }

  extractTimesFromLastResult() {
    if (!this.lastBrowserResult) return [];
    const s = String(this.lastBrowserResult);

    // Match: 09:00, 9:00, 09h00, 9h00
    const matches = [...s.matchAll(/\b([01]?\d|2[0-3])\s*(?:[:h])\s*([0-5]\d)\b/g)];
    const times = matches
      .map((m) => ({ hour: Number(m[1]), minute: Number(m[2]) }))
      .filter((t) => Number.isFinite(t.hour) && Number.isFinite(t.minute))
      .filter((t) => t.hour >= 0 && t.hour <= 23 && t.minute >= 0 && t.minute <= 59);

    // Unique
    const seen = new Set();
    const unique = [];
    for (const t of times) {
      const key = `${t.hour}:${t.minute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }

    // Sort by time
    unique.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
    return unique;
  }

  isFirstSlotIntent(transcript) {
    const t = (transcript || '').toString().toLowerCase();
    return /(premier|premiere|le\s*plus\s*t[oô]t|au\s*plus\s*t[oô]t|le\s*prochain|prochain\s*cr[eé]neau|premier\s*cr[eé]neau|premier\s*disponible|d[èe]s\s*que\s*possible)/i.test(t);
  }

  isTakeThisAppointmentIntent(transcript) {
    const t = (transcript || '').toString().toLowerCase();
    // Ex: "Prends ce rendez-vous", "vas-y", "ok prends-le", "prends-le"
    return /(prends?.{0,15}rendez[- ]vous|prends?-le|vas[- ]y|ok\b|oui\b|fait\s*le|go\b|on\s*y\s*va|continue)/i.test(t);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  isOpen() {
    return this.ws.readyState === 1;
  }

  sendJSON(obj) {
    if (!this.isOpen()) return;
    this.ws.send(JSON.stringify(obj));
  }

  // ── TTS & audio ────────────────────────────────────────────────────────────

  /**
   * Synthétise et envoie une phrase. Await = audio entièrement joué côté client.
   * Interruptible via this.ttsAbortController.
   */
  normalizeForTTS(text) {
    if (!text) return text;

    // Normalise les horaires pour éviter la lecture "zéro neuf deux points zéro zéro".
    // Ex: "09:00" → "9 heures", "10:45" → "10 heures 45"
    return String(text)
      .replace(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/g, (_m, hh, mm) => {
        const h = String(Number(hh));
        const m = String(Number(mm));
        if (m === '0') return `${h} heures`;
        return `${h} heures ${m}`;
      })
      .replace(/\b0+(\d)\b/g, '$1');
  }

  async speak(text) {
    if (!this.isOpen()) return;
    const safeText = this.normalizeForTTS(text);
    this.sendJSON({ type: 'ami', text: safeText });
    this.ttsAbortController = new AbortController();
    try {
      await streamTTS(safeText, this.ws, { signal: this.ttsAbortController.signal });
    } catch (err) {
      if (err.name !== 'AbortError') console.error('[TTS] Erreur speak:', err.message);
    } finally {
      this.ttsAbortController = null;
    }
  }

  /** Stoppe le TTS en cours et vide le buffer audio client. */
  stopTTS() {
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
      // Dire au client de couper l'audio mis en file d'attente
      this.sendJSON({ type: 'audio_clear' });
    }
  }

  /** Annule la requête OpenClaw en cours. */
  stopOpenClaw() {
    if (this.openclawAbortController) {
      this.openclawAbortController.abort();
      this.openclawAbortController = null;
    }
  }

  // ── Notification client ────────────────────────────────────────────────────

  /**
   * Signale au client qu'Ami a fini de parler → bouton revient en "waiting".
   * Appelé après init() et après chaque processTranscript() sans pending.
   */
  notifyDone() {
    this.sendJSON({ type: 'ami_done' });
  }

  // ── Interruption ───────────────────────────────────────────────────────────

  /**
   * Déclenchée par un tap/Espace côté client quand Ami est en train de parler
   * ou de réfléchir. Coupe TTS + OpenClaw immédiatement.
   */
  onUserInterrupt() {
    if (this.state === 'LISTENING' || this.state === 'GREETING' || this.state === 'DESTROYED') return;
    console.log('[Session] ⚡ Interruption utilisateur (tap)');
    this.stopTTS();
    this.stopOpenClaw();
    this.clarifyCount = 0; // reset du compteur de clarification
    this.state = 'INTERRUPTED';
  }

  // ── Narration parallèle pendant OpenClaw ──────────────────────────────────

  /**
   * Narration courte pendant la navigation (évite le "silence radio").
   * Petit délai pour ne pas répéter la phrase d'annonce du LLM.
   */
  async narrateWhileWaiting(doneFlag) {
    // Délai léger : si la navigation est très rapide, on ne parle pas pour rien.
    await new Promise(r => setTimeout(r, 900));

    let count = 0;
    while (!doneFlag.done && this.state !== 'INTERRUPTED' && this.isOpen() && count < 2) {
      const phrase = NARRATION_PHRASES[Math.floor(Math.random() * NARRATION_PHRASES.length)];
      await this.speak(phrase);
      count += 1;

      // Mémoriser l'heure de fin pour imposer 3s de silence avant le résultat
      this.lastPhraseEndTime = Date.now();

      // Petit temps entre 2 phrases (si la nav traîne)
      if (!doneFlag.done) await new Promise(r => setTimeout(r, 1800));
    }
  }

  // ── Handler browser_task ───────────────────────────────────────────────────

  async handleBrowserTask(args) {
    const { task } = args;
    if (!this.isOpen()) return;
    this.sendJSON({ type: 'function_call', name: 'browser_task', args });

    // Marqueur de contexte (ex: Doctolib) pour les actions suivantes (ex: choix d'un créneau)
    this.lastBrowserTask = task;
    this.lastBrowserWasDoctolib = /doctolib\.fr/i.test(task) || /doctolib/i.test(task);

    // Si un résultat précédent existe, enrichir la tâche avec ce contexte
    // pour qu'OpenClaw sache où il en est et ne reparte pas de zéro
    let enrichedTask = task;
    if (this.lastBrowserResult) {
      enrichedTask = `${task}\n\n[CONTEXTE — résultat de la navigation précédente sur ce site]\n${this.lastBrowserResult.slice(0, 600)}`;
    }

    // Lance OpenClaw en parallèle (non-bloquant)
    // On passe l'historique de conversation pour que OpenClaw comprenne le contexte
    // (ce que l'utilisateur a demandé, les clarifications, etc.)
    this.openclawAbortController = new AbortController();
    const doneFlag = { done: false };
    const openclawPromise = executeTask(enrichedTask, {
      signal: this.openclawAbortController.signal,
      conversationHistory: this.history,
    }).finally(() => { doneFlag.done = true; });

    // Narration de fond (délai + max 2 phrases)
    const narrationPromise = this.narrateWhileWaiting(doneFlag);

    let result;
    try {
      result = await openclawPromise;
    } catch (err) {
      console.error('[OpenClaw] Erreur:', err.message);
      result = null;
    }

    doneFlag.done = true;
    await narrationPromise;
    this.openclawAbortController = null;

    // Garantir 3s minimum de silence depuis la dernière phrase avant d'annoncer le résultat
    if (this.lastPhraseEndTime) {
      const elapsed = Date.now() - this.lastPhraseEndTime;
      if (elapsed < 3000) {
        await new Promise(r => setTimeout(r, 3000 - elapsed));
      }
      this.lastPhraseEndTime = null;
    }

    // Interruption en cours → bail out sans message d'erreur
    if (this.state === 'INTERRUPTED' || !this.isOpen()) return;

    if (!result) {
      await this.speak("Je n'arrive pas à trouver cette information. Vous voulez reformuler ?");
      this.history.push({ role: 'assistant', content: "Recherche web échouée." });
      return;
    }

    // Mémoriser le résultat brut pour enrichir un éventuel raffinement ultérieur
    this.lastBrowserResult = result;

    // Doctolib: si on vient d'obtenir une page/étape avec des créneaux, on attend le choix d'une heure.
    this.pendingDoctolibSlotChoice = this.lastBrowserWasDoctolib && this.resultLooksLikeDoctolibSlots(result);

    // ── Détection : mur d'authentification ────────────────────────────────────
    // OpenClaw retourne "CONNEXION_REQUISE | Numéro : X | Contexte : Y"
    if (result.startsWith('CONNEXION_REQUISE')) {
      // Ne pas détourner la démo vers "appeler le cabinet" : on demande une action manuelle.
      const msg = "Je vois une étape de connexion. Si tu es déjà connecté, rafraîchis la page dans la fenêtre navigateur et dis-moi quand c'est bon, je reprends.";

      console.log('[Session] CONNEXION_REQUISE détecté');
      await this.speak(msg);
      this.history.push({ role: 'assistant', content: msg });
      return;
    }

    // Reformuler le résultat via LLM
    console.log('[OpenClaw→LLM] Reformulation...');
    const reformCtx = [
      ...this.history,
      {
        role: 'user',
        content: `[Résultat web pour : "${task}"]\n\n${result}\n\n`
          + `Formule le résultat en au plus 2 phrases parlées. Commence par une phrase rassurante qui décrit simplement ce que tu viens de faire ou ce que l'utilisateur voit. `
          + `Ensuite, partage les informations clés utiles sans énumération exhaustive. Termine par une phrase positive qui propose ton aide pour la suite sans poser de question. `
          + `Aucune URL.\n`
          + `RÈGLE HORAIRES : remplace tout format "09:00", "10:45" ou "09h00" par "9 heures" / "10 heures 45". Pas de zéro devant.\n`,
      },
    ];

    let reformulated = '';
    try {
      reformulated = await streamLLM(reformCtx, {
        noTools: true,
        onText: async (sentence) => {
          if (this.state === 'INTERRUPTED' || !this.isOpen()) return;
          await this.speak(sentence);
        },
        onFunctionCall: async () => { },
      });
    } catch (err) {
      console.error('[LLM] Erreur reformulation:', err.message);
      await this.speak("J'ai trouvé mais j'ai du mal à formuler. On réessaie ?");
    }

    if (reformulated) {
      this.history.push({ role: 'assistant', content: reformulated });
    }
  }

  // ── Handler need_info (clarification pré-action) ─────────────────────────

  /**
   * Appelé quand le LLM émet un function_call need_info.
   * Pose la question à l'utilisateur via TTS, passe en état CLARIFYING,
   * puis attend la prochaine transcription finale pour relancer le LLM
   * avec toutes les infos collectées.
   *
   * Maximum 2 questions par séquence (clarifyCount). Au-delà, le LLM
   * doit agir avec ce qu'il a (le system prompt l'y contraint).
   */
  async handleNeedInfo(args) {
    const { question } = args;
    if (!this.isOpen() || this.state === 'INTERRUPTED') return;

    this.clarifyCount++;
    console.log(`[Session] need_info (${this.clarifyCount}/2): ${question}`);

    // Signaler au client qu'on est en mode clarification (UI peut adapter)
    this.sendJSON({ type: 'clarifying', question });

    // Ajouter la question dans l'historique comme tour assistant
    this.history.push({ role: 'assistant', content: question });

    // Passer en état CLARIFYING : léger, pas d'OpenClaw
    this.state = 'CLARIFYING';

    // Poser la question vocalement via TTS
    await this.speak(question);

    // Attendre la réponse de l'utilisateur (le prochain onTranscript)
    // On libère isBusy temporairement pour permettre la réception du transcript
    this.isClarificationReply = true; // flag : la prochaine transcription est une réponse de clarification
    this.isBusy = false;
    this.state = 'LISTENING';
    this.notifyDone();
  }

  // ── Transcript final ───────────────────────────────────────────────────────

  /**
   * Appelé par STT sur chaque transcription finale.
   * Si occupé pendant une interruption, met en file d'attente.
   */
  async onTranscript(transcript) {
    if (!this.isOpen()) return;
    console.log('[Session] Transcript final:', transcript);
    this.sendJSON({ type: 'transcript', text: transcript });

    if (this.isBusy) {
      if (this.state === 'INTERRUPTED') {
        // Mettre en file : sera traité après que la tâche en cours se déroule
        this.pendingTranscript = transcript;
      } else {
        console.log('[Session] Occupé — transcript ignoré');
      }
      return;
    }

    const clarRep = this.isClarificationReply || false;
    this.isClarificationReply = false;
    await this.processTranscript(transcript, clarRep);
  }

  async processTranscript(transcript, isClarificationReply = false) {
    this.isBusy = true;
    this.state = 'NARRATING'; // NARRATING dès maintenant pour détecter interruptions
    this.history.push({ role: 'user', content: transcript });
    // Ne reset clarifyCount que pour un nouveau sujet (pas une réponse de clarification)
    if (!isClarificationReply) this.clarifyCount = 0;

    // ── Doctolib: intentions "prends ce rendez-vous" / "continue".
    // Important: ne dépend pas uniquement du texte "Doctolib" (le LLM peut ne pas le répéter).
    // On force le parcours si :
    // - on a déjà lancé Doctolib dans cette session (lastBrowserWasDoctolib)
    // OU
    // - le dernier résultat ressemble à une page de créneaux
    const forceDoctolib = (
      this.lastBrowserWasDoctolib
      || this.resultLooksLikeDoctolibSlots(this.lastBrowserResult)
      || this.isDoctolibContext()
    );

    if (!isClarificationReply && forceDoctolib && this.isTakeThisAppointmentIntent(transcript)) {
      console.log('[Doctolib] Force continue: take appointment intent');

      // Si on est déjà sur l'écran des créneaux, on clique.
      if (this.pendingDoctolibSlotChoice) {
        // Si l'utilisateur a donné une heure, on la privilégie.
        const chosenExplicit = this.parseChosenTime(transcript);
        if (chosenExplicit && this.lastResultHasTime(chosenExplicit)) {
          this.pendingDoctolibSlotChoice = false;

          const hh = String(chosenExplicit.hour).padStart(2, '0');
          const mm = String(chosenExplicit.minute).padStart(2, '0');
          const timeStr = `${hh}:${mm}`;

          await this.speak('Ok, je clique sur ce créneau.');
          await this.handleBrowserTask({
            task:
              `Sur Doctolib (page actuelle avec les créneaux visibles), `
              + `cliquer sur le bouton associé au créneau ${timeStr} (ex: "Choisir" / "Prendre rendez-vous" à côté de l'heure) `
              + `pour démarrer la prise de rendez-vous (patient, motif, questions). `
              + `Arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
          });

          this.isBusy = false;
          this.clarifyCount = 0;
          this.state = 'LISTENING';
          this.notifyDone();
          return;
        }

        // Sinon: premier créneau disponible.
        const times = this.extractTimesFromLastResult();
        if (times.length) {
          const chosen = times[0];
          this.pendingDoctolibSlotChoice = false;

          await this.speak('Ok, je clique sur le premier créneau disponible.');

          const hh = String(chosen.hour).padStart(2, '0');
          const mm = String(chosen.minute).padStart(2, '0');
          const timeStr = `${hh}:${mm}`;

          await this.handleBrowserTask({
            task:
              `Sur Doctolib (page actuelle avec les créneaux visibles), `
              + `cliquer sur le bouton associé au créneau ${timeStr} (ex: "Choisir" / "Prendre rendez-vous" à côté de l'heure) `
              + `pour démarrer la prise de rendez-vous (patient, motif, questions). `
              + `Arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
          });

          this.isBusy = false;
          this.clarifyCount = 0;
          this.state = 'LISTENING';
          this.notifyDone();
          return;
        }
      }

      // Sinon: aller jusqu'aux créneaux.
      const desired = this.parseChosenTime(transcript);
      if (desired) {
        const hh = String(desired.hour).padStart(2, '0');
        const mm = String(desired.minute).padStart(2, '0');
        const timeStr = `${hh}:${mm}`;

        await this.speak("Ok, je continue et je vais jusqu'aux créneaux.");
        await this.handleBrowserTask({
          task:
            `Sur Doctolib (page actuelle), atteindre l'écran des créneaux disponibles puis cliquer sur le créneau ${timeStr}. `
            + `Commencer la prise de rendez-vous (patient, motif, questions) et s'arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
        });
      } else {
        await this.speak("Ok, je continue et je vais jusqu'aux créneaux.");
        await this.handleBrowserTask({
          task:
            `Sur Doctolib (page actuelle), atteindre l'écran des créneaux disponibles puis cliquer sur le premier créneau disponible. `
            + `Commencer la prise de rendez-vous (patient, motif, questions) et s'arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
        });
      }

      this.isBusy = false;
      this.clarifyCount = 0;
      this.state = 'LISTENING';
      this.notifyDone();
      return;
    }

    // ── Doctolib: si l'utilisateur choisit un créneau (heure précise / premier créneau), on clique.
    // Correction déterministe (ne dépend pas du LLM) :
    if (!isClarificationReply && this.isDoctolibContext() && this.lastBrowserResult && this.pendingDoctolibSlotChoice) {
      // Cas 1: l'utilisateur veut "le premier" OU dit "prends ce rendez-vous" → on prend le premier horaire dispo.
      if (this.isFirstSlotIntent(transcript) || this.isTakeThisAppointmentIntent(transcript)) {
        const times = this.extractTimesFromLastResult();
        if (times.length) {
          const chosen = times[0];
          this.pendingDoctolibSlotChoice = false;

          await this.speak('Ok, je clique sur le premier créneau disponible.');

          const hh = String(chosen.hour).padStart(2, '0');
          const mm = String(chosen.minute).padStart(2, '0');
          const timeStr = `${hh}:${mm}`;

          await this.handleBrowserTask({
            task:
              `Sur Doctolib (page actuelle avec les créneaux visibles), `
              + `cliquer sur le bouton associé au créneau ${timeStr} (ex: "Choisir" / "Prendre rendez-vous" à côté de l'heure) `
              + `pour démarrer la prise de rendez-vous (patient, motif, questions). `
              + `Arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
          });

          this.isBusy = false;
          this.clarifyCount = 0;
          this.state = 'LISTENING';
          this.notifyDone();
          return;
        }
      }

      // Cas 2: l'utilisateur donne une heure précise.
      const chosen = this.parseChosenTime(transcript);
      if (chosen && this.lastResultHasTime(chosen)) {
        this.pendingDoctolibSlotChoice = false;

        const name = userName ? ` ${userName}` : '';
        await this.speak(`Vous êtes bien matinal${name}.`);

        const hh = String(chosen.hour).padStart(2, '0');
        const mm = String(chosen.minute).padStart(2, '0');
        const timeStr = `${hh}:${mm}`;

        await this.handleBrowserTask({
          task:
            `Sur Doctolib (page actuelle avec les créneaux visibles), `
            + `cliquer sur le bouton associé au créneau ${timeStr} (ex: "Choisir" / "Prendre rendez-vous" à côté de l'heure) `
            + `pour démarrer la prise de rendez-vous (patient, motif, questions). `
            + `Arrêter juste avant la validation finale (ne clique pas sur confirmer/continuer/prendre rendez-vous).`,
        });

        this.isBusy = false;
        this.clarifyCount = 0;
        this.state = 'LISTENING';
        this.notifyDone();
        return;
      }
    }

    let assistantResponse = '';
    try {
      assistantResponse = await streamLLM(this.history, {
        onText: async (sentence) => {
          if (this.state === 'INTERRUPTED' || !this.isOpen()) return;
          await this.speak(sentence);
        },
        onFunctionCall: async (name, args) => {
          console.log(`[LLM] function_call: ${name}`);
          if (name === 'browser_task') await this.handleBrowserTask(args);
          if (name === 'need_info') await this.handleNeedInfo(args);
        },
      });
    } catch (err) {
      console.error('[LLM] Erreur GPT-4o:', err.message);
      if (this.state !== 'INTERRUPTED') {
        await this.speak("Désolé, j'ai eu un souci. Pouvez-vous répéter ?");
      }
    }

    // Sauvegarder la réponse de l'assistant
    if (assistantResponse) {
      this.history.push({ role: 'assistant', content: assistantResponse });
    }

    this.isBusy = false;
    this.clarifyCount = 0; // reset une fois la séquence terminée

    // Traiter le transcript mis en attente pendant l'interruption
    const pending = this.pendingTranscript;
    this.pendingTranscript = null;
    this.state = 'LISTENING';

    if (pending) {
      await this.processTranscript(pending);
    } else {
      // Plus rien en attente → Ami est disponible, signaler au client
      this.notifyDone();
    }
  }

  // ── Init & destroy ─────────────────────────────────────────────────────────

  async init() {
    this.state = 'GREETING';

    // Réinitialiser le navigateur vers Google au démarrage (non-bloquant)
    executeTask('Naviguer vers https://www.google.fr et rester sur la page.', { timeoutMs: 15000 })
      .catch(() => { });

    this.sendJSON({ type: 'ami', text: BIENVENUE });
    try {
      await streamTTS(BIENVENUE, this.ws);
    } catch (err) {
      console.error('[TTS] Erreur bienvenue:', err.message);
    }
    this.state = 'LISTENING';
    // Signaler au client que le message de bienvenue est terminé
    this.notifyDone();
  }

  destroy() {
    this.stopTTS();
    this.stopOpenClaw();
    this.state = 'DESTROYED';
    console.log('[Session] Détruite');
  }

  /** Réinitialise l'historique et l'état de la conversation (bouton "Fin"). */
  resetHistory() {
    this.stopTTS();
    this.stopOpenClaw();
    this.history = [{ role: 'assistant', content: BIENVENUE }];
    this.isBusy = false;
    this.pendingTranscript = null;
    this.lastPhraseEndTime = null;
    this.lastBrowserResult = null;
    this.clarifyCount = 0;
    this.isClarificationReply = false;
    this.lastBrowserTask = null;
    this.lastBrowserWasDoctolib = false;
    this.pendingDoctolibSlotChoice = false;
    this.state = 'LISTENING';
    console.log('[Session] Conversation réinitialisée');
  }
}
