const OPENCLAW_URL = process.env.OPENCLAW_ENDPOINT;       // URL complète /v1/chat/completions
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

// Phrases de narration jouées pendant qu'OpenClaw navigue.
// Évocatrices et imagées pour donner vie à la navigation.
export const NARRATION_PHRASES = [
  "Je suis en train d'ouvrir le site pour toi, tu peux te détendre je m'occupe de tout.",
  "Je navigue doucement, comme si je tournais les pages d'un carnet à ta place.",
  "Je regarde ce que le site affiche et je filtre ce qui peut t'aider.",
  "Je parcours calmement les informations pour repérer ce qui est important pour toi.",
  "Je vérifie ce qui apparaît à l'écran, tu n'as rien à faire pour le moment."
];

// Blagues courtes jouées pendant la latence de recherche.
// Légères, sans rapport avec le sujet — pour meubler naturellement pendant l'attente.
export const WAIT_JOKES = [
  "Ma grand-mère naviguait aussi sur internet... mais dans l'autre sens, avec une rame.",
  "Je vais si vite que même Google prend des notes.",
  "Ils disent que la patience est une vertu. Considérez-moi très vertueuse en ce moment.",
  "Un internaute et un escargot entrent dans un café. L'escargot commande. L'internaute attend encore la page.",
  "Je cherche tellement vite que mes doigts ont chaud. Enfin, façon de parler — je n'ai pas de doigts.",
];

/**
 * Lance une tâche OpenClaw et retourne le résultat textuel.
 * Non-bloquant : retourne une Promise que l'appelant peut await plus tard.
 *
 * @param {string} task       Instruction en français naturel
 * @param {object} opts
 * @param {AbortSignal} opts.signal    Pour annulation externe (story 3.1)
 * @param {number} opts.timeoutMs     Timeout en ms (défaut 50s — sites complexes)
 * @returns {Promise<string|null>}    Résultat textuel, ou null si annulé/timeout
 */
export async function executeTask(task, { signal, timeoutMs = 50000, conversationHistory = [], retries = 1 } = {}) {
  if (!OPENCLAW_URL || !OPENCLAW_TOKEN) {
    throw new Error('OPENCLAW_ENDPOINT ou OPENCLAW_GATEWAY_TOKEN manquant dans .env');
  }

  console.log('[OpenClaw] 🌐 Démarrage tâche:', task.slice(0, 80));

  const controller = new AbortController();

  // Propager annulation externe
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  const systemPrompt =
    'TU ES UN AGENT DE NAVIGATION WEB DÉTERMINISTE. '
    + 'TA SEULE MISSION : Utiliser ton outil browser avec le paramètre target="host" pour accomplir la tâche demandée. '
    + 'TU N\'AS PAS LE DROIT de dire "je ne peux pas", "je suis une IA", ou de suggérer à l\'utilisateur de visiter le site lui-même. '
    + 'Tu DOIS tenter la navigation, même si tu penses que c\'est impossible. '
    + 'Rapporte UNIQUEMENT ce que tu vois à l\'écran de ton navigateur sandboxé. '
    + 'Si une page ne charge pas, décris l\'erreur technique, ne donne pas d\'excuse de "capacité d\'IA". '
    + '\n\nGESTION DES MURS D\'AUTHENTIFICATION : '
    + 'Si tu rencontres un formulaire de connexion (login, email, mot de passe) ou une page restreinte : '
    + '1. Ne tente PAS de deviner ou de forcer la connexion. '
    + '2. Cherche IMÉDIATEMENT un numéro de téléphone ou un contact sur la page. '
    + '3. Retourne ce format exact : "CONNEXION_REQUISE | Numéro : [numéro] | Contexte : [résumé]"'
    + '\n\nRÈGLE LOCALISATION : '
    + 'Si la tâche mentionne une ville ou un lieu précis, sélectionne exactement cette option lorsque le site propose des suggestions. '
    + 'Ne remplace jamais une ville par un pays ou une zone large. '
    + 'Si aucune option exacte n’existe, indique clairement la limitation dans ton compte-rendu.';


  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    attempt += 1;

    // Timeout automatique (par tentative)
    const timer = setTimeout(() => {
      console.log(`[OpenClaw] ⏱️ Timeout (${timeoutMs}ms) — tentative ${attempt}/${retries + 1}`);
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(OPENCLAW_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENCLAW_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openclaw/default',
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .slice(-10)
              .map(m => ({ role: m.role, content: m.content })),
            {
              role: 'user',
              content: `ACTION REQUISE — effectue maintenant cette tâche de navigation :\n\n${task}\n\nRapporte exactement ce que tu vois sur la page (noms, horaires, disponibilités, prix...). Ne refuse pas, navigue.`,
            },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`OpenClaw HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const result = data.choices?.[0]?.message?.content;

      if (!result) throw new Error('OpenClaw : réponse vide');

      console.log(`[OpenClaw] ✅ Résultat reçu (tentative ${attempt}/${retries + 1}):`, result.slice(0, 120));
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        console.log('[OpenClaw] 🛑 Annulé');
        return null;
      }

      lastErr = err;
      console.error(`[OpenClaw] ❌ Erreur tentative ${attempt}/${retries + 1}:`, err.message);

      // Retenter sur erreurs transitoires
      const status = err.status;
      const shouldRetry = attempt <= retries && (status === 429 || (status >= 500 && status < 600) || !status);
      if (!shouldRetry) break;

      // Backoff court
      const delay = 900 * attempt;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr;
}
