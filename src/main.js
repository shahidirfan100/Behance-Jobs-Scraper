// Behance Jobs Scraper - production-ready browser-based extraction
import { Actor, log } from 'apify';
import { Dataset, PlaywrightCrawler, RequestQueue } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

await Actor.init();

const cleanText = (html) => {
    if (!html) return '';
    const $ = cheerioLoad(html);
    $('script, style, noscript, iframe').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

const isJobDetailUrl = (u) => /\/joblist\/\d+/.test(String(u));
const getJobIdFromUrl = (u) => {
    const m = String(u).match(/\/joblist\/(\d+)/);
    return m?.[1] ?? null;
};

const buildListUrl = (page = 1, kw = '', loc = '', jType = '', sortBy = 'published_on') => {
    const u = new URL('https://www.behance.net/joblist');
    u.searchParams.set('page', String(page));
    if (kw) u.searchParams.set('search', String(kw).trim());
    if (loc) u.searchParams.set('location', String(loc).trim());
    if (jType) u.searchParams.set('job_type', String(jType).trim());
    if (sortBy) u.searchParams.set('sort', sortBy);
    return u.href;
};

async function fetchJobUrlsFromSitemap({ limit, proxyUrl }) {
    const res = await gotScraping({
        url: 'https://www.behance.net/sitemap/jobs',
        proxyUrl,
        responseType: 'text',
        headers: {
            Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
    });

    const xml = res.body || '';
    const urls = [];
    const re = /<loc>([^<]+)<\/loc>/g;
    for (let m; (m = re.exec(xml));) {
        const loc = m[1]?.trim();
        if (loc && isJobDetailUrl(loc)) urls.push(loc);
        if (urls.length >= limit) break;
    }
    return urls;
}

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        keyword = '',
        location = '',
        job_type = '',
        sort = 'published_on',
        results_wanted: resultsWantedRaw = 100,
        max_pages: maxPagesRaw = 20,
        collectDetails = true,
        startUrl,
        startUrls,
        url,
        mode: modeRaw = 'auto',
        useSitemapFallback = true,
        sitemapLimit: sitemapLimitRaw = 2000,
        blockAssets = true,
        maxConcurrency: maxConcurrencyRaw = 10,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 20;
    const maxConcurrency = Number.isFinite(+maxConcurrencyRaw) ? Math.max(1, +maxConcurrencyRaw) : 10;
    const sitemapLimit = Number.isFinite(+sitemapLimitRaw) ? Math.max(1, +sitemapLimitRaw) : 2000;
    const mode = String(modeRaw || 'auto').toLowerCase();

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const requestQueue = await RequestQueue.open();

    const seenJobIds = new Set();
    let saved = 0;

    const enqueueDetail = async (jobUrl, partial = {}) => {
        if (!jobUrl || saved >= RESULTS_WANTED) return;
        const jobId = getJobIdFromUrl(jobUrl);
        if (jobId && seenJobIds.has(jobId)) return;
        if (jobId) seenJobIds.add(jobId);
        await requestQueue.addRequest({
            url: jobUrl,
            userData: { label: 'DETAIL', jobId, partial },
        });
    };

    const enqueueListPage = async (pageNo) => {
        await requestQueue.addRequest({
            url: buildListUrl(pageNo, keyword, location, job_type, sort),
            userData: { label: 'LIST', pageNo },
        });
    };

    const initial = [];
    if (Array.isArray(startUrls) && startUrls.length) {
        const sources = startUrls.map((s) => (typeof s === 'string' ? { url: s } : s)).filter(Boolean);
        const requestList = await Actor.openRequestList('START_URLS', sources);
        for (;;) {
            const req = await requestList.fetchNextRequest();
            if (!req) break;
            initial.push(req.url);
        }
        await requestList.persistState();
    }
    if (startUrl) initial.push(startUrl);
    if (url) initial.push(url);

    if (initial.length) {
        for (const u of initial) {
            const label = isJobDetailUrl(u) ? 'DETAIL' : 'LIST';
            await requestQueue.addRequest({ url: u, userData: { label, pageNo: 1 } });
        }
    } else if (mode === 'sitemap') {
        const proxyUrl = proxyConf ? (await proxyConf.newUrl()) : undefined;
        const sitemapUrls = await fetchJobUrlsFromSitemap({ limit: Math.min(sitemapLimit, RESULTS_WANTED), proxyUrl });
        for (const u of sitemapUrls) await enqueueDetail(u);
    } else {
        await enqueueListPage(1);
    }

    const crawler = new PlaywrightCrawler({
        requestQueue,
        proxyConfiguration: proxyConf,
        useSessionPool: true,
        persistCookiesPerSession: true,
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 120,
        maxConcurrency,
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Upgrade-Insecure-Requests': '1',
                });

                if (!blockAssets) return;
                await page.route('**/*', async (route) => {
                    const type = route.request().resourceType();
                    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
                    return route.continue();
                });
            },
        ],
        async requestHandler({ request, page, log: crawlerLog, session }) {
            const label = request.userData?.label || 'LIST';
            if (saved >= RESULTS_WANTED) return;

            if (label === 'LIST') {
                const pageNo = request.userData?.pageNo || 1;
                crawlerLog.info(`LIST page ${pageNo}: ${request.url}`);

                await page.waitForLoadState('domcontentloaded');
                try {
                    await page.waitForSelector('a[href*=\"/joblist/\"]', { timeout: 25000 });
                } catch {
                    // ignore - we will still attempt extraction and potentially trigger sitemap fallback
                }

                const jobs = await page.$$eval('a[href]', (anchors) => {
                    const out = [];
                    for (const a of anchors) {
                        const href = a.getAttribute('href') || '';
                        if (!href.includes('/joblist/')) continue;
                        const abs = new URL(href, location.origin).href;
                        if (!/\/joblist\/\d+/.test(abs)) continue;
                        const title = (a.textContent || '').trim() || a.getAttribute('aria-label') || null;
                        out.push({ url: abs, title });
                    }
                    return out;
                });

                const unique = new Map();
                for (const j of jobs) {
                    const jobId = getJobIdFromUrl(j.url);
                    if (!jobId) continue;
                    if (!unique.has(jobId)) unique.set(jobId, { ...j, jobId });
                }
                const found = [...unique.values()];
                crawlerLog.info(`Found ${found.length} job links on page ${pageNo}`);

                if (found.length === 0) {
                    const pageTitle = await page.title().catch(() => '');
                    const maybeBlocked = pageTitle === 'Behance' && (await page.content()).length < 80000;

                    if (useSitemapFallback && pageNo === 1) {
                        crawlerLog.warning('No jobs found on LIST page 1, falling back to sitemap discovery.');
                        const proxyUrl = proxyConf ? (await proxyConf.newUrl()) : undefined;
                        const sitemapUrls = await fetchJobUrlsFromSitemap({
                            limit: Math.min(sitemapLimit, RESULTS_WANTED),
                            proxyUrl,
                        });
                        for (const u of sitemapUrls) await enqueueDetail(u);
                        return;
                    }

                    if (maybeBlocked) {
                        session.markBad();
                        throw new Error('Likely blocked on LIST page (no job links rendered).');
                    }
                    return;
                }

                if (collectDetails) {
                    const remaining = RESULTS_WANTED - saved;
                    for (const j of found.slice(0, Math.max(0, remaining))) {
                        await enqueueDetail(j.url, { title: j.title || null });
                    }
                } else {
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = found.slice(0, Math.max(0, remaining)).map((j) => ({
                        id: j.jobId,
                        title: j.title || null,
                        company: null,
                        location: null,
                        salary: null,
                        job_type: null,
                        date_posted: null,
                        description_html: null,
                        description_text: null,
                        url: j.url,
                        scraped_at: new Date().toISOString(),
                        source: 'behance.net',
                    }));

                    if (toPush.length) {
                        await Dataset.pushData(toPush);
                        saved += toPush.length;
                        crawlerLog.info(`Saved ${toPush.length} jobs (total: ${saved})`);
                    }
                }

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && mode !== 'sitemap') {
                    await enqueueListPage(pageNo + 1);
                }
                return;
            }

            if (label === 'DETAIL') {
                const jobId = request.userData?.jobId ?? getJobIdFromUrl(request.url);
                crawlerLog.info(`DETAIL ${jobId ?? ''}: ${request.url}`);

                await page.waitForLoadState('domcontentloaded');

                const item = {
                    id: jobId,
                    title: request.userData?.partial?.title ?? null,
                    company: null,
                    location: null,
                    salary: null,
                    job_type: null,
                    date_posted: null,
                    description_html: null,
                    description_text: null,
                    url: request.url,
                    scraped_at: new Date().toISOString(),
                    source: 'behance.net',
                };

                const ldJsonTexts = await page.$$eval('script[type=\"application/ld+json\"]', (els) =>
                    els.map((e) => e.textContent).filter(Boolean),
                );

                for (const raw of ldJsonTexts) {
                    try {
                        const parsed = JSON.parse(raw);
                        const candidates = Array.isArray(parsed) ? parsed : [parsed];
                        const jobPosting = candidates.find((c) => {
                            if (!c) return false;
                            const t = c['@type'];
                            return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                        });
                        if (!jobPosting) continue;

                        item.title = item.title || jobPosting.title || null;
                        item.company = jobPosting.hiringOrganization?.name || null;
                        item.date_posted = jobPosting.datePosted || null;
                        item.job_type = jobPosting.employmentType || null;
                        item.description_html = jobPosting.description || null;
                        item.description_text = cleanText(item.description_html);

                        const loc = jobPosting.jobLocation;
                        const locObj = Array.isArray(loc) ? loc[0] : loc;
                        const addr = locObj?.address;
                        if (typeof addr === 'string') item.location = addr;
                        if (addr?.addressLocality || addr?.addressRegion || addr?.addressCountry) {
                            item.location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ') || null;
                        }
                        break;
                    } catch {
                        // ignore invalid JSON-LD
                    }
                }

                if (!item.title) {
                    item.title = (await page.locator('h1').first().textContent().catch(() => null))?.trim() || null;
                }

                if (!item.description_html) {
                    const descHandle = page.locator('[class*=\"description\"], [class*=\"Description\"], .job-description, [class*=\"JobDescription\"]');
                    const descHtml = await descHandle.first().innerHTML().catch(() => null);
                    if (descHtml) {
                        item.description_html = descHtml.trim();
                        item.description_text = cleanText(item.description_html);
                    }
                }

                const pageTitle = await page.title().catch(() => '');
                const likelyBlocked = (!item.title && pageTitle === 'Behance');
                if (likelyBlocked) {
                    session.markBad();
                    throw new Error('Likely blocked on DETAIL page (no job data rendered).');
                }

                if (item.title) {
                    await Dataset.pushData(item);
                    saved += 1;
                }
            }
        },
        failedRequestHandler({ request, log: crawlerLog }, error) {
            crawlerLog.error(`Request failed: ${request.url} (${error?.message ?? error})`);
        },
    });

    await crawler.run();
    log.info(`Scraping completed. Saved ${saved} job items.`);
}

try {
    await main();
} finally {
    await Actor.exit();
}
