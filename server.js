const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
// Cloud hosts assign a port dynamically, so we must use process.env.PORT
const PORT = process.env.PORT || 3000;

app.use(cors());

// Shared config for axios to look like a real browser
const AXIOS_CONFIG = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

// --- Helper: Scrape Search Results ---
async function scrapeSearch(query) {
    const url = `https://archiveofourown.org/works?utf8=%E2%9C%93&work_search%5Bquery%5D=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, AXIOS_CONFIG);
    const $ = cheerio.load(data);
    const results = [];

    $('.work.blurb').each((i, el) => {
        const titleElement = $(el).find('.heading a').first();
        const authorElement = $(el).find('.heading a[rel="author"]');
        
        const href = titleElement.attr('href');
        const id = href ? href.match(/\/works\/(\d+)/)?.[1] : null;

        if (id) {
            results.push({
                id,
                title: titleElement.text().trim(),
                author: authorElement.text().trim() || "Anonymous",
                fandom: $(el).find('.fandoms a').first().text().trim(),
                rating: $(el).find('.rating .text').text().trim(),
                relationships: $(el).find('.relationships a').map((_, a) => $(a).text().trim()).get(),
                tags: $(el).find('.freeforms a').map((_, a) => $(a).text().trim()).get(),
                summary: $(el).find('.summary blockquote').text().trim(),
                words: parseInt($(el).find('dd.words').text().replace(/,/g, '')) || 0,
                chapters: parseInt($(el).find('dd.chapters').text().split('/')[0]) || 1,
                updated: $(el).find('p.datetime').text().trim(),
                content: undefined
            });
        }
    });
    return results;
}

// --- Helper: Scrape Full Work ---
async function scrapeWork(id) {
    const url = `https://archiveofourown.org/works/${id}?view_full_work=true&view_adult=true`;
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
}

// --- API Endpoints ---
app.get('/', (req, res) => {
    res.send('AO3 Proxy is running. Use /search or /work/:id endpoints.');
});

app.get('/status', (req, res) => {
    res.json({ status: 'online', message: 'AO3 Proxy is operational' });
});

app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Query required' });
        const results = await scrapeSearch(query);
        res.json(results);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch search results' });
    }
});

app.get('/work/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const work = await scrapeWork(id);
        res.json(work);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch work' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});