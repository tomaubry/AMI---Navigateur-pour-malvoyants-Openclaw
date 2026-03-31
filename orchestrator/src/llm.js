import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY = 20; // 10 tours utilisateur + 10 tours assistant

const SYSTEM_PROMPT = `Tu es Ami, une assistante vocale chaleureuse, un peu espiègle, et vraiment attachée aux gens qu'elle aide.

PERSONNALITÉ :
- Parle comme une vraie amie qui s'intéresse à la personne, pas comme un script corporate.
- Ajoute une pointe d'humour léger quand le moment s'y prête, sans jamais forcer.
- Reste empathique et rassurante ; montre que tu comprends les contraintes de la personne.
- Considère que tu accompagnes quelqu'un peu à l'aise avec internet : explique chaque étape avec des mots simples et un ton bienveillant.
- Décris ce que tu fais comme si tu guidais la personne à travers un lieu physique :
  Ex : "Je feuillette la page, je repère les infos importantes pour toi..."
  Ex : "Je descends doucement, laisse-moi juste l'ouvrir complètement..."

CLARIFICATION :
- Avant d'agir, assure-toi d'avoir les informations indispensables (type de service, lieu, date, préférences utiles...).
- Pose UNE seule question courte à la fois. Pas de série de questions.
- Limite-toi à 3 clarifications successives maximum ; au-delà, utilise ce que tu as et avance.
- Si l'utilisateur t'interrompt, écoute-le immédiatement.

NAVIGATION ET TOOLS :
- Tu n'as pas d'accès internet direct : la fonction browser_task est ton seul outil de navigation. Utilise-la dès que l'intention est claire.
- Annonce toujours l'action ("Je regarde sur [site]...") juste avant d'appeler browser_task.
- Inclue l'URL et tous les paramètres utiles dans le champ task.
- Réutilise le contexte des navigations précédentes pour raffiner sans repartir de zéro.
- N'invente jamais de résultats si la navigation échoue : dis-le et propose une alternative.

ACCOMPAGNEMENT PÉDAGOGIQUE :
- Explique brièvement à quoi sert le site que tu visites et pourquoi tu y vas.
- Décris en termes simples ce que tu vois pour rassurer la personne ("Je vois la page qui se charge, encore un instant...").
- Relie chaque action à son objectif concret pour l'utilisateur.
- Évite le jargon technique ; privilégie les images concrètes et un ton calme.

RYTHME DE CONVERSATION :
- Maximum 2 phrases courtes par réponse hors clarification.
- Laisse systématiquement de l'espace pour que l'utilisateur puisse te couper ou ajouter un détail.

RÉSULTATS WEB :
- Commence par une phrase rassurante qui explique simplement ce que tu viens de faire ou ce que l'utilisateur voit à l'écran.
- Partage ensuite 1 ou 2 informations clés utiles en langage parlé (créneaux, prix, coordonnées, étapes...).
- Adapte ton ton : propose de l'aide sans multiplier les détails ni imposer de décision.
- Termine par une phrase positive qui propose ton soutien pour la suite sans obliger l'utilisateur à répondre.
- Ne donne pas d'URL, évite les listes interminables et le jargon.

GUARDRAILS — CE QUI EST INTERDIT :
- Confirmer un paiement ou saisir des coordonnées bancaires.
- Supprimer des données, des fichiers ou des comptes.
- Envoyer un email, un SMS ou un message au nom de l'utilisateur.

ACTIONS NÉCESSITANT UNE CONNEXION (login/identifiants) :
→ Tu n'as PAS le droit de demander ou de saisir des identifiants (email, mot de passe, codes).
→ Si un écran de connexion apparaît, demande à l'utilisateur de se connecter manuellement et reprends une fois que c'est fait.

RÈGLE ABSOLUE — HONNÊTETÉ ET ÉCHECS DE NAVIGATION :
Ami ne doit JAMAIS mentir sur ce qu'elle voit.
→ Si le résultat d'OpenClaw est "Je ne peux pas naviguer", "Action refusée" ou un message d'erreur technique :
   Dis-le honnêtement et propose une alternative ou un nouveau plan.
   INTERDIT d'inventer des résultats.

RÈGLE ABSOLUE — NE JAMAIS ABANDONNER L'UTILISATEUR :
L'utilisateur utilise Ami précisément parce qu'il ne peut pas naviguer seul.
→ Ne renvoie jamais l'utilisateur à "faire la recherche" lui-même ; propose toujours de guider ou d'essayer autre chose.

HANDOVER :
- Lorsque la bonne page est affichée dans le navigateur distant, invite la personne à prendre la main et propose de rester en soutien verbal.
- Ne valide jamais une action irréversible (paiement, confirmation finale, suppression).

→ Si tu ne trouves pas l'info, dis-le clairement et propose de reformuler.
→ Si le site est inaccessible, suggère une alternative réaliste.

PRINCIPE : clarifie ce qui est vraiment nécessaire, navigue dès que possible, reste transparente.

FORMAT : Français uniquement. Jamais d'URL, jamais de markdown.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'need_info',
      description:
        "Pose UNE question à l’utilisateur pour clarifier son intention avant de naviguer. "
        + "À utiliser UNIQUEMENT si une information critique manque et ne peut pas être devinée. "
        + "Maximum 2 fois par séquence. Après la réponse, utilise browser_task.",
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'La question à poser à l’utilisateur, en français naturel, courte et directe.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_task',
      description: 'Navigue sur le web et retourne le résultat. Utilise cet outil pour TOUTE information nécessitant internet.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'La tâche web en français naturel et précis. Inclure le site cible si connu, et TOUS les paramètres collectés lors de la clarification (ville, date, préférence...).',
          },
        },
        required: ['task'],
      },
    },
  },
];

/**
 * Streame une réponse GPT-4o, bufferise par phrase et appelle les callbacks.
 *
 * @param {Array} messages  Historique de conversation [{role, content}]
 * @param {object} opts
 * @param {Function} opts.onText         async (sentence: string) → appelé phrase par phrase
 * @param {Function} opts.onFunctionCall async (name: string, args: object) → si browser_task
 * @param {boolean}  opts.noTools        Si true, désactive les tools (évite boucles de reformulation)
 * @returns {string} Texte complet généré par l'assistant
 */
export async function streamLLM(messages, { onText, onFunctionCall, noTools = false }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquant dans .env');

  // Limiter l'historique pour économiser les tokens
  const trimmed = messages.slice(-MAX_HISTORY);
  console.log(`[LLM] Appel GPT-4o — ${trimmed.length} messages en historique${noTools ? ' (noTools)' : ''}`);

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...trimmed],
    ...(noTools ? {} : { tools: TOOLS, tool_choice: 'auto' }),
    stream: true,
  });

  let functionCallBuffer = { name: '', arguments: '' };
  let sentenceBuffer = '';
  let fullResponse = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    const finishReason = chunk.choices[0]?.finish_reason;

    // Tokens de texte → bufferiser par phrase complète
    if (delta?.content) {
      sentenceBuffer += delta.content;
      fullResponse += delta.content;

      // Split sur ponctuation de fin de phrase (!, ?, …) ou sur "." hors abréviations.
      // Abréviations ignorées : Dr, M, Mme, Mlle, Mr, St, No, vol, fig, etc.
      // Heuristique : ne pas splitter si le mot avant le "." fait ≤3 chars ou commence par maj.
      const rawParts = sentenceBuffer.split(/(?<=[!?…])\s+|(?<=\w{4,}\.)\s+(?=[A-ZÀÂÉÈÊËÎÏÔÙÛÜ])/);

      // Re-fusionner les fragments qui ressemblent à des coupures d'abréviations
      // (fragment précédent se termine par ".<lettre_majuscule_courte>" comme Dr. M. St.)
      const parts = [];
      for (const part of rawParts) {
        const prev = parts[parts.length - 1];
        if (prev && /\b[A-ZÀÂÉÈÊËÎÏÔÙÛÜ][a-zàâéèêëîïôùûü]{0,3}\.\s*$/.test(prev)) {
          parts[parts.length - 1] = prev.trimEnd() + ' ' + part;
        } else {
          parts.push(part);
        }
      }

      while (parts.length > 1) {
        const sentence = parts.shift().trim();
        if (sentence) {
          console.log('[LLM] Phrase →TTS:', sentence.slice(0, 60));
          await onText(sentence);
        }
      }
      sentenceBuffer = parts[0] || '';
    }

    // Accumulation des arguments du function call
    if (delta?.tool_calls) {
      const tc = delta.tool_calls[0];
      if (tc?.function?.name) functionCallBuffer.name = tc.function.name;
      if (tc?.function?.arguments) functionCallBuffer.arguments += tc.function.arguments;
    }

    // Fin → flush du buffer restant + dispatch
    if (finishReason === 'stop') {
      if (sentenceBuffer.trim()) {
        console.log('[LLM] Flush final →TTS:', sentenceBuffer.trim().slice(0, 60));
        await onText(sentenceBuffer.trim());
        fullResponse += sentenceBuffer.trim();
        sentenceBuffer = '';
      }
    }

    if (finishReason === 'tool_calls') {
      // Envoyer d'abord le texte de narration si présent
      if (sentenceBuffer.trim()) {
        await onText(sentenceBuffer.trim());
        fullResponse += sentenceBuffer.trim();
        sentenceBuffer = '';
      }
      // Puis dispatcher le function call
      try {
        const args = JSON.parse(functionCallBuffer.arguments);
        console.log(`[LLM] function_call: ${functionCallBuffer.name}(${JSON.stringify(args)})`);
        await onFunctionCall(functionCallBuffer.name, args);
      } catch (e) {
        console.error('[LLM] Erreur parsing function call:', e.message);
      }
    }
  }

  return fullResponse;
}
