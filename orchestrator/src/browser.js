/**
 * Contrôle direct du navigateur Chromium via Chrome DevTools Protocol (CDP).
 * Plus fiable qu'OpenClaw pour les opérations simples (reset, navigation).
 *
 * Port CDP configuré dans .env : CDP_PORT (défaut 18800)
 */

const CDP_PORT = process.env.CDP_PORT || 18800;
const CDP_BASE = `http://localhost:${CDP_PORT}`;

/**
 * Réinitialise le navigateur :
 * 1. Ouvre un nouvel onglet sur google.fr
 * 2. Ferme tous les anciens onglets
 *
 * Appelé au démarrage de chaque session (init) pour repartir sur une page propre.
 */
export async function resetBrowser() {
  try {
    // Lister les onglets actuels
    const res = await fetch(`${CDP_BASE}/json`);
    const tabs = await res.json();
    const pageIds = tabs
      .filter(t => t.type === 'page')
      .map(t => t.id);

    // Ouvrir un nouvel onglet Google (devient l'onglet actif)
    await fetch(`${CDP_BASE}/json/new?https://www.google.fr`);

    // Fermer tous les anciens onglets
    for (const id of pageIds) {
      await fetch(`${CDP_BASE}/json/close/${id}`).catch(() => {});
    }

    console.log(`[Browser] Reset : ${pageIds.length} onglet(s) fermé(s) → Google ouvert`);
  } catch (err) {
    console.error('[Browser] Reset échoué:', err.message);
  }
}
