# Scénario de Démo Officiel — AMI

Ce document décrit le flux exact à suivre lors de la démonstration d'AMI en public, mettant en valeur sa capacité d'empathie, de clarification, de conservation du contexte et de navigation diversifiée.

## ✅ Pré-requis (à faire avant de monter sur scène)

### Doctolib (pour aller jusqu'au créneau)
- Être **déjà connecté** à Doctolib dans le navigateur noVNC (cookies/session actives).
- Idéalement : ouvrir Doctolib une fois et vérifier que l'on arrive sur un écran “connecté”.
- Objectif démo : aller **jusqu’à l’écran de sélection de créneau / confirmation** (sans forcément valider le rendez-vous si c’est risqué).

### Contenus / sécurité
- Éviter les informations sensibles réelles si la salle est enregistrée.
- Prévoir un plan B (si captcha / étape de sécurité) : fallback sur une recherche non connectée + commentaire oral.

---

## 1. Démarrage (Le Dentiste — Empathie & Clarification)
Le but ici est de montrer qu'Ami ne se jette pas aveuglément sur le web, mais agit comme un humain.

* 👤 **Testeur :** « Bonjour, j'aimerais prendre un rendez-vous chez le dentiste. »
* 🤖 **Ami :** « D'accord, j'espère que ce n'est rien de grave. Tu cherches dans quelle ville ? » *(Appel de `need_info` interne)*
* 👤 **Testeur :** « À Nantes. »
* 🤖 **Ami :** « Très bien. Et tu aurais une date en tête ? » *(Appel de `need_info` interne)*
* 👤 **Testeur :** « Le 2 avril. »
* 🤖 **Ami :** « D'accord, je regarde sur Doctolib... » *(Phrase d'annonce vocale obligatoire)*
* 🌐 **[Écran]** : Le navigateur DOIT maintenant s'afficher.
* 🤖 **Ami :** « Je lance la recherche et je vais aller jusqu’aux créneaux disponibles. » *(Narration courte pendant chargement)*

## 2. Le Raffinement (Le Dentiste — Garder le contexte)
Le but est de montrer qu'Ami se souvient qu'on cherche un dentiste à Nantes et ajuste sans repartir de zéro.

* 👤 **Testeur :** « Dans ce cas, regarde pour le 3 avril plutôt. »
* 🤖 **Ami :** « C'est noté, je vérifie pour le 3 avril... » *(Lancement de `browser_task` avec le contexte précédent)*
* 🌐 **[Écran]** : Le navigateur modifie juste la date sur la recherche existante.
* 🤖 **Ami :** « Parfait, j’ai plusieurs créneaux le 3 avril avec [Nom du praticien]. Je te laisse sur l’étape de sélection/confirmation. Tu veux que je filtre par un horaire précis ? »

## 3. Transition (Recherche alternative — Météo)
Montrer la fluidité pour changer de sujet.

* 👤 **Testeur :** « Au fait, quel temps fera-t-il à Nantes le 3 avril pour mon rendez-vous ? »
* 🤖 **Ami :** « Bonne question, je vérifie la météo... »
* 🌐 **[Écran]** : Navigation sur un site météo.
* 🤖 **Ami :** « Il fera plutôt beau avec quelques nuages et environ 15 degrés. Autre chose ? »

## 4. CAS FINAL PROPOSÉ : L'Achat (Amazon ou Leboncoin)
Le but est de finir sur un effet "Waouh", très visuel, où Ami effectue un tri et une recherche complexe.

* 👤 **Testeur :** « Oui, je cherche à acheter une machine à café à grain. Trouve la moins chère bien notée. »
* 🤖 **Ami :** « C'est parti, je vais comparer ça sur Amazon. »
* 🌐 **[Écran]** : Navigation sur Amazon, recherche "machine à café grain", clic sur "Trier" (prix / notes) + ouverture d’une fiche.
* 🤖 **Ami :** « J’ai trouvé une option très bien notée autour de [prix]. Je te laisse la page ouverte pour voir les détails. »

---

## 🛠 Ajustements Techniques (Fait dans `llm.js`)
Pour s'assurer que ce scénario se déroule sans fausse note lors de la démo, le `SYSTEM_PROMPT` a été ajusté avec un comportement strict appelé "GUIDE DÉMO : DENTISTE" :
- Si le mot clé "dentiste" est prononcé sans ville ni date, Ami déclenchera obligatoirement sa phrase empathique et demandera ces deux informations en une seule question.
- Cela n'altère pas ses capacités générales.
