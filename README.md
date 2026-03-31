# AMI — Navigateur pour malvoyants (OpenClaw)

Projet pour le hackathon GEN AI SHIFT
Naviguer sur le web avec un agent vocal pour les malvoyants/handicapés/personnes agées.
Retours sur le projet — navigateur vocal pour malvoyants

Ce que j’observe aujourd’hui
Le système fonctionne pour des usages du type « va chercher une info », « parcours un site », « recherche » : l’agent arrive souvent au bon endroit et peut lire ou résumer.
Dès qu’on passe à des flux techniques et transactionnels, par exemple valider un rendez-vous sur Doctolib, cliquer sur le bon « Confirmer », enchaîner calendrier, identifiant et modales, ça casse ou c’est trop fragile. Ce n’est pas un détail : c’est le cœur de beaucoup de besoins réels.

Ce que je retiens sur pourquoi ça bloque là
Les agents navigateur + LLM, avec OpenClaw, c'est fort quand le scénario ressemble à ouvrir une page, repérer un gros bouton ou un bloc de texte, faire une action relativement évidente.
Les parcours type prise de RDV ajoutent des applications une seule page avec beaucoup d’états et de chargements, l’auth et la session, parfois la double authentification, des widgets où le bon clic dépend du contexte (calendrier, créneaux), parfois des garde-fous anti-bot, plusieurs boutons « Valider » ou des libellés proches, et parfois des iframes difficiles à cibler.
En plus, l’agent ne voit pas le web comme un lecteur d’écran : il s’appuie surtout sur le DOM et les captures, pas sur un arbre d’accessibilité riche. Pour un clic critique, ça suffit souvent à faire la différence entre presque et fiable.
Conclusion que je garde : le problème n’est pas seulement d’améliorer le prompt. C’est de structurer la fiabilité sur les étapes qui comptent, eliminer la petite latence ou combler la latence avec petites phrases.

Ce que je retiens du choix OpenClaw
Je ne le regrette pas pour la couche navigation web générique branchée sur mon orchestrateur Node. L’API compatible OpenAI est simple à brancher avec le LLM et le reste du pipeline. Un seul navigateur sur le VPS, aligné avec la démo noVNC, ça colle bien.
Je retiens aussi les limites : c’est un agent généraliste, pas un moteur de workflow garanti pour chaque site critique. Les flux sensibles (RDV, paiement, données de santé) demandent autre chose qu’une seule consigne de haut niveau sans filet.
Si je refaisais l’architecture avec le recul, je viserais d’abord un hybride LLM et chemins déterministes. Pour un projet avec quelques sites primordiaux pour certains use cases qui aiderait beaucoup les malvoyants.
