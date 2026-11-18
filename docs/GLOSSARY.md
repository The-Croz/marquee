# Glossary

The words Marquee uses on screen, and what Sonarr, Radarr and Prowlarr call the same thing. Screens use the Marquee word. The older word may appear once, as a bridge ("Older apps call them indexers"), and is checked by `apps/server/test/words.test.ts`.

| Marquee word | Meaning | Older apps call it |
|---|---|---|
| **Source** | A site Marquee searches for copies, usually brought in from Prowlarr. | Indexer |
| **Copy** | One search result that could be downloaded. | Release |
| **Copies we found** | The search results for a title, best first, each with why it ranked there. | Interactive search |
| **Rule** | A named test on a copy's name, such as "Dolby Vision without HDR10" or "Low-quality group", worth points. | Custom format |
| **Points** | What a copy's rules add up to. More points wins. | Custom format score |
| **Profile** | What you want for a title: which qualities, which rules and their points, sizes, and when it's good enough. | Quality profile |
| **Good enough** | The quality where Marquee stops looking for a better copy. | Cutoff |
| **Library folder** | Where finished movies or shows live, e.g. `/data/media/movies`. | Root folder |
| **Wanted** | A movie or show you've told Marquee to look for by itself. Nothing is Wanted until you say so. Shows can leave out single seasons or episodes. | Monitored |
| **Downloader** | The app that does the downloading (qBittorrent). | Download client |
| **People sharing** | How many people have the whole copy and are sharing it. | Seeders |
| **Stuck · nobody is sharing it** | A download that can't make progress. | stalledDL |
| **Never pick** | A copy Marquee refuses, with the reason. | Rejected / blocklisted |
| **Whole season** | One copy with every episode of a season. | Season pack |
| **Newest copies** | What a Source has just added; Marquee reads them every 30 minutes to catch new episodes. | RSS |
| **Watched** / **Not watched** | Whether Marquee looks for a title by itself. | Monitored / Unmonitored |
| **Calendar** | Episodes of your shows by the day they air. | Calendar |
| **Site** (searched by Marquee) | A Source Marquee searches itself from a site file, no Prowlarr. | Indexer (Cardigann definition) |
| **List of sites** | The site files Marquee can run: Prowlarr's catalogue, updated daily, plus your own. | Indexer definitions |
| **Bring sites over** | Turns Prowlarr's sites into sites Marquee searches itself. | — |
| **Bot check** / **Solve bot checks** | A "checking your browser" page (Cloudflare) in front of a site, and the solver inside Marquee that gets past it. | FlareSolverr |

## Source health

| Shown as | Meaning |
|---|---|
| **Working** | Answered last time. |
| **Not checked yet** | Just added; a check is on its way. |
| **Can't reach it** | No answer: Prowlarr or the site is down, or the address is wrong. |
| **Key turned down** | The API key wasn't accepted. |
| **Asked us to slow down** | The site wants fewer calls. Marquee waits and tries again. |
| **Set aside by Prowlarr** | Prowlarr stopped using the site for a while because it kept failing there. Test it in Prowlarr. |
| **Sign-in turned down** | The site didn't accept the username and password, or the cookie. |
| **Not supported yet** | Marquee can't run this site's file yet (usually a captcha at sign-in). |
| **Blocked by a bot check** | Cloudflare or similar. Turn on Solve bot checks in Settings → Sources (for a site through Prowlarr, FlareSolverr there). |
| **Not a Torznab feed** | The address answers, but not with a feed. |
| **Paused** | You paused it. |

A failing Source is skipped and tried again by itself: 1 minute after the first failure, doubling each time, at most 6 hours. **Try now** checks at once.

## Downloader health

| Shown as | Meaning |
|---|---|
| **Working** | qBittorrent answered and has an internet connection. |
| **Others can't connect to you** | qBittorrent is firewalled: downloads work, but slower. Turn on port forwarding in the VPN. |
| **No internet for downloads** | qBittorrent says it has no connection, usually because the VPN (gluetun) is down. |
| **Can't reach it** | No answer: qBittorrent is down, or the address or port is wrong. |
| **Password turned down** | The username or password wasn't accepted. |
| **Too many wrong passwords** | qBittorrent blocked Marquee's address for a while. |
| **Type the password again** | The address changed; a saved password is only sent to the address it was saved with. |
| **Not qBittorrent** | The address answers, but isn't qBittorrent. |
| **Too old** | Needs qBittorrent 4.5 or newer. |

## Download states

| Shown as | Meaning |
|---|---|
| **Getting ready** | qBittorrent is finding people sharing it and fetching the file list. |
| **Downloading · 4.2 MB/s · about 12 min left** | Coming in. |
| **Waiting its turn** | qBittorrent is busy with other downloads. Doesn't count towards stuck. |
| **Paused** | Paused in Marquee or qBittorrent. Doesn't count towards stuck. |
| **Waiting · nobody is sharing it right now** | Connected to nobody with the whole copy. Often comes back. |
| **Stuck · nobody is sharing it** / **Stuck · no progress for 7 hours** | No progress for the "stuck" time (6 hours by default). Marquee tries another copy at the give-up time (24 hours) unless that's turned off. |
| **Problem in qBittorrent** | qBittorrent reported an error, often a full disk or missing folder. |
| **Gone from qBittorrent** | Removed in qBittorrent, not by Marquee. |
| **Finished downloading** | The whole copy is here. |
| **Finished · putting it in your library** | Downloaded; Marquee is hardlinking it into the library folder. |
| **In your library · sharing** | Hardlinked into the library; qBittorrent keeps sharing the download until the seeding rule is met. |
| **In your library · done sharing** | Met its seeding rule (ratio or days, whichever first). Can be removed from qBittorrent; the library file stays. |
| **Seeding rule** | How long a download keeps sharing: a ratio or a number of days, whichever comes first. Older apps call it seed ratio / seed time. |
| **… · copied** | Copied, not linked, because the download folder and the library are on different disks. |
| **Couldn’t put it in your library** | Says why and what to do; tried again every 15 minutes. |
| **Replaced** | Marquee turned the copy down (stuck, fake, or you asked) and sent the next best. |
| **Never pick** | A copy turned down for a title, with the reason; searches skip it. |
