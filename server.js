const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// 1. Config to look like a real browser
const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://archiveofourown.org/'
    }
};

// --- Helper: Scrape Search Results ---
async function scrapeSearch(fullQuery) {
    console.log(`[Proxy] Raw Query: ${fullQuery}`);
    
    // 2. SMART PARSING: Extract "cheat codes" from the query string
    // The frontend sends "harry potter sort:kudos", but AO3 needs specific params.
    
    let sortColumn = '_score'; // Default: Best Match
    let sortDirection = 'desc';
    let cleanQuery = fullQuery;

    // Detect Sort
    if (cleanQuery.includes('sort:kudos')) {
        sortColumn = 'kudos_count';
        cleanQuery = cleanQuery.replace('sort:kudos', '');
    } else if (cleanQuery.includes('sort:hits')) {
        sortColumn = 'hits';
        cleanQuery = cleanQuery.replace('sort:hits', '');
    } else if (cleanQuery.includes('sort:date')) {
        sortColumn = 'revised_at';
        cleanQuery = cleanQuery.replace('sort:date', '');
    }

    // Clean up extra spaces left after removing sort tags
    cleanQuery = cleanQuery.trim();

    // 3. Construct the Advanced Search URL
    // We use the endpoint from your example: /works/search
    const params = new URLSearchParams();
    params.append('commit', 'Search');
    params.append('work_search[query]', cleanQuery);
    params.append('work_search[sort_column]', sortColumn);
    params.append('work_search[sort_direction]', sortDirection);
    
    // Note: 'rating:Explicit' and 'complete:true' work fine inside [query] 
    // on this endpoint, so we don't need to strip them out.

    const url = `https://archiveofourown.org/works/search?${params.toString()}`;
    console.log(`[Proxy] Target URL: ${url}`);

    try {
        const response = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(response.data);
        const results = [];

        $('.work.blurb').each((i, el) => {
            const titleElement = $(el).find('.heading a').first();
            const authorElement = $(el).find('.heading a[rel="author"]');
            
            // Extract ID
            const href = titleElement.attr('href');
            const id = href ? href.match(/\/works\/(\d+)/)?.[1] : null;

            if (id) {
                // Parse stats safely
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
        
        console.log(`[Proxy] Found ${results.length} results`);
        return results;

    } catch (err) {
        console.error("[Proxy] AO3 Request Failed:", err.message);
        return [];
    }
}

// --- Helper: Scrape Full Work ---
async function scrapeWork(id) {
    console.log(`[Proxy] Fetching work ID: ${id}`);
    const url = `https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`;
    
    try {
        const { data } = await axios.get(url, AXIOS_CONFIG);
        const $ = cheerio.load(data);

        const title = $('.title.heading').text().trim();
        const author = $('a[rel="author"]').text().trim();
        
        let content = [];
        if ($('#chapters').length) {
            $('#chapters .userstuff').each((i, el) => {
                content.push($(el).html());
            });
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
        console.error("[Proxy] Work Fetch Failed:", err.message);
        return { error: "Failed to load work" };
    }
}

// --- API Endpoints ---
app.get('/', (req, res) => res.send('AO3 Proxy Online'));

app.get('/status', (req, res) => res.json({ status: 'online' }));

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query || !query.trim()) return res.json([]); 
    
    const results = await scrapeSearch(query);
    res.json(results);
});

app.get('/work/:id', async (req, res) => {
    const work = await scrapeWork(req.params.id);
    res.json(work);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
