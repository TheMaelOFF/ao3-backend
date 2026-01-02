const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression({ level: 6 }));
app.use(cors());

// --- OPTIMISATION : Mode "Discret" ---
// On réduit drastiquement le nombre de connexions pour ne pas énerver AO3
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    keepAliveMsecs: 5000, 
    maxSockets: 5,        // RÉDUIT : 5 au lieu de 50 (évite le ban)
    maxFreeSockets: 2,
    timeout: 60000
});

const AXIOS_CONFIG = {
    httpsAgent: httpsAgent,
    timeout: 60000, 
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://archiveofourown.org/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive'
    }
};

// --- SYSTÈME DE RÉESSAI INTELLIGENT ---
// Si on prend un 429 (Trop de requêtes), on attend et on réessaie.
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, config = AXIOS_CONFIG, retries = 3) {
    try {
        return await axios.get(url, config);
    } catch (error) {
        // Si erreur 429 (Trop vite) ou 503 (Surcharge AO3)
        if (error.response && (error.response.status === 429 || error.response.status === 503) && retries > 0) {
            console.log(`[Proxy] AO3 dit "Trop vite" (429). Pause de 5s... (${retries} essais restants)`);
            await delay(5000 + Math.random() * 2000); // Attente aléatoire entre 5s et 7s
            return fetchWithRetry(url, config, retries - 1);
        }
        throw error;
    }
}

// --- RECHERCHE ---
async function scrapeSearch(fullQuery) {
    const startTotal = Date.now();
    console.log(`[Proxy] Recherche: "${fullQuery}"`);
    
    let sortColumn = '_score'; 
    let sortDirection = 'desc';
    let ratingId = null;
    let isComplete = null;
    let cleanQuery = fullQuery || "";

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
        // Utilisation du fetch intelligent
        const response = await fetchWithRetry(url);
        
        const $ = cheerio.load(response.data);
        const results = [];

        $('.work.blurb').each((i, el) => {
            const titleElement = $(el).find('.heading a').first();
            if (!titleElement.length) return;

            const stats = $(el).find('dl.stats');
            
            results.push({
                id: titleElement.attr('href')?.split('/')[2],
                title: titleElement.text().trim(),
                author: $(el).find('.heading a[rel="author"]').text().trim() || "Anonymous",
                fandom: $(el).find('.fandoms a').first().text().trim(),
                rating: $(el).find('.rating .text').text().trim(),
                relationships: $(el).find('.relationships a').map((_, a) => $(a).text().trim()).get(),
                tags: $(el).find('.freeforms a').slice(0, 5).map((_, a) => $(a).text().trim()).get(),
                summary: $(el).find('.summary blockquote').text().trim(),
                words: parseInt(stats.find('dd.words').text().replace(/,/g, '')) || 0,
                chapters: parseInt(stats.find('dd.chapters').text().split('/')[0]) || 1,
                updated: $(el).find('p.datetime').text().trim()
            });
        });
        
        console.log(`[Perf] OK (${results.length} items) en ${(Date.now() - startTotal)}ms`);
        return results;

    } catch (err) {
        console.error("[Proxy] Échec final:", err.message);
        return [];
    }
}

// --- LECTURE ---
async function scrapeWork(id) {
    try {
        const response = await fetchWithRetry(`https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`);
        const $ = cheerio.load(response.data);
        
        let content = [];
        const nodes = $('#chapters').length ? $('#chapters .userstuff') : $('.userstuff');
        nodes.each((i, el) => content.push($(el).html()));

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

// --- AUTOCOMPLETE ---
async function getAutocomplete(term) {
    const config = { 
        ...AXIOS_CONFIG, 
        headers: { ...AXIOS_CONFIG.headers, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } 
    };
    try {
        // On n'utilise pas le retry ici pour aller vite (l'autocomplete doit être instantané)
        const { data } = await axios.get(`https://archiveofourown.org/autocomplete/tag?term=${encodeURIComponent(term)}`, config);
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}

async function scrapePopularTags() {
    try {
        const response = await fetchWithRetry('https://archiveofourown.org/tags');
        const $ = cheerio.load(response.data);
        const tags = [];
        $('.cloud a').slice(0, 50).each((i, el) => tags.push($(el).text().trim()));
        return tags;
    } catch (e) { return []; }
}

// --- ROUTES ---
app.get('/', (req, res) => res.send('AO3 Proxy V7 (Anti-429)'));
app.get('/status', (req, res) => res.json({ status: 'online', time: Date.now() }));

app.get('/search', async (req, res) => {
    if (!req.query.q) return res.json([]);
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
    const results = await getAutocomplete(req.query.q);
    res.json(results);
});

// Ping
setInterval(() => {
    axios.get(`http://localhost:${PORT}/status`).catch(() => {});
}, 4 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
