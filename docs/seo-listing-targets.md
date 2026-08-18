# Where to get lastlight.dev listed

Working list for the backlink problem. As of 2026-08-09, Google has indexed 17 of 59 pages on lastlight.dev, and the non-indexed ones are technically fine (unique titles, descriptions, canonicals, 1,000+ words of static HTML). That points at domain authority, not on-page SEO. The repo has 19 stars and almost no inbound links, so Google crawls the deep pages and declines to index them.

Links are the unlock. Roughly in priority order.

## Tier 1: highest leverage, do these first

| Target | Why it matters | How to get on |
| --- | --- | --- |
| [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted) | The canonical list for self-hosted software, heavily scraped and mirrored, so one entry propagates widely | PR against the list. Read CONTRIBUTING first: they require a non-trivial project age, a licence, and documentation. Last Light qualifies |
| [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | The most-referenced AI-agent index; feeds a lot of downstream listicles | PR adding Last Light under open-source agents |
| Show HN | One good showing drives stars, links and durable referral traffic. The self-hosted plus MIT plus "you own the boundary" angle is on-topic for HN | Post as "Show HN: Last Light, a self-hosted AI software factory for GitHub". Be present in the thread |
| [AlternativeTo](https://alternativeto.net) | Ranks well for "X alternative" queries, which is exactly the new /comparisons/ pages' target | Submit as an alternative to Devin, Factory, and CodeRabbit. Free account, manual submission |
| [OpenAlternative](https://openalternative.co) | Purpose-built for open-source alternatives, already ranks for "open source Devin alternative" | Submit via their site; they accept community submissions |

## Tier 2: directories and registries

| Target | Notes |
| --- | --- |
| [Product Hunt](https://producthunt.com) | Worth one coordinated launch. Traffic spike is temporary, the link is not |
| [SaaSHub](https://saashub.com) | Alternatives directory, decent domain authority, accepts submissions |
| [LibHunt](https://libhunt.com) | Auto-indexes GitHub projects; claim and enrich the listing |
| [StackShare](https://stackshare.io) | Tool directory; add Last Light and list it in Nearform's stack |
| [Console.dev](https://console.dev) | Curated developer-tool newsletter, submissions open. Good fit for a self-hosted dev tool |
| [Openbase / OSS Insight](https://ossinsight.io) | Automatic, but worth checking the entry is accurate |

## Tier 3: the listicle economy

These publish "best CodeRabbit/Devin alternatives" roundups that already rank for the queries the new comparison pages target. Last Light appears in none of them. Most accept a polite email or a suggestion form; some are vendor blogs that will still include a genuine open-source competitor because it makes the list look credible.

- [kodus.io](https://kodus.io/en/best-devin-alternatives/) — publishes both Devin and CodeRabbit alternative roundups
- [OpenHands blog](https://www.openhands.dev/blog/devin-ai-alternatives) — a competitor, but their roundup is genuinely inclusive of OSS peers
- [Augment Code](https://www.augmentcode.com/tools/open-source-ai-code-review-tools-worth-trying) — "open source AI code review tools" list
- [cubic.dev](https://www.cubic.dev/blog/the-3-best-coderabbit-alternatives-for-ai-code-review-in-2025)
- [DevToolLab](https://devtoollab.com/blog/coderabbit-alternatives)
- [Tembo](https://www.tembo.io/blog/devin-alternatives-2025) — Devin alternatives

Pitch angle that actually lands: Last Light is the only entry that is self-hosted at every tier, MIT, and covers a suite of workflows rather than a single issue-to-PR pipeline. That is a differentiator a list author can use, which is what makes inclusion likely.

## Tier 4: communities

Link-value is lower (most are nofollow) but they drive stars and the discovery that leads to real links.

- r/selfhosted — strong fit, this is exactly their thing
- r/devops, r/opensource, r/ExperiencedDevs
- Lobste.rs — needs an invite, higher signal than HN for infra topics
- dev.to and Hashnode — republish the comparison pages as posts with canonical tags back to lastlight.dev
- The Changelog / TLDR newsletters — both take tips

## Housekeeping on the repo itself

GitHub links are nofollow, so they pass no direct equity, but they drive the discovery that produces real links.

- Add more topics to `nearform/lastlight`: currently only `agent`, `ai`, `coding`, `harness`. Add `self-hosted`, `code-review`, `github-app`, `ai-agent`, `devops`, `open-source`
- Link the comparison pages from the README, not just the homepage
- Keep the homepage URL set in the repo sidebar (already done)

## Measurement

Re-run after each batch lands:

```bash
leo inspect lastlight.dev --all --limit 100   # indexed vs not
leo performance lastlight.dev --days 28 --by query
leo coverage lastlight.dev --days 28
```

The metric to watch is not clicks in the first month. It is **indexed page count**, currently 17 of 59. If links start landing, that number should climb before traffic does.
