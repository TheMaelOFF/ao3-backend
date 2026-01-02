const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. OPTIMISATION : Compression GZIP pour réduire la taille des réponses (texte/html/json)
app.use(compression());
app.use(cors());

// 2. OPTIMISATION : Agent HTTPS Keep-Alive
// Garde la connexion ouverte avec AO3 pour éviter de refaire le handshake SSL à chaque recherche.
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 10, 
    freeSocketTimeout: 30000 
});

// Configuration Axios Globale
const AXIOS_CONFIG = {
    httpsAgent: httpsAgent, // Utilise l'agent optimisé
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://archiveofourown.org/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive' // Demande à AO3 de garder la ligne ouverte
    },
    timeout: 15000 // Timeout de 15s pour ne pas bloquer indéfiniment
};

// --- LOGIQUE DE RECHERCHE AVANCÉE ---
async function scrapeSearch(fullQuery) {
    console.log(`[Proxy] Recherche: ${fullQuery}`);
    
    let sortColumn = '_score'; 
    let sortDirection = 'desc';
    let ratingId = null;
    let isComplete = null;
    let cleanQuery = fullQuery || "";

    // Extraction des filtres spéciaux
    if (cleanQuery.includes('sort:kudos')) { sortColumn = 'kudos_count'; cleanQuery = cleanQuery.replace('sort:kudos', ''); }
    else if (cleanQuery.includes('sort:hits')) { sortColumn = 'hits'; cleanQuery = cleanQuery.replace('sort:hits', ''); }
    else if (cleanQuery.includes('sort:date')) { sortColumn = 'revised_at'; cleanQuery = cleanQuery.replace('sort:date', ''); }

    const ratingMatch = cleanQuery.match(/rating:"([^"]+)"/);
    if (ratingMatch) {
        const r = ratingMatch[1];
        if (r === 'Not Rated') ratingId = '9';
        if (r === 'General Audiences') ratingId = '10';
        if (r === 'Teen And Up Audiences') ratingId = '11';
        if (r === 'Mature') ratingId = '12';
        if (r === 'Explicit') ratingId = '13';
        cleanQuery = cleanQuery.replace(ratingMatch[0], '');
    }

    if (cleanQuery.includes('complete:true')) {
        isComplete = 'T';
        cleanQuery = cleanQuery.replace('complete:true', '');
    }

    // Gestion des tags spécifiques (tag:"Nom")
    const tagMatches = cleanQuery.match(/tag:"([^"]+)"/g);
    let extraTags = [];
    if (tagMatches) {
        tagMatches.forEach(t => {
            const tagName = t.match(/tag:"([^"]+)"/)[1];
            extraTags.push(tagName);
            cleanQuery = cleanQuery.replace(t, '');
        });
    }

    cleanQuery = cleanQuery.trim();

    // Construction de l'URL AO3
    const params = new URLSearchParams();
    params.append('commit', 'Search');
    params.append('work_search[query]', cleanQuery);
    params.append('work_search[sort_column]', sortColumn);
    params.append('work_search[sort_direction]', sortDirection);
    if (ratingId) params.append('work_search[rating_ids]', ratingId);
    if (isComplete) params.append('work_search[complete]', isComplete);
    
    // Ajout des tags supplémentaires
    if (extraTags.length > 0) {
        const currentQ = params.get('work_search[query]');
        params.set('work_search[query]', (currentQ ? currentQ + ' ' : '') + extraTags.join(' '));
    }

    const url = `https://archiveofourown.org/works/search?${params.toString()}`;

    try {
        const response = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(response.data);
        const results = [];

        $('.work.blurb').each((i, el) => {
            const titleElement = $(el).find('.heading a').first();
            if (!titleElement.length) return;

            const href = titleElement.attr('href');
            const id = href ? href.match(/\/works\/(\d+)/)?.[1] : null;

            if (id) {
                const wordsTxt = $(el).find('dd.words').text().replace(/,/g, '');
                const chaptersTxt = $(el).find('dd.chapters').text().split('/')[0];
                const ratingText = $(el).find('.rating .text').text().trim();

                results.push({
                    id,
                    title: titleElement.text().trim(),
                    author: $(el).find('.heading a[rel="author"]').text().trim() || "Anonymous",
                    fandom: $(el).find('.fandoms a').first().text().trim(),
                    rating: ratingText,
                    relationships: $(el).find('.relationships a').map((_, a) => $(a).text().trim()).get(),
                    tags: $(el).find('.freeforms a').map((_, a) => $(a).text().trim()).get(),
                    summary: $(el).find('.summary blockquote').text().trim(),
                    words: parseInt(wordsTxt) || 0,
                    chapters: parseInt(chaptersTxt) || 1,
                    updated: $(el).find('p.datetime').text().trim()
                });
            }
        });
        return results;
    } catch (err) {
        console.error("[Proxy] Erreur Recherche:", err.message);
        return [];
    }
}

// --- LOGIQUE DE LECTURE (Chapitres) ---
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
        return { error: "Impossible de charger l'œuvre." };
    }
}

// --- LOGIQUE AUTOCOMPLETE (Avec fix X-Requested-With) ---
async function getAutocomplete(term) {
    const ajaxConfig = {
        ...AXIOS_CONFIG,
        headers: {
            ...AXIOS_CONFIG.headers,
            'X-Requested-With': 'XMLHttpRequest', 
            'Accept': 'application/json'
        }
    };
    
    const url = `https://archiveofourown.org/autocomplete/tag?term=${encodeURIComponent(term)}`;
    
    try {
        const { data } = await axios.get(url, ajaxConfig);
        if (Array.isArray(data)) return data;
        return [];
    } catch (e) {
        console.error(`[Proxy] Erreur Autocomplete:`, e.message);
        return [];
    }
}

// --- LOGIQUE TAGS POPULAIRES ---
async function scrapePopularTags() {
    try {
        const { data } = await axios.get('https://archiveofourown.org/tags', AXIOS_CONFIG);
        const $ = cheerio.load(data);
        const tags = [];
        $('.cloud a').each((i, el) => tags.push($(el).text().trim()));
        return tags.slice(0, 50);
    } catch (e) {
        return [];
    }
}

// --- ROUTES API ---
app.get('/', (req, res) => res.send('AO3 Proxy Optimized - Online'));
app.get('/status', (req, res) => res.json({ status: 'online' }));

app.get('/search', async (req, res) => {
    const results = await scrapeSearch(req.query.q || "");
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
    const term = req.query.q;
    if (!term || term.length < 2) return res.json([]);
    const results = await getAutocomplete(term);
    res.json(results);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
