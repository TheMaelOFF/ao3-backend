const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://archiveofourown.org/'
    }
};

// --- Helper: Scrape Search Results ---
async function scrapeSearch(fullQuery) {
    console.log(`[Proxy] Search Query: ${fullQuery}`);
    
    let sortColumn = '_score'; 
    let sortDirection = 'desc';
    let ratingId = null;
    let isComplete = null;
    let cleanQuery = fullQuery;

    // 1. Extract Sort
    if (cleanQuery.includes('sort:kudos')) { sortColumn = 'kudos_count'; cleanQuery = cleanQuery.replace('sort:kudos', ''); }
    else if (cleanQuery.includes('sort:hits')) { sortColumn = 'hits'; cleanQuery = cleanQuery.replace('sort:hits', ''); }
    else if (cleanQuery.includes('sort:date')) { sortColumn = 'revised_at'; cleanQuery = cleanQuery.replace('sort:date', ''); }

    // 2. Extract Rating
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

    // 3. Extract Complete
    if (cleanQuery.includes('complete:true')) {
        isComplete = 'T';
        cleanQuery = cleanQuery.replace('complete:true', '');
    }

    cleanQuery = cleanQuery.trim();

    const params = new URLSearchParams();
    params.append('commit', 'Search');
    params.append('work_search[query]', cleanQuery);
    params.append('work_search[sort_column]', sortColumn);
    params.append('work_search[sort_direction]', sortDirection);
    if (ratingId) params.append('work_search[rating_ids]', ratingId);
    if (isComplete) params.append('work_search[complete]', isComplete);

    const url = `https://archiveofourown.org/works/search?${params.toString()}`;

    try {
        const response = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(response.data);
        const results = [];

        $('.work.blurb').each((i, el) => {
            const titleElement = $(el).find('.heading a').first();
            const authorElement = $(el).find('.heading a[rel="author"]');
            const href = titleElement.attr('href');
            const id = href ? href.match(/\/works\/(\d+)/)?.[1] : null;

            if (id) {
                const wordsTxt = $(el).find('dd.words').text().replace(/,/g, '');
                const chaptersTxt = $(el).find('dd.chapters').text().split('/')[0];
                const ratingText = $(el).find('.rating .text').text().trim();

                results.push({
                    id,
                    title: titleElement.text().trim(),
                    author: authorElement.text().trim() || "Anonymous",
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
        console.error("[Proxy] Search Failed:", err.message);
        return [];
    }
}

// --- Helper: Scrape Full Work ---
async function scrapeWork(id) {
    const url = `https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`;
    try {
        const { data } = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(data);
        const title = $('.title.heading').text().trim();
        const author = $('a[rel="author"]').text().trim();
        
        let content = [];
        if ($('#chapters').length) {
            $('#chapters .userstuff').each((i, el) => content.push($(el).html()));
        } else {
            content.push($('.userstuff').html());
        }

        return {
            id,
            title,
            author,
            content: content.filter(Boolean),
            chapters: content.length
        };
    } catch (err) {
        return { error: "Failed to load work" };
    }
}

// --- Helper: Scrape Popular Tags ---
async function scrapePopularTags() {
    try {
        const { data } = await axios.get('https://archiveofourown.org/tags', AXIOS_CONFIG);
        const $ = cheerio.load(data);
        const tags = [];
        // AO3 Tag Cloud
        $('.cloud a').each((i, el) => {
            tags.push($(el).text().trim());
        });
        // Return top 50 to keep it light
        return tags.slice(0, 50);
    } catch (e) {
        console.error("[Proxy] Tag Cloud Failed");
        return [];
    }
}

// --- API Endpoints ---
app.get('/', (req, res) => res.send('AO3 Proxy Online'));
app.get('/status', (req, res) => res.json({ status: 'online' }));

app.get('/search', async (req, res) => {
    const results = await scrapeSearch(req.query.q || "");
    res.json(results);
});

app.get('/work/:id', async (req, res) => {
    const work = await scrapeWork(req.params.id);
    res.json(work);
});

// NEW: Get Popular Tags (for startup)
app.get('/tags', async (req, res) => {
    const tags = await scrapePopularTags();
    res.json(tags);
});

// NEW: Real Autocomplete (Proxies AO3's internal API)
app.get('/autocomplete', async (req, res) => {
    const term = req.query.q;
    if (!term) return res.json([]);
    try {
        // AO3 internal autocomplete endpoint
        const url = `https://archiveofourown.org/autocomplete/tag?term=${encodeURIComponent(term)}`;
        const { data } = await axios.get(url, AXIOS_CONFIG);
        // Data comes back as [{ id: "tag name", name: "tag name" }, ...]
        res.json(data);
    } catch (e) {
        console.error("[Proxy] Autocomplete Failed");
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
