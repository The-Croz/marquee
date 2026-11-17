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
| **Downloader** | The app that does the downloading (qBittorrent). | Download client |
| **People sharing** | How many people have the whole copy and are sharing it. | Seeders |
| **Stuck · nobody is sharing it** | A download that can't make progress. | stalledDL |
| **Never pick** | A copy Marquee refuses, with the reason. | Rejected / blocklisted |

## Source health

| Shown as | Meaning |
|---|---|
| **Working** | Answered last time. |
| **Not checked yet** | Just added; a check is on its way. |
| **Can't reach it** | No answer: Prowlarr or the site is down, or the address is wrong. |
| **Key turned down** | The API key wasn't accepted. |
| **Asked us to slow down** | The site wants fewer calls. Marquee waits and tries again. |
| **Blocked by a bot check** | Cloudflare or similar. Needs FlareSolverr in Prowlarr. |
| **Not a Torznab feed** | The address answers, but not with a feed. |
| **Paused** | You paused it. |

A failing Source is skipped and tried again by itself: 1 minute after the first failure, doubling each time, at most 6 hours. **Try now** checks at once.
