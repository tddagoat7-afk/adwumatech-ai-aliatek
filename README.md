# Aliatek Intelligence OS v11

A futuristic public-intelligence dashboard for searching companies, brands, universities, products, and organizations.

## Features

- Space-themed welcome experience
- 320 animated star nodes and 300+ coordinated motion states
- Working launch, demo, search, period, market, navigation, export, filter, print, and theme controls
- 7, 30, and 90-day analysis
- Global and U.S.-focused modes
- Google News US, UK, and global variants
- Bing News, Yahoo News, GDELT, Hacker News, Reddit, and Bluesky
- Optional NewsAPI and YouTube support
- Query expansion, deduplication, relevance, recency, authority, confidence, and sentiment scoring
- Executive summary, source rankings, topic radar, provider diagnostics, evidence explorer, CSV export, and printable report

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Optional environment variables

```text
NEWS_API_KEY=
YOUTUBE_API_KEY=
```

The dashboard still works without these keys; those providers will simply return no results.

## Deploy on Render

Create a new Render Blueprint from this repository. Render will detect `render.yaml` automatically.

Health endpoint: `/api/health`
