import express from 'express';
import cors from 'cors';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const UA = 'AdwumaTech-Aliatek-Intelligence/11.0';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (v = '') => String(v).replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
const asDate = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'unknown'; } };
const stripTracking = u => { try { const x = new URL(u); ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => x.searchParams.delete(k)); return x.toString(); } catch { return u; } };

async function fetchText(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'user-agent': UA, accept: '*/*', ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function parseRss(xml, provider) {
  const data = parser.parse(xml);
  const root = data?.rss?.channel || data?.feed || {};
  let rows = root.item || root.entry || [];
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map(row => {
    const link = typeof row.link === 'string' ? row.link : row.link?.href || row.guid || '';
    const date = asDate(row.pubDate || row.published || row.updated || row.date);
    const source = clean(row.source?.['#text'] || row.source || '') || host(link);
    return {
      title: clean(row.title?.['#text'] || row.title),
      description: clean(row.description || row.summary || row.content || ''),
      url: stripTracking(link),
      source,
      provider,
      published: date?.toISOString() || null,
      date
    };
  }).filter(x => x.title && x.url);
}

function variants(name) {
  const simple = name.replace(/\b(incorporated|inc\.?|corp\.?|corporation|company|co\.?|group|holdings?|limited|ltd\.?|llc|plc)\b/gi, '').replace(/\s+/g, ' ').trim();
  return [...new Set([
    name,
    simple,
    `${name} company`,
    `${name} brand`,
    `${name} news`,
    `${name} CEO`,
    `${name} product`,
    `${name} partnership`,
    `${name} funding`,
    `${name} lawsuit`,
    `${name} review`,
    `${name} controversy`
  ].filter(Boolean))];
}

async function googleNews(q, days, region = 'US', lang = 'en-US', ceid = 'US:en') {
  const query = encodeURIComponent(`"${q}" when:${days}d`);
  return parseRss(await fetchText(`https://news.google.com/rss/search?q=${query}&hl=${lang}&gl=${region}&ceid=${ceid}`), `Google News ${region}`);
}
async function bingNews(q) { return parseRss(await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(`"${q}"`)}&format=rss`), 'Bing News'); }
async function yahooNews(q) { return parseRss(await fetchText(`https://news.search.yahoo.com/rss?p=${encodeURIComponent(`"${q}"`)}`), 'Yahoo News'); }
async function gdelt(q, days) {
  const start = new Date(Date.now() - days * 86400000);
  const end = new Date();
  const fmt = d => d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const raw = await fetchText(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${q}"`)}&mode=ArtList&maxrecords=250&format=json&startdatetime=${fmt(start)}&enddatetime=${fmt(end)}&sort=HybridRel`, {}, 14000);
  const data = JSON.parse(raw);
  return (data.articles || []).map(a => { const date = asDate(a.seendate || a.date); return { title: clean(a.title), description: `Coverage detected by GDELT from ${a.domain || 'unknown source'}.`, url: stripTracking(a.url), source: a.domain || host(a.url), provider: 'GDELT', published: date?.toISOString() || null, date }; });
}
async function hackerNews(q, days) {
  const after = Math.floor((Date.now() - days * 86400000) / 1000);
  const raw = await fetchText(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${after}&hitsPerPage=100`);
  const data = JSON.parse(raw);
  return (data.hits || []).map(h => { const date = asDate(h.created_at); const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`; return { title: clean(h.title), description: `${h.points || 0} points · ${h.num_comments || 0} comments`, url, source: host(url), provider: 'Hacker News', published: date?.toISOString() || null, date }; });
}
async function reddit(q, days) {
  const t = days <= 7 ? 'week' : days <= 30 ? 'month' : 'year';
  const raw = await fetchText(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=${t}&limit=100`, { headers: { accept: 'application/json' } });
  const data = JSON.parse(raw);
  return (data?.data?.children || []).map(({ data: p }) => { const date = asDate((p.created_utc || 0) * 1000); return { title: clean(p.title), description: clean(p.selftext || `${p.score || 0} score · ${p.num_comments || 0} comments`), url: `https://www.reddit.com${p.permalink}`, source: `reddit.com/r/${p.subreddit}`, provider: 'Reddit', published: date?.toISOString() || null, date }; });
}
async function bluesky(q) {
  const raw = await fetchText(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=100`, { headers: { accept: 'application/json' } });
  const data = JSON.parse(raw);
  return (data.posts || []).map(p => { const date = asDate(p.record?.createdAt || p.indexedAt); const handle = p.author?.handle || 'unknown'; return { title: clean((p.record?.text || '').slice(0, 180)), description: clean(p.record?.text || ''), url: `https://bsky.app/profile/${handle}/post/${p.uri?.split('/').pop()}`, source: `bsky.app/${handle}`, provider: 'Bluesky', published: date?.toISOString() || null, date }; }).filter(x => x.title);
}
async function newsApi(q, days) {
  if (!process.env.NEWS_API_KEY) return [];
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
  const raw = await fetchText(`https://newsapi.org/v2/everything?q=${encodeURIComponent(`"${q}"`)}&from=${from}&language=en&sortBy=publishedAt&pageSize=100&apiKey=${process.env.NEWS_API_KEY}`);
  const data = JSON.parse(raw);
  return (data.articles || []).map(a => { const date = asDate(a.publishedAt); return { title: clean(a.title), description: clean(a.description || a.content), url: stripTracking(a.url), source: a.source?.name || host(a.url), provider: 'NewsAPI', published: date?.toISOString() || null, date }; });
}
async function youtube(q, days) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const after = new Date(Date.now() - days * 86400000).toISOString();
  const raw = await fetchText(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&order=date&q=${encodeURIComponent(q)}&publishedAfter=${after}&key=${process.env.YOUTUBE_API_KEY}`);
  const data = JSON.parse(raw);
  return (data.items || []).map(v => { const date = asDate(v.snippet?.publishedAt); return { title: clean(v.snippet?.title), description: clean(v.snippet?.description), url: `https://www.youtube.com/watch?v=${v.id?.videoId}`, source: v.snippet?.channelTitle || 'YouTube', provider: 'YouTube', published: date?.toISOString() || null, date }; });
}

function sentiment(text = '') {
  const t = text.toLowerCase();
  const pos = ['growth','award','profit','record','launch','expands','partnership','success','innovation','approved','wins','surges'];
  const neg = ['lawsuit','fraud','loss','crisis','recall','investigation','breach','controversy','risk','warning','drops','decline'];
  let score = 0; pos.forEach(w => t.includes(w) && score++); neg.forEach(w => t.includes(w) && score--);
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}
function authority(source = '') {
  const s = source.toLowerCase();
  if (['reuters','apnews','bbc','bloomberg','ft.com','wsj','sec.gov'].some(x => s.includes(x))) return 96;
  if (['cnbc','cnn','forbes','techcrunch','businesswire','prnewswire'].some(x => s.includes(x))) return 84;
  if (s.includes('reddit') || s.includes('bsky') || s.includes('youtube')) return 62;
  return 72;
}
function dedupe(items) {
  const seen = new Set();
  return items.filter(x => { const key = `${clean(x.title).toLowerCase()}|${stripTracking(x.url)}`; if (!x.title || seen.has(key)) return false; seen.add(key); return true; });
}
function enrich(items, q, days) {
  const cutoff = Date.now() - days * 86400000;
  const ql = q.toLowerCase();
  return dedupe(items).filter(x => !x.date || x.date.getTime() >= cutoff).map(x => {
    const text = `${x.title} ${x.description}`;
    const a = authority(x.source);
    const age = x.date ? Math.max(0, (Date.now() - x.date.getTime()) / 86400000) : days;
    const recency = Math.max(20, Math.round(100 - age * (80 / Math.max(days, 1))));
    const relevance = Math.min(100, 55 + (text.toLowerCase().includes(ql) ? 35 : 10));
    return { ...x, sentiment: sentiment(text), authority: a, recency, relevance, confidence: Math.round(a * .4 + recency * .25 + relevance * .35) };
  }).sort((a,b) => b.confidence - a.confidence || (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
}
function analytics(items, providerStatus, company, days) {
  const counts = { positive:0, neutral:0, negative:0 }, source = new Map(), topic = new Map(), day = new Map();
  const stop = new Set(['about','after','again','before','brand','company','could','their','there','these','those','through','today','would','with','from','have','that','this','says','said']);
  for (const x of items) {
    counts[x.sentiment]++;
    source.set(x.source, (source.get(x.source) || 0) + 1);
    day.set(x.published?.slice(0,10) || 'Unknown', (day.get(x.published?.slice(0,10) || 'Unknown') || 0) + 1);
    clean(`${x.title} ${x.description}`).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4 && !stop.has(w)).forEach(w => topic.set(w, (topic.get(w) || 0) + 1));
  }
  const total = items.length, pct = k => total ? Math.round(counts[k] / total * 100) : 0;
  const avg = total ? Math.round(items.reduce((s,x) => s + x.confidence, 0) / total) : 0;
  const reputation = Math.max(0, Math.min(100, Math.round(50 + pct('positive')*.55 - pct('negative')*.65 + avg*.15)));
  const trust = Math.max(0, Math.min(100, Math.round(avg*.75 + pct('positive')*.2 - pct('negative')*.15)));
  const crisisRisk = Math.max(0, Math.min(100, Math.round(pct('negative')*1.15 + Math.min(25, counts.negative*2))));
  const opportunity = Math.max(0, Math.min(100, Math.round(pct('positive')*.5 + Math.min(total,50) + (100-crisisRisk)*.2)));
  const top = m => [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count}));
  const topTopics = top(topic), topSources = top(source), timeline = [...day.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,count])=>({date,count}));
  const summary = total ? `${company} generated ${total} verified public mentions in the last ${days} days. Coverage is ${pct('positive')}% positive, ${pct('neutral')}% neutral, and ${pct('negative')}% negative. Reputation scores ${reputation}/100, trust ${trust}/100, and crisis risk ${crisisRisk}/100.` : `No verified public mentions were found for ${company} in the selected ${days}-day window.`;
  const recommendations = [];
  if (!total) recommendations.push('Increase indexed public visibility through consistent naming, announcements, and searchable press coverage.');
  if (crisisRisk >= 45) recommendations.push('Review negative high-authority mentions and prepare a response plan.');
  if (pct('positive') < 25 && total) recommendations.push('Publish more proof-based stories around wins, outcomes, partnerships, and measurable impact.');
  if (source.size < 5 && total) recommendations.push('Diversify coverage across more independent publishers.');
  if (!recommendations.length) recommendations.push('Maintain momentum and monitor sudden shifts in sentiment, source quality, and velocity.');
  return { company, days, generatedAt:new Date().toISOString(), totals:{ mentions:total, sources:source.size, providers:providerStatus.filter(x=>x.status==='online').length, ...counts }, percentages:{ positive:pct('positive'), neutral:pct('neutral'), negative:pct('negative') }, scores:{ reputation, trust, crisisRisk, opportunity, confidence:avg }, topTopics, topSources, timeline, summary, recommendations, providerStatus };
}

app.get('/api/health', (_req,res) => res.json({ status:'ok', version:'11.0.0', providers:['Google News US','Google News UK','Google News Global','Bing','Yahoo','GDELT','Hacker News','Reddit','Bluesky','NewsAPI optional','YouTube optional'] }));
app.get('/api/search', async (req,res) => {
  const company = clean(req.query.company || req.query.q || '');
  const days = [7,30,90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const market = req.query.market === 'us' ? 'us' : 'global';
  if (company.length < 2) return res.status(400).json({ error:'Enter a company, brand, or organization.' });
  const cacheKey = `${company.toLowerCase()}|${days}|${market}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json({ ...cached.data, cached:true });

  const qs = variants(company).slice(0, 8);
  const providers = [];
  const jobs = [];
  const add = (name, fn) => jobs.push((async()=>{ try { const data = await fn(); providers.push({name,status:'online',mentions:data.length}); return data; } catch (e) { providers.push({name,status:'limited',mentions:0,message:e.message}); return []; } })());

  add('Google News US', async()=> (await Promise.all(qs.slice(0,4).map(q=>googleNews(q,days,'US','en-US','US:en')))).flat());
  add('Google News UK', async()=> (await Promise.all(qs.slice(0,2).map(q=>googleNews(q,days,'GB','en-GB','GB:en')))).flat());
  add('Google News Global', async()=> (await Promise.all(qs.slice(0,2).map(q=>googleNews(q,days,'CA','en-CA','CA:en')))).flat());
  add('Bing News', async()=> (await Promise.all(qs.slice(0,3).map(bingNews))).flat());
  add('Yahoo News', async()=> (await Promise.all(qs.slice(0,2).map(yahooNews))).flat());
  add('GDELT', ()=>gdelt(company,days));
  add('Hacker News', ()=>hackerNews(company,days));
  add('Reddit', ()=>reddit(company,days));
  add('Bluesky', ()=>bluesky(company));
  add('NewsAPI', ()=>newsApi(company,days));
  add('YouTube', ()=>youtube(company,days));

  const raw = (await Promise.all(jobs)).flat();
  const items = enrich(raw, company, days).slice(0, 2000);
  const payload = { version:'11.0.0', query:company, days, market, items, analytics:analytics(items,providers,company,days), cached:false };
  cache.set(cacheKey,{ time:Date.now(), data:payload });
  res.json(payload);
});
app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Aliatek Intelligence OS v11 running on ${PORT}`));
