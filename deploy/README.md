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
pnpm install
pnpm -F playground build:game <game> <scene>.scene.json      # editor-free client → apps/playground/dist/<game>
cp deploy/.env.example deploy/.env && $EDITOR deploy/.env   # secret, PUBLIC_HOST, SCENE
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
curl -s -H "Authorization: Bearer $HITREG_SECRET" https://play.example.org/admin/status
```

Set `CLIENT_PROJECT=<game>` and `SCENE=<scene>` in `deploy/.env`. Players open
`https://play.example.org/`, sign in, choose a world and character, then enter play.
The published server client uses its own origin as the gateway by default.

`pnpm -F playground build` builds the **editor**. It is for authoring and must
not be the public client. Publishing exports the selected project's dependency
closure, packs boot JSON into bounded static requests, and includes only that
closure's project scripts. Models, images and sounds are hosted as files and
fetched when used; export does not yet prune unused files within that closure.
The bundle is compressed losslessly and the Caddyfile serves its `.br`/`.gz` sidecars (docs/hosting.md, "What publish compresses").
Sign-in does not construct or stream the world behind the panel.
The player build fails if editor UI, model/material thumbnail baking, thumbnail
storage, the editor entry, or live authoring code enters its emitted modules.
Those tools belong to the separate authoring app at the Vite development URL.
