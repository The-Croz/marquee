# Marquee

Movies and TV for your home server, in one app: requests, finding the right copy, downloads, and who's watching.

Marquee is being built to replace Sonarr, Radarr, Prowlarr, Seerr and Tautulli with one app that explains itself in plain English. See [`docs/PLAN.md`](docs/PLAN.md) for where things stand.

> **Status:** Milestone 1. Sign-in, users, and a read-only library scan matched to TMDB (Movies, Shows, "Needs a match"). Downloads, requests and stats are still sample data.

## Run it on Unraid

1. Copy the template to your flash drive (Unraid terminal):
   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/my-marquee.xml \
     https://raw.githubusercontent.com/The-Croz/marquee/main/docker/unraid/marquee.xml
   ```
   (While the repo is private, copy `docker/unraid/marquee.xml` there by hand instead.)
2. **Docker → Add Container → Template:** pick **marquee** under "User templates".
3. Check the two paths (`/config` → appdata, `/data` → your `data` share), add your TMDB key, and click **Apply**.
4. Open `http://<server>:9797` and create the admin account.

Marquee runs as `PUID`/`PGID` (99:100 on Unraid). It fixes the ownership of `/config` on start and never changes anything under `/data`.

**Private image:** while the GitHub package is private, Unraid has to be signed in to pull it: `docker login ghcr.io -u The-Croz` with a GitHub token that has `read:packages`. Unraid keeps `/root` in RAM, so that login is lost on reboot. Either make the *package* public (GitHub → Packages → marquee → Package settings; the repo can stay private), or add the login to `/boot/config/go`.

## Run it with Docker

```sh
docker run -d --name marquee \
  -p 9797:9797 \
  -e PUID=99 -e PGID=100 \
  -v /mnt/user/appdata/marquee:/config \
  -v /mnt/user/data:/data \
  ghcr.io/the-croz/marquee:latest
```

### docker compose

```yaml
services:
  marquee:
    image: ghcr.io/the-croz/marquee:latest
    container_name: marquee
    ports: ["9797:9797"]
    volumes:
      - /mnt/user/appdata/marquee:/config
      - /mnt/user/data:/data
    environment:
      PUID: "99"
      PGID: "100"
      TZ: America/New_York
      MARQUEE_BASE_URL: https://marquee.example.com
      TMDB_API_KEY: your-tmdb-key
      # Pocket ID (optional)
      OIDC_ISSUER: https://id.example.com
      OIDC_CLIENT_ID: marquee
      OIDC_CLIENT_SECRET: change-me
      OIDC_NAME: Pocket ID
      # Plex sign-in (optional)
      PLEX_LOGIN: "true"
    restart: unless-stopped
```

## First scan

1. **Settings → Services:** check your TMDB key (from the template) with **Test connection**. Optionally connect Radarr and Sonarr (read-only) so matching uses their IDs.
2. **Movies → Scan library.** Marquee reads `/data/media/movies` and `/data/media/tv` (change them in Settings → Services if yours differ) and matches every folder. It never renames, moves or deletes anything.
3. Anything it isn't sure about shows up under **Needs a match**.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` | User and group Marquee runs as (Unraid: `99` / `100`) |
| `MARQUEE_PORT` | `9797` | Port to listen on |
| `MARQUEE_DATA_DIR` | `/config` | Where the database lives |
| `MARQUEE_BASE_URL` | – | Public URL, e.g. `https://marquee.example.com`. Needed for OIDC behind a reverse proxy. |
| `TMDB_API_KEY` | – | TMDB v3 key or v4 read token, for matching your library |
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
