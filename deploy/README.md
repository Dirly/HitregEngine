# deploy/

Everything needed to host a HitReg world on one box. Read **docs/hosting.md**
first — this folder is the mechanics, that document is the design and the
operating procedures (rolling a content version, moving to a home box,
what the agent's weekly edit does to running servers).

| file | what |
| --- | --- |
| `Dockerfile` | one image, three roles: `main` (default command), or a `layer` / `instance` started by hand |
| `docker-compose.yml` | the "small community" shape: Caddy (TLS + client) → main (+ its layers) → Postgres |
| `Caddyfile` | TLS for the gateway and the built client, optional per-port TLS fronts for layers |
| `.env.example` | the knobs — copy to `.env` |
| `hitreg-main.service` | the same thing without Docker (a home box, systemd) |

Quick start on a VPS with Docker and a DNS name pointing at it:

```
git clone <engine> && cd engine
git clone <your game> apps/playground/projects/<game>      # the content
pnpm install && pnpm -F playground build                    # the client → apps/playground/dist
cp deploy/.env.example deploy/.env && $EDITOR deploy/.env   # secret, PUBLIC_HOST, SCENE
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
curl -s -H "Authorization: Bearer $HITREG_SECRET" https://play.example.org/admin/status
```

Players open `https://play.example.org/?gateway=https://play.example.org`,
sign in, pick a character, press Play.
