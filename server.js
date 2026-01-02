const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const compression = require('compression');
const dns = require('dns');

// Cache DNS pour gagner 200ms
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch(e) {}

const app = express();
const PORT = process.env.PORT || 3000;

// Compression GZIP maximale
app.use(compression({ level: 6 }));
app.use(cors());

// Optimisation Réseau : Agent Keep-Alive
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    keepAliveMsecs: 3000,
    maxSockets: 50, 
    maxFreeSockets: 10,
    timeout: 15000, 
    scheduling: 'lifo'
});

const AXIOS_CONFIG = {
    httpsAgent: httpsAgent,
    timeout: 15000, // Timeout 15s
    headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ArchiveReader/2.0)',
        'Referer': 'https://archiveofourown.org/',
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
};

// --- 1. RECHERCHE OPTIMISÉE ---
async function scrapeSearch(fullQuery) {
    const start = Date.now();
    let sortColumn = '_score'; 
    let sortDirection = 'desc';
    let ratingId = null;
    let isComplete = null;
    let cleanQuery = fullQuery || "";

    // Filtres
    if (cleanQuery.includes('sort:kudos')) { sortColumn = 'kudos_count'; cleanQuery = cleanQuery.replace('sort:kudos', ''); }
    else if (cleanQuery.includes('sort:hits')) { sortColumn = 'hits'; cleanQuery = cleanQuery.replace('sort:hits', ''); }
    else if (cleanQuery.includes('sort:date')) { sortColumn = 'revised_at'; cleanQuery = cleanQuery.replace('sort:date', ''); }

    const ratingMatch = cleanQuery.match(/rating:"([^"]+)"/);
    if (ratingMatch) {
        const map = { 'Not Rated': '9', 'General Audiences': '10', 'Teen And Up Audiences': '11', 'Mature': '12', 'Explicit': '13' };
        ratingId = map[ratingMatch[1]];
        cleanQuery = cleanQuery.replace(ratingMatch[0], '');
    }

    if (cleanQuery.includes('complete:true')) { isComplete = 'T'; cleanQuery = cleanQuery.replace('complete:true', ''); }

    // Tags
    let extraTags = [];
    const tagMatches = cleanQuery.match(/tag:"([^"]+)"/g);
    if (tagMatches) {
        tagMatches.forEach(t => {
            extraTags.push(t.match(/tag:"([^"]+)"/)[1]);
            cleanQuery = cleanQuery.replace(t, '');
        });
    }

    cleanQuery = cleanQuery.trim();

    const params = new URLSearchParams();
    params.append('commit', 'Search');
    params.append('work_search[query]', cleanQuery);
    params.append('work_search[sort_column]', sortColumn);
    params.append('work_search[sort_direction]', sortDirection);
    if (ratingId) params.append('work_search[rating_ids]', ratingId);
    if (isComplete) params.append('work_search[complete]', isComplete);
    
    if (extraTags.length > 0) {
        const q = params.get('work_search[query]');
        params.set('work_search[query]', (q ? q + ' ' : '') + extraTags.join(' '));
    }

    const url = `https://archiveofourown.org/works/search?${params.toString()}`;

    try {
        const response = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(response.data);
        const results = [];

        $('.work.blurb').each((i, el) => {
            const titleElement = $(el).find('.heading a').first();
            if (!titleElement.length) return;

            const stats = $(el).find('dl.stats');
            const words = parseInt(stats.find('dd.words').text().replace(/,/g, '')) || 0;
            const chapters = parseInt(stats.find('dd.chapters').text().split('/')[0]) || 1;

            results.push({
                id: titleElement.attr('href')?.split('/')[2],
                title: titleElement.text().trim(),
                author: $(el).find('.heading a[rel="author"]').text().trim() || "Anonymous",
                fandom: $(el).find('.fandoms a').first().text().trim(),
                rating: $(el).find('.rating .text').text().trim(),
                relationships: $(el).find('.relationships a').map((_, a) => $(a).text().trim()).get(),
                tags: $(el).find('.freeforms a').slice(0, 5).map((_, a) => $(a).text().trim()).get(),
                summary: $(el).find('.summary blockquote').text().trim(),
                words,
                chapters,
                updated: $(el).find('p.datetime').text().trim()
            });
        });
        
        console.log(`[Perf] Recherche ${results.length} items en ${(Date.now() - start)}ms`);
        return results;
    } catch (err) {
        console.error("[Proxy] Erreur:", err.message);
        return [];
    }
}

// --- 2. LECTURE ---
async function scrapeWork(id) {
    const url = `https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`;
    try {
        const { data } = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(data);
        
        let content = [];
        if ($('#chapters').length) {
            $('#chapters .userstuff').each((i, el) => content.push($(el).html()));
        } else {
            content.push($('.userstuff').html());
        }

        return {
            id,
            title: $('.title.heading').text().trim(),
            author: $('a[rel="author"]').text().trim(),
            content: content.filter(Boolean),
            chapters: content.length
        };
    } catch (err) {
        return { error: "Erreur chargement" };
    }
}

// --- 3. AUTOCOMPLETE (FIX) ---
async function getAutocomplete(term) {
    const config = {
        ...AXIOS_CONFIG,
        headers: { 
            ...AXIOS_CONFIG.headers, 
            'X-Requested-With': 'XMLHttpRequest', // Obligatoire
            'Accept': 'application/json'
        }
    };
    try {
        const { data } = await axios.get(`https://archiveofourown.org/autocomplete/tag?term=${encodeURIComponent(term)}`, config);
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function scrapePopularTags() {
    try {
        const { data } = await axios.get('https://archiveofourown.org/tags', AXIOS_CONFIG);
        const $ = cheerio.load(data);
        const tags = [];
        $('.cloud a').slice(0, 50).each((i, el) => tags.push($(el).text().trim()));
        return tags;
    } catch (e) { return []; }
}

// --- ROUTES ---
app.get('/', (req, res) => res.send('AO3 Turbo Proxy V5'));
app.get('/status', (req, res) => res.json({ status: 'online', time: Date.now() }));

app.get('/search', async (req, res) => {
    if (!req.query.q || req.query.q.trim().length === 0) return res.json([]);
    const results = await scrapeSearch(req.query.q);
    res.json(results);
});

app.get('/work/:id', async (req, res) => {
    const work = await scrapeWork(req.params.id);
    res.json(work);
});

app.get('/tags', async (req, res) => {
    const tags = await scrapePopularTags();
    res.json(tags);
});

app.get('/autocomplete', async (req, res) => {
    if (!req.query.q || req.query.q.length < 2) return res.json([]);
    const results = await getAutocomplete(req.query.q);
    res.json(results);
});

// Auto-Ping toutes les 5 min
setInterval(() => {
    axios.get(`http://localhost:${PORT}/status`).catch(() => {});
}, 5 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
