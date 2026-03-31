# Sécurité — dépôt et déploiement AMI

## Avant un `git push` (repo public ou partagé)

1. Vérifier qu’aucun secret n’est dans l’historique :
   ```bash
   git log -p -- '*.env' '**/.env'
   rg -n 'sk-[a-zA-Z0-9]|sk_proj-|api[_-]?key\\s*=\\s*[^\\s]' --glob '!node_modules'
   ```
2. Ne jamais committer : `.env`, `credentials.json`, `token.json`, `orchestrator/.env`, clés API en clair dans le code ou la doc.
3. Utiliser `orchestrator/.env.example` et `.env.example` comme modèles ; secrets uniquement en local ou dans un gestionnaire (Vault, CI secrets).

## Si des clés ont fui (fichier partagé, capture d’écran, ancien commit)

- **Régénérer immédiatement** sur les consoles : OpenAI, Deepgram, ElevenLabs, jeton OpenClaw.
- Mettre à jour `orchestrator/.env` sur le VPS uniquement par canal sûr.
- Si un commit Git contenait des secrets : réécrire l’historique (`git filter-repo` / BFG) ou invalider les clés et considérer le dépôt comme compromis.

## Données sensibles en documentation

- Ne pas fixer d’**IP publique** ni de **nom de domaine de prod** dans les fichiers versionnés ; utiliser des placeholders (`<VPS_OU_DOMAINE>`, etc.).
- Le pare-feu (UFW) ne doit exposer que ce qui est nécessaire ; noVNC sur un port public est une **démo** — à fermer ou protéger (tunnel SSH, auth).

## Fichiers exclus du dépôt (voir `.gitignore`)

- Historique **Aider** (`.aider*`), environnements Python/Node, `.tmp/`, artefacts `_bmad/`.

## Checklist déploiement VPS

- [ ] `.env` en `chmod 600`, propriétaire du service.
- [ ] HTTPS (Let’s Encrypt) + WSS pour l’audio.
- [ ] Token fort pour OpenClaw et validation côté orchestrateur (évolution prévue dans les stories).
- [ ] Pas de stack traces ni de logs contenant des clés en production.

---

## UFW — exemple prod (orchestrateur derrière Nginx)

Adapter selon ta politique (noVNC / SSH tunnel uniquement, etc.).

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP ACME'
ufw allow 443/tcp comment 'HTTPS + WSS'
# Ne pas ouvrir 4000/tcp sur Internet — Nginx proxy vers 127.0.0.1:4000
ufw enable
ufw status numbered
```

Fermer le port noVNC public après démo : `ufw delete allow 6080/tcp` (ou l’entrée correspondante).

---

## Nginx — HTTPS + WebSocket `/audio` → orchestrateur (port 4000)

L’orchestrateur expose le WebSocket sur le chemin **`/audio`** (voir `orchestrator/src/server.js`). Exemple de site (TLS avec Certbot : `certbot --nginx -d ton.domaine.tld`) :

```nginx
# Redirection HTTP → HTTPS (Certbot ajoute souvent ce bloc)
server {
    listen 80;
    listen [::]:80;
    server_name ton.domaine.tld;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ton.domaine.tld;

    # ssl_certificate / ssl_certificate_key : gérés par Certbot

    # App statique + API HTTP si besoin
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket audio (Upgrade obligatoire)
    location /audio {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

Puis `nginx -t && systemctl reload nginx`. Côté app, utiliser `wss://ton.domaine.tld/audio` (pas d’IP publique en dur dans le dépôt).
