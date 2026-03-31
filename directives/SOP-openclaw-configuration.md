# SOP : Configuration et Exécution d'OpenClaw (Phase 1)

**Objectif :**
Installer l'agent local OpenClaw de façon sécurisée (sans utiliser npm au hasard suite à des attaques supply-chain), et établir un point d'entrée programmatique (SDK Node.js) pour que l'Orchestrateur puisse envoyer des textes ("Cherche X sur la page Y") et déclencher des actions web.

## 1. Pré-Requis Système
- Node.js version **v22.14** (ou v24 recommandée).
- OpenClaw installé via le script officiel disponible sur `openclaw.ai`.

## 2. Installation Sécurisée de l'Agent Local
En raison des risques d'usurpation (typosquatting NPM type `@openclaw-ai/openclawai`), l'installation doit se faire via le site officiel.
1. Rendez-vous sur `https://openclaw.ai`.
2. Lancez la commande d'installation officielle pour votre OS (Mac ou Linux/Serveur).
3. L'installation placera OpenClaw en tâche de fond (Gateway daemon sur `launchd` ou `systemd`).

## 3. Script d'Exécution
L'interaction programmatique passe par le SDK d'OpenClaw.
Le fichier `/execution/test_openclaw.js` a été paramétré comme point d'entrée pour tester des requêtes textuelles *avant* même de commencer à coder l'agent vocal.

## 4. Tester l'Agent
1. S'assurer que le service (Daemon) OpenClaw tourne localement.
2. Dans le dossier `execution`, lancez : `node test_openclaw.js "Ouvre la page de Wikipédia sur l'intelligence artificielle et lis-moi le premier paragraphe."`
3. Vérifier que le navigateur exécute bien la requête (en mode DevTools MCP).
