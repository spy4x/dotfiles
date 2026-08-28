---
name: marketing-micro-saas
description: Open-core microSaaS marketing playbook for solo indie devs. Load for pricing tier design, license choice (AGPLv3 + commercial), channel strategy, distribution platforms, launch checklists, conversion math, GitHub README optimization, IndieHackers/Hacker News/Reddit/Twitter tactics, and IndieHackers-style build-in-public playbook. Reference templates modeled on Plausible, Cal.com, Dub.co, Papermark, Logto, Coolify patterns. Stack-aware: Deno 2 + Hono + Fresh + Preact + SQLite + Litestream, Hetzner BM, syncthing + restic, shared Traefik + VictoriaMetrics + Authelia + Woodpecker CI.
license: MIT
compatibility: opencode
---

# Marketing Playbook — Solo microSaaS (Open Core)

## What I do

Give you a concrete, executable playbook for launching and growing an open-core microSaaS as a solo indie dev. Covers the bits most solo devs don't have prior art for: license choice, pricing tier design, channel prioritization, distribution platform submission, launch-week timing, and conversion math. Modeled on indie-scale references (Plausible, Cal.com, Dub, Papermark, Logto, Coolify, Infisical) — NOT GitLab/Sentry tier.

## When to use me

Load when:
- Picking license for a new project (AGPLv3 vs MIT vs BSL vs source-available)
- Designing pricing tiers (free + pro + team math)
- Writing the GitHub README that converts cold traffic
- Planning a launch week (IndieHackers, Show HN, ProductHunt, Reddit sequence)
- Picking distribution channels for the first 100 users
- Estimating conversion rates for free→paid, self-host→cloud
- Writing "why I built X" or "[X] vs [competitor]" SEO content
- Optimizing a landing page for a $9-49/mo indie SaaS

Do NOT load for: domain purchasing, payment processor setup, hosting basics, deploy mechanics — those are infra, covered elsewhere.

---

## 1. The model: Open Core

**Pattern**: Open-source self-hostable core (free, forever) + commercial cloud SaaS (paid) + optional commercial enterprise tier (later).

**Validated at indie scale** (solo or 2-5 people, $1K-$5M ARR):

| Product | Founder | Stars | License | ARR | Wedge |
|---|---|---|---|---|---|
| Plausible Analytics | 2 co-founders | 20K+ | AGPLv3 | $1M+ self-funded | Privacy-first GA alternative |
| Dub.co | Steven Tey, solo | 24K | AGPLv3 + `/ee` | $5M+ | Custom domains on free tier |
| Cal.com | Peer Richelsen | 48K | AGPLv3 | $5M+ | Open Calendly alt |
| Papermark | Marc Lou, solo | 9K | AGPLv3 | $20K+ MRR | #1 PH day + Twitter build-in-public |
| Infisical | Vlad Matsiiako | 27K | MIT→AGPL | $5M+ | Cash-flow positive pre-Series A |
| Logto | Silverhand, indie | 14.5K | MPL-2.0 + proprietary cloud | profitable | Deno-compatible auth |
| Coolify | Andras Bacsai, solo | 30K | Apache 2.0 | 3,641 cloud subs | Self-hostable Heroku |

All use the same recipe: OSS core + commercial cloud + GitHub-first distribution + build-in-public.

**Why this works for you specifically:**
- You're shipping 5-10 microSaaS in 18 months. Open-core compounds across products (same marketing playbook each time).
- YouTube dev tutorial + Twitter build-in-public = natural content for Deno ecosystem (rare stack = built-in differentiation).
- Self-host first + cloud optional = respects infra-savvy devs (your peers).

---

## 2. License: AGPLv3 + commercial cloud

**Use AGPLv3 for the core. Don't gate features.**

Why AGPL, not MIT/Apache:
- MIT lets AWS/GCP fork your code and host as competitor. AGPL forces them to either open-source changes OR buy commercial license.
- Plausible moved MIT→AGPL at $6.4K MRR. Same move as Dub, Papermark, Infisical, Cal.com.
- Your cloud is the moat, not the code. AGPL protects cloud without limiting self-host.
- Switching licenses later is painful (not retroactively enforceable). Start AGPL.

Structure:
```
Core code:           AGPLv3 (self-host forever, no restrictions)
Hosted cloud:        Same code, your infra, your branding (allowed under AGPL)
Commercial tier:     Optional SSO/audit-log/enterprise features under separate commercial license
JSR/npm libs:        MIT or Apache 2.0 (don't gatekeep reusable utilities)
```

Alternative licenses if AGPL doesn't fit:
- **BSL (Business Source License)**: source-available, no AGPL contagion. Saleor uses this. Risk: less contribution.
- **Elastic License v2 / SSPL**: source-available, restricts hosted resale. Infisical evaluated these.
- **MPL-2.0**: file-level copyleft, weaker than AGPL. Logto uses this for self-host.
- **Apache 2.0 / MIT**: only if you're not worried about hosted competitors (Saleor model, $11M raised).

**For solo indie + cloud SaaS, AGPLv3 is the default choice.** Don't second-guess.

---

## 3. Pricing: 3 tiers, copy Plausible's model

```
Free:    $0/mo forever — limited usage (1 user, 1 project, 10K events/mo or equivalent)
Pro:     $9-19/mo      — unlimited projects, raised limits, no branding
Team:    $29-49/mo     — teams, custom domain, priority support, RBAC
```

**Critical pricing rules:**
- Annual toggle with 16-25% discount visible (commit discount)
- 30-day free trial, NO credit card upfront → 33.5% trial-to-paid (Plausible's actual rate)
- No "Contact us" wall on Team tier — show the price
- Charge by usage OR seat, not both (avoid double-charge confusion)
- Forever-free tier alternative: 2-5% conversion rate, much higher signup volume (Cal.com/Logto model)

**$1K MRR math**:
- 100 paid × $10/mo = $1K MRR → need 300-500 trial signups at 33.5% conversion
- OR 2K-5K free-forever signups at 2-5% upgrade conversion
- Self-host installs outnumber cloud 10-100× in Y1
- 1,000+ self-host installs → 10-30 cloud conversions = $1-3K MRR

**$2-3K MRR by month 12** = the realistic solo indie target.

Pricing page references: plausible.io/pricing, dub.co/pricing, logto.io/pricing, cal.com/pricing.

---

## 4. Channels: priority order for 6-month runway

**Plausible's actual top 10 referrers** (Apr-Jul 2020, $64→$2,750 MRR):

| Rank | Source | Visitors |
|---|---|---|
| 1 | Hacker News | 43.6K |
| 2 | Twitter | 10K |
| 3 | Facebook | 6.4K |
| 4 | Google (SEO) | 6.3K |
| 5 | IndieHackers | 4.8K |
| 6 | GitHub | 2.7K |
| 7 | Reddit | 2.2K |
| 8 | Dev.to | 2.2K |

**ProductHunt is NOT in top 10** = launch-day spike, not a growth channel. Don't optimize for it.

**Your channel priority** (solo, no audience, 6mo runway):

| Channel | Time | Cost | When | ROI |
|---|---|---|---|---|
| GitHub README | 1 day | $0 | Day 1 | Always-on landing. Highest. |
| IndieHackers profile + posts | 30 min/day | $0 | Day 1 | Plausible's #1 source of first 100 users |
| Twitter/X build-in-public | 30 min/day | $0 | Day 1 | Marc Lou's primary channel |
| Show HN | 1 post | $0 | Week 2 | 1-3K visitors if it hits |
| r/selfhosted post | 1 post | $0 | Week 2-3 | 1M subs, loves self-hostable alts |
| ProductHunt | 1 day | $0 | Day 14 | Badge + backlink. Don't expect revenue. |
| awesome-selfhosted PR | 30 min | $0 | Week 3 | THE list for self-hostable |
| AlternativeTo claim | 30 min | $0 | Week 3 | SEO + comparison intent |
| Coolify catalog PR | 30 min | $0 | Week 3 | 1-click deploy for Coolify users |
| Blog SEO content | 1 post/wk | $0 | Week 4+ | "[Open-source] alt to X" ranks forever |
| Awesome-* niche lists | 30 min each | $0 | Week 4 | Stacks of discovery |
| Customer interviews | 1 hr each | $0 | Week 3+ | Word-of-mouth + testimonials |

**Skip for Y1** (zero ROI at $0-1K MRR):
- Paid ads (Meta, Google, LinkedIn)
- YouTube tutorials (high effort, slow payoff)
- Podcast guest appearances (Y2+)
- Conferences ($$$ + travel, Y2+)
- Twitter Blue / X Premium ($8/mo not worth it)

**Show HN timing**: Tue-Thu, 8-10am US Eastern. Plausible's hits were Tuesday + Thursday mornings.

**Reddit prerequisites**: brand-new accounts throttled. Engage on r/programming + IndieHackers for 1-2 weeks BEFORE posting to r/selfhosted. Need karma.

---

## 5. Distribution: where the code lives

| Channel | Cost | Setup | Purpose |
|---|---|---|---|
| GitHub repo | $0 | Day 1 | Primary. Everything links here. |
| GHCR / Docker Hub | $0 | Week 1 | `docker run yourorg/product` one-liner |
| JSR package (if has public API) | $0 | Week 2 | TS-first registry, npm-compatible. Free backlinks per package. |
| awesome-selfhosted | $0 PR | Week 3 | THE discovery channel for self-hostable |
| AlternativeTo | $0 | Week 3 | SEO + comparison intent |
| Slant | $0 | Week 3 | Long-tail comparison SEO |
| Coolify catalog | $0 PR | Week 3 | 30K+ Coolify users get 1-click deploy |
| Elestio | $0 PR | Week 3 | Managed deploys |
| YunoHost | $0 PR | Week 3 | Self-host community |
| Cloudron | $0 PR | Week 3 | Self-host community |
| awesome-`<niche>` lists | $0 | Week 4 | Niche discovery (e.g., awesome-react, awesome-selfhosted) |
| Backblaze B2 / S3 | $0-5/mo | Week 2 | Static binaries, demo images |

**Cloud SaaS hosting**: use Deno Deploy free tier ($0) for first 6-12 months. 1M req/mo + 20GB egress + Deno KV. Self-host demo on Hetzner BM. Don't over-engineer.

**Your existing infra pattern** (per AGENTS.md Operating context):
- Docker Compose per project
- Shared Traefik with auto-discovery labels
- Syncthing for file sync, restic for backups
- VictoriaMetrics + NodeExporter + Cadvisor for monitoring
- Woodpecker CI for builds, Watchtower for image updates
- NTFY for notifications, Gatus for healthchecks, Authelia for SSO
- 1× Hetzner BM (auction EX-series)

This pattern makes self-host installs trivial. Submit your `docker-compose.yml` to Coolify/Elestio/Cloudron catalogs with the shared labels and let them auto-discover.

---

## 6. GitHub README template

The single most important page. Most devs land here first from Google/GitHub search. Convert with this format:

```markdown
# ProductName

[2-sentence tagline: what it is, what it replaces]

> Open-source alternative to [BigSaaS]. Self-hostable in 5 minutes. Cloud from $9/mo.

[Hero screenshot]
[60-90s demo GIF — main flow in action]

[CTA buttons: Live Demo] [Self-Host Install] [Cloud Signup] [Star on GitHub]

## Features

- ✓ Headline benefit (not "supports X" — say "eliminates Y pain")
- ✓ Bullet 2
- ✓ Bullet 3

## Quick Start (self-host, 5 min)

\`\`\`bash
# Option 1: Docker one-liner
docker run -d --name product -p 8080:8080 yourorg/product

# Option 2: docker compose
curl -O https://raw.githubusercontent.com/yourorg/product/main/docker-compose.yml
docker compose up -d
\`\`\`

Open http://localhost:8080, done.

## Cloud

Hosted by us, $9/mo Pro, $29/mo Team. [Sign up](https://app.yourproduct.com/signup).

## Why ProductName?

- **vs [Competitor A]**: 2-sentence diff
- **vs [Competitor B]**: 2-sentence diff

## Self-Hosting

- 1 CPU, 512MB RAM minimum
- SQLite file at `/data/db.sqlite` (back up via restic/syncthing)
- Traefik labels auto-included for reverse proxy
- See [docs/self-host.md](docs/self-host.md) for full guide

## License

AGPLv3 — free for self-host and personal use.
Commercial license available for hosted resale.
```

**Why each section matters:**
- **Hero screenshot/GIF**: bounce in <5s without one
- **"Open-source alternative to X"**: SEO goldmine — exact phrase people search
- **One-liner install**: self-hosters bounce if not 5-min simple
- **Cloud CTA visible**: self-hosters might pay $9/mo to skip upgrade pain
- **License at bottom**: trust signal for enterprise/regulated buyers

---

## 7. IndieHackers playbook (Day 1 channel)

Plausible's founder posted every milestone on IndieHackers for 2 years. First 100 users came from here.

**Posting cadence:**
- **Day 1**: "Building [Product] in public" intro post
- **Every Friday**: milestone update (users, MRR, what shipped)
- **Every interesting problem**: post-mortem / decision post (e.g., "Why I switched from MIT to AGPL")
- **Daily**: engage on other IH threads, 30 min = ~200 followers/month

**What NOT to do:**
- Don't shill your product in unrelated threads
- Don't fake your numbers (community checks Stripe dashboards)
- Don't post only when launching — bury the launch in normal activity first

**Format that works:**
```
Week 3 update: hit $320 MRR 🎉

What got shipped:
- [feature 1]
- [feature 2]
- [fix that users asked for]

What's next:
- [week 4 priority]

Numbers:
- Free: 142 (was 89 last week)
- Paid: 32 (was 21)
- MRR: $320
- GitHub stars: 487

Link: [product URL]
```

---

## 8. Show HN format

HN's official Show HN guidelines (news.ycombinator.com/showhn.html):
- "On topic: things people can run on their computers or hold in their hands"
- "The project should be non-trivial. Don't post quickly-generated one-offs"
- "Please make it easy for users to try your thing out, ideally without barriers such as signups or emails"
- "A Show HN needn't be complicated or look slick. The community is comfortable with work that's at an early stage"

**Format that converts:**
```
Show HN: ProductName – open-source [Competitor] alternative (self-host + cloud)

Hi HN, I built [Product] because [pain]. It's:
- AGPLv3 self-hostable, single docker-compose up
- Cloud version from $9/mo
- [2-3 sentences on what's different]

Tech: Deno 2 + Hono + SQLite. Live demo: https://...
GitHub: https://github.com/yourorg/product

Would love feedback on [specific question].
```

**What gets upvoted**: genuine problem-solver, polished enough to be runnable, addresses specific HN-crowd pain (Calendly costs too much, Bitly is bloated, GA is too complex).

**What kills Show HN submissions**: "Sign up for early access" landing pages, closed beta/waitlist, crypto/AI buzzword stuffing, polished marketing site with no real product.

**Lifetime value**: 1 Show HN that hits = 1-3K visitors in 24h, 100-500 GitHub stars over the week, 50-200 trial signups.

---

## 9. ProductHunt (launch-day spike, NOT growth)

Plausible's Aug 2020 PH launch: 1,000 visitors + 15 trial signups that day, fewer than 20/day after. PH = spike of hope followed by flat line.

**Use PH for**:
- Social proof badge (#1 of the day)
- Backlink to domain
- Reddit users who look up products there

**Don't expect**: sustained traffic, real revenue, real customers.

**Hunter outreach**: PH lets you pick a "hunter" who submits your product. A hunter with 5K+ followers adds momentum. Top hunters 2026: Chris Messina, Ben Tossell, Kevin William David, Hiten Shah. DM 2 weeks before with 1-line pitch + demo link.

**PH launch day checklist**:
- Online all day responding to comments
- Asset prep done 1 week ahead: tagline, description, gallery images, maker bio
- Coordinate with hunter + co-launchers
- Tweet throughout the day

---

## 10. Twitter/X build-in-public (Marc Lou playbook)

Marc Lou (@marc_lol) built Papermark to 9K stars + paying customers in 12 months primarily through daily Twitter build-in-public. His formula:

- **Daily tweet**: shipping update, MRR screenshot, "I just shipped X" with screenshot
- **Weekly thread**: milestone recap (numbers, lessons, what next)
- **Engage daily**: reply to other indie devs (@steventey @marc_lol @pieter_levels @dannypostmaa @tony_dinh), join conversations
- **Show your work**: terminal screenshots, code snippets, Stripe dashboards (anonymized), customer quotes

**Your authentic angle** (per your existing frames):
- "Show, don't tell" principle = perfect for screenshot-driven tweets
- Sovereign + Evaluator frames = confident, terse, no fluff tweets
- 15 years experience = technical authority most indie devs lack

**Tone**: don't shill, share the journey. The product sells itself if the journey is interesting.

**Tooling**: TweetHunter or Hypefury ($49/mo) once you're posting 5+/day. Skip until month 3.

---

## 11. 30-day launch checklist

### Pre-launch (build before Day 1)

- [ ] Buy domain (Cloudflare Registrar, $10/yr)
- [ ] Landing page (Hono + Preact SSR + Tailwind, deploy to Deno Deploy free)
- [ ] Pricing page with 3 tiers (Free, Pro $9-19, Team $29-49)
- [ ] Self-host `docker-compose.yml` works end-to-end in <5 min
- [ ] GitHub repo public with README (template §6)
- [ ] AGPLv3 LICENSE file
- [ ] CONTRIBUTING.md + .github/ISSUE_TEMPLATE + PR template
- [ ] Docs (1 page: install + first 5 min)
- [ ] Demo GIF (60-90s, ffmpeg or Screen Studio)
- [ ] Logo + favicon + OG image (Figma or Fiverr $30)
- [ ] IndieHackers profile + first "building in public" post drafted
- [ ] Twitter @yourproduct account created
- [ ] Show HN draft: title + first comment saved
- [ ] ProductHunt hunter contacted (2 weeks before launch)
- [ ] ProductHunt assets: tagline, description, gallery, maker bio
- [ ] Reddit post drafts for r/selfhosted + 2 niche subs
- [ ] Email forwarding via Cloudflare Email Routing
- [ ] Stripe account created + first product configured
- [ ] Plausible (self-hosted on Hetzner BM) on landing page

### Week 1 (launch)

- [ ] **Mon Day 1**: GitHub public. IH "building in public" post. Tweet thread.
- [ ] **Tue Day 2**: Show HN. Online 9-5 responding to every comment.
- [ ] **Wed Day 3**: r/selfhosted post + 2 niche sub posts.
- [ ] **Thu Day 4**: Blog post: "Why I built [Product]" (1,500 words, SEO).
- [ ] **Fri Day 5**: IH recap. Tweet MRR/update. Email GH stargazers.
- [ ] **Sat-Sun**: Triage GH issues. Reply to all IH comments. DM 3 podcast hosts.

### Week 2

- [ ] **Mon Day 8**: Email 5 podcast hosts + 3 newsletter writers
- [ ] **Wed Day 10**: PR to awesome-selfhosted
- [ ] **Thu Day 11**: Claim AlternativeTo listing
- [ ] **Tue Day 14**: ProductHunt launch. Online all day.
- [ ] **Day 15**: IH + Twitter recap. README gets PH badge. Landing page adds "as seen on PH".

### Week 3

- [ ] 3 customer interviews (free + paid)
- [ ] Blog: "[Product] vs [Competitor]" (1,500 words SEO)
- [ ] PR to Coolify catalog
- [ ] PR to Elestio + YunoHost + Cloudron
- [ ] IH "week 3" recap

### Week 4

- [ ] IH "month 1" recap post with public metrics
- [ ] 5 podcast outreach DMs (don't expect Y1 conversion, plant seeds)
- [ ] Engage daily on Deno Discord, r/deno, IndieHackers (30 min/day)
- [ ] Start affiliate program (20% lifetime via Lemon Squeezy or Stripe)

**End of month 1 target**:
- 100+ GitHub stars
- 100+ self-host installs
- 10-50 free cloud signups
- 0-10 paid customers
- $0-100 MRR

---

## 12. Y1 cost analysis

| Tool | Cost | Why |
|---|---|---|
| Domain | $10/yr | Cloudflare Registrar (at-cost) |
| Cloudflare proxy + DNS + Email Routing | $0 | SSL + email forwarding |
| Deno Deploy free | $0 | Cloud SaaS hosting for first 6-12 months |
| Resend transactional email | $0 (3K/mo) | Signup confirmations + receipts |
| Buttondown newsletter | $0 (100 subs) | Newsletter |
| Stripe | 2.9% + 30¢ | Payments (US) |
| Lemon Squeezy (alt) | 5% + 50¢ | Handles EU VAT, merchant of record |
| Plausible / Umami self-hosted | $0 | Analytics (already on Hetzner) |
| GitHub repo | $0 | Public repos free |
| Logo + favicon | $30 one-time | Fiverr |
| **Total Y1** | **$50-100** | First 6 months |

**Upgrade at $1K MRR**:
- TweetHunter / Hypefury: $49/mo
- Cal.com Pro: $12/mo (for sales calls)
- ConvertKit: $9/mo (newsletter automation)

**Skip**:
- HubSpot/Salesforce (overkill — spreadsheet + Stripe)
- Twitter Blue / X Premium ($8/mo, algorithm not pay-to-win)
- LinkedIn Premium (wrong audience)
- Meta/Google ads ($0 budget Y1)
- Mailchimp (ConvertKit/Loops/Buttondown beat it for indie)

---

## 13. Y1 metrics targets (first product)

| Milestone | Threshold | Time |
|---|---|---|
| GitHub stars | 100 | Month 1 |
| GitHub stars | 500 | Month 3 |
| GitHub stars | 1,000 | Month 6 |
| Self-host installs (Docker pulls) | 100 | Month 2 |
| Self-host installs | 1,000 | Month 6 |
| Free cloud signups | 50 | Month 2 |
| Free cloud signups | 500 | Month 6 |
| Paid customers | 10 | Month 3 |
| Paid customers | 50-100 | Month 6 |
| MRR | $100-500 | Month 3 |
| MRR | $1,000-1,500 | Month 6 (if product hits) |
| MRR | $2,000-3,000 | Month 12 (if hit + persist) |

**Kill criteria** (per Levels's 8% rule): if month 6 doesn't hit 500 stars + 50 self-hosts + $100 MRR → kill it, start product 2 with lessons.

---

## 14. Conversion math (realistic)

**GitHub stars → "traction" thresholds:**
- 1K stars = product works, has users, decent README
- 5K stars = strong indie traction
- 10K stars = category-defining for your niche
- 24K+ stars = exceptional (Dub-level)

**Trial → paid conversion:**
- 25-35% (top tier): Plausible hit 33.5% with no-CC 30-day trial
- 15-25% (typical indie open-core)
- 5-15% (cold traffic)

**Free-tier upgrade (forever-free model like Cal.com/Logto):**
- 2-5% conversion
- Volume 10x higher than trial

**Self-host → cloud correlation:**
- Self-host outnumbers cloud 10-100× early
- 1-3% of self-host users convert to paid cloud within 12 months
- Plan: 1,000 self-host installs → 10-30 cloud conversions/yr = $1-3K MRR

**$1K MRR math**:
- 100 paid × $10/mo (at 33.5% trial conversion: 300-500 trial signups)
- OR 2K-5K free-forever signups (at 2-5% upgrade)
- OR 1K self-host installs → 10-30 cloud conversions/yr

---

## 15. Deno ecosystem playbook

**Where Deno devs hang out:**
- Discord: discord.gg/deno (official, active)
- JSR Discord: discord.gg/hMqvhAn9xG
- Reddit: r/Deno (small but growing)
- GitHub Discussions: github.com/denoland
- Twitter: @deno_land, @deno_news, @lcaronato (Deno core)
- Conferences: Deno Day, JSConf, local JS meetups

**Tactic**: engage in Deno Discord 30 min/day for 2 weeks pre-launch. Become known. Then announce.

**Deno ecosystem references for open-core model:**
- **Logto** (14.5K stars, MPL-2.0 + proprietary cloud, $24/mo Pro) — closest peer
- **Fresh** — official Deno framework, OSS + Deno Deploy free tier
- **Deno KV-based products** — positioning opportunity, "Built on Deno KV" is a 2026 feature

**JSR as distribution channel:**
- Publish free utilities to jsr.io (npm-compatible, scored by activity)
- Auto-generated docs from TSDoc
- Every package = backlink to you
- Examples: Sindre Sorhus, Anthony Fu, Luca Casonato patterns

**Deno Deploy pricing for cloud SaaS:**
| Plan | Price | Requests/mo | Egress |
|---|---|---|---|
| Free | $0 | 1M | 20GB |
| Pro | $20/mo | 5M (+$2/M) | 200GB |
| Builder | $200/mo | 25M | 2TB |

For your $1-2K MRR SaaS at <1K paying users: Free plan covers first 6-12 months. Don't over-engineer.

---

## 16. Common pitfalls to avoid

- **Starting MIT** — switch later is painful. AGPLv3 day 1.
- **Skipping IndieHackers** — only platform without audience-gating. Free distribution, wasted if ignored.
- **Treating ProductHunt as growth strategy** — 1-day spike, not a channel.
- **Feature-gating the free tier** — cripple = no adoption. Gate by usage limits (events, projects, seats), not features.
- **Building 5 products before launching 1** — Levels 8% rule: 1-2 of 10 hit. Plan launches, expect kills.
- **Paid ads in Y1** — zero ROI at $0-1K MRR. Content + IH + HN > ads.
- **No demo GIF in README** — bounce in <5s without one.
- **Hiding cloud signup behind self-host** — self-hosters WILL pay $9 to skip upgrade pain. Show both CTAs.
- **Polished landing + no product** — HN crowd detects instantly, downvote.
- **No affiliate program** — missing 20-30% of word-of-mouth growth.
- **Engaging on Reddit without karma** — new accounts throttled. Pre-engage 1-2 weeks.
- **Per-launch IndieHackers burst** — bury the launch in normal activity first.
- **Forgetting the OG insight** — Plausible's "what NOT to do": no popups, no retargeting, no email sequences, no video (until MRR > $2K).

---

## 17. Your hidden strengths (Anton-specific)

You think you're zero on marketing. You're not. You have:

1. **Deno-first angle**: 95% of indie SaaS is Next.js + Vercel. Your stack = differentiation + community goodwill. "Built on Deno" is a 2026 feature.
2. **15 years experience**: write "Why I chose X over Y" technical posts with authority. Junior indie devs can't.
3. **Infrastructure depth**: most indie devs skip self-host. You = self-host-first + cloud-optional. Position as "I respect your infra choices."
4. **Blog muscle** (antonshubin.com): already has blog + RSS + AI crawler optimization. Repurpose technical decisions as blog posts on product site (cross-link).
5. **Show-don't-tell + Sovereign frames** (per user.txt): perfect for Twitter build-in-public. Marc Lou's playbook matches your natural style.
6. **Hackathon credibility**: "I won 2 hackathons building this" in product bio = trust signal.
7. **Already productized** (Upwork catalog, antonshubin.com B2B funnel): you've done the hard mental work of "what's my offer." Repackage for indie audience.

---

## 18. Pricing page template (3 tiers)

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│ Free        │ Pro         │ Team        │ Enterprise  │
│ $0/mo       │ $9/mo       │ $29/mo      │ Custom      │
├─────────────┼─────────────┼─────────────┼─────────────┤
│ 1 user      │ Unlimited   │ Unlimited   │ Everything  │
│ 1 project   │ Unlimited   │ Unlimited   │ in Team     │
│ 10K events  │ 100K events │ 1M events   │ + SSO/SAML  │
│ Community   │ Email       │ Priority    │ Audit logs  │
│ support     │ support     │ support     │ SLA         │
│ Product     │ No branding │ Custom      │ On-prem     │
│ branding    │             │ domain      │ option      │
└─────────────┴─────────────┴─────────────┴─────────────┘

Monthly ⇄ Annual (save 20%) toggle
30-day free trial, no credit card required
```

References: plausible.io/pricing, dub.co/pricing, logto.io/pricing, cal.com/pricing.

---

## 19. Email capture + onboarding flow

For cloud version:
1. **Landing CTA**: "Get started free" → signup form (email + password, OR magic link)
2. **Email verification**: single click, no friction
3. **Onboarding wizard**: 3-5 steps max, ask only what's needed
4. **First-run experience**: pre-populated demo data so user sees value immediately
5. **Trial day 1**: in-app upgrade prompt (subtle, not popup)
6. **Trial day 7**: email summary of usage + upgrade CTA
7. **Trial day 14**: email "trial ends in X days" + upgrade CTA
8. **Trial day 28**: email "trial ends tomorrow" + upgrade CTA
9. **Trial day 30**: convert to free tier (limited), email with upgrade CTA

**Stripe setup**: use Customer Portal for self-service plan changes + cancellations. Don't build custom billing UI.

**Resend** for transactional email (3K/mo free): verifications, receipts, trial notifications.

---

## 20. SEO content calendar (week 4+)

Post 1 SEO-optimized blog post per week. Each targets "[competitor] alternative" or "[problem] open source" search intent.

**Week 4**: "[Product] vs [Main Competitor]" (1,500 words, comparison table, screenshots)
**Week 5**: "Why I switched from [BigSaaS] to [Product]" (personal story, before/after)
**Week 6**: "Self-hosting [Product] on Hetzner" (technical tutorial, 1,500 words + screenshots)
**Week 7**: "Open source [category] tools in 2026" (roundup post, link to competitors too)
**Week 8**: "How we built [Product] with Deno + SQLite" (technical deep-dive, your authority)
**Week 9**: "Why we use AGPLv3 (and you should too)" (license decision post)

**SEO rules**:
- 1,500+ words per post
- Title with primary keyword ("[Product] vs [Competitor]")
- Comparison table (Google loves these)
- Screenshots with alt text
- Internal links to your other posts
- Submit URL to Google Search Console after publish

---

## 21. Affiliate / referral program

**Setup**: 20-30% lifetime commission via Lemon Squeezy or Stripe.

**Why it works**: word-of-mouth is 20-30% of open-core growth. Affiliates convert better than ads because they have trusted audience.

**Tiers**:
- 20% lifetime for everyone
- 30% for affiliates with >10 referrals (incentivize top performers)
- Special program for newsletters + podcasts (custom rates)

**Systeme.io model**: $83K/mo with 60% revenue from affiliate program (cited in research). Most successful indie affiliates use this exact structure.

---

## 22. Quick reference: when stuck

| Situation | Action |
|---|---|
| No idea what product to build | Solve your own problem first. Eat your own dogfood. |
| Launched but no signups | Check IH + Twitter + Show HN rhythm. 1 post/week minimum on each. |
| Show HN flopped | Normal. Most don't hit. Repost in 1 month with different angle. |
| Free users, no paid conversion | Pricing too high, or free tier too generous. Test $9 vs $19. |
| GitHub stars flat | Demo GIF missing or low quality. Rework README. |
| Spinning on marketing instead of product | Marketing is 20% of time max. Product is 80%. |
| Wanting to add features pre-launch | Don't. Ship. Plausible shipped with bugs. |
| Comparing to GitLab/Sentry | Stop. They're $100M+ ARR. You're indie. Different game. |
| Asking "should I do paid ads?" | No. Not until $1K MRR. |
| Burned out from social media | Batch content creation (1 day/week), schedule the rest. |

---

## References (for deeper dives)

- `~/ssd-2tb/sync/random/ai/open-core-marketing-research.md` — full 1,130-line research with 44 sources
- Plausible's playbook: `plausible.io/blog/open-source-saas`, `plausible.io/blog/open-source-licenses`
- Cal.com open-source story: `cal.com/blog/open-source`
- Show HN guidelines: `news.ycombinator.com/showhn.html`
- OpenCode skills docs: `opencode.ai/docs/skills`

---

## Final one-liner

AGPLv3 repo + great README → IH post → Show HN → PH Day 14 → r/selfhosted → weekly blog. Audience compounds in months. Ship fast, kill slow, build in public.
