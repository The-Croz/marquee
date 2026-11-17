# Marquee

Movies and TV for your home server, in one app: requests, finding the right copy, downloads, and who's watching.

Marquee is being built to replace Sonarr, Radarr, Prowlarr, Seerr and Tautulli with one app that explains itself in plain English. See [`docs/PLAN.md`](docs/PLAN.md) for where things stand.

> **Status:** Milestone 0. Sign-in, user management and the app shell work; the Home screen shows sample data.

## Run it

```sh
docker run -d --name marquee \
  -p 9797:9797 \
  -v /mnt/user/appdata/marquee:/config \
  -v /mnt/user/data:/data \
  --user 99:100 \
  ghcr.io/the-croz/marquee:latest
```

Open `http://<server>:9797` and create the admin account.

The image is private while the repo is private. To pull it on Unraid, sign in once with a GitHub token that has `read:packages`:
`docker login ghcr.io -u The-Croz`.

### docker compose

```yaml
services:
  marquee:
    image: ghcr.io/the-croz/marquee:latest
    container_name: marquee
    user: "99:100"
    ports: ["9797:9797"]
    volumes:
      - /mnt/user/appdata/marquee:/config
      - /mnt/user/data:/data
    environment:
      MARQUEE_BASE_URL: https://marquee.example.com
      # Pocket ID (optional)
      OIDC_ISSUER: https://id.example.com
      OIDC_CLIENT_ID: marquee
      OIDC_CLIENT_SECRET: change-me
      OIDC_NAME: Pocket ID
      # Plex sign-in (optional)
      PLEX_LOGIN: "true"
    restart: unless-stopped
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `MARQUEE_PORT` | `9797` | Port to listen on |
| `MARQUEE_DATA_DIR` | `/config` | Where the database lives |
| `MARQUEE_BASE_URL` | – | Public URL, e.g. `https://marquee.example.com`. Needed for OIDC behind a reverse proxy. |
| `OIDC_ISSUER` | – | Your OIDC provider's URL (for Pocket ID, its base URL). Turns on the OIDC button. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | – | From the OIDC client you create for Marquee |
| `OIDC_NAME` | `Single sign-on` | Button label, e.g. `Pocket ID` |
| `OIDC_AUTO_CREATE` | `true` | Create a member account the first time someone signs in. Set `false` to only allow accounts you've linked. |
| `PLEX_LOGIN` | `false` | Show "Continue with Plex" |
| `PLEX_SERVER_ID` | – | Your Plex server's machine identifier (Plex → Settings → General, or `https://<plex>:32400/identity`) |
| `PLEX_AUTO_CREATE` | `false` | With `PLEX_SERVER_ID` set, anyone your server is shared with can sign in and gets a member account |

### Pocket ID

Create an OIDC client in Pocket ID with the callback URL `https://<marquee>/api/auth/oidc/callback`, then set the `OIDC_*` variables. Existing users can link Pocket ID under **Settings → Account**.

### Plex

With `PLEX_LOGIN=true`, people can link their Plex account under **Settings → Account** and then use "Continue with Plex". Marquee never stores Plex tokens from sign-in.

## Develop

Requires Node 22 and pnpm.

```sh
pnpm install
pnpm dev     # http://localhost:5173
pnpm test
```

## License

GPL-3.0-or-later
