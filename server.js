const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(cors());

// Configuration Standard (Sans agent complexe qui bloque parfois)
const AXIOS_CONFIG = {
    timeout: 45000, // 45 secondes max
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://archiveofourown.org/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Connection': 'close' // On ferme pour éviter les sockets fantômes sur Render Free
    }
};

// --- RECHERCHE ---
async function scrapeSearch(fullQuery) {
    const startTotal = Date.now();
    console.log(`[Proxy] Démarrage recherche: "${fullQuery}"`);
    
    let sortColumn = '_score'; 
    let sortDirection = 'desc';
    let ratingId = null;
    let isComplete = null;
    let cleanQuery = fullQuery || "";

    // 1. Parsing (Rapide)
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
        // 2. Téléchargement (Le goulot d'étranglement habituel)
        const startNet = Date.now();
        const response = await axios.get(url, AXIOS_CONFIG);
        console.log(`[Perf] Téléchargement AO3: ${(Date.now() - startNet)}ms`);

        // 3. Analyse HTML (CPU)
        const startParse = Date.now();
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
        
        console.log(`[Perf] Parsing HTML: ${(Date.now() - startParse)}ms`);
        console.log(`[Perf] TEMPS TOTAL: ${(Date.now() - startTotal)}ms`);
        return results;

    } catch (err) {
        console.error("[Proxy] Erreur:", err.message);
        return [];
    }
}

// --- LECTURE ---
async function scrapeWork(id) {
    try {
        const { data } = await axios.get(`https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`, AXIOS_CONFIG);
        const $ = cheerio.load(data);
        
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
        return { error: "Erreur" };
    }
}

// --- AUTOCOMPLETE ---
async function getAutocomplete(term) {
    try {
        const config = { ...AXIOS_CONFIG, headers: { ...AXIOS_CONFIG.headers, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } };
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
app.get('/', (req, res) => res.send('AO3 Proxy V5 - Ready'));
app.get('/status', (req, res) => {
    console.log("[Ping] Vérification statut reçu");
    res.json({ status: 'online', time: Date.now() });
});

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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
