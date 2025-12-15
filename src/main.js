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

const DEFAULTS = Object.freeze({
    blockAssets: true,
    useSitemapFallback: true,
    sitemapLimit: 2000,
    maxConcurrency: 10,
});

const normalizeWhitespace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const extractLabeledValue = (label, key) => {
    const re = new RegExp(`${key}\\s*:\\s*([^,]+)`, 'i');
    const m = normalizeWhitespace(label).match(re);
    return m?.[1]?.trim() || null;
};

const parseListingLabel = (label) => {
    if (!label) return {};
    return {
        title: extractLabeledValue(label, 'Job'),
        company: extractLabeledValue(label, 'Employer') || extractLabeledValue(label, 'Company'),
        location: extractLabeledValue(label, 'Location'),
        salary: extractLabeledValue(label, 'Salary') || extractLabeledValue(label, 'Compensation'),
        job_type: extractLabeledValue(label, 'Job\\s*Type') || extractLabeledValue(label, 'Employment\\s*Type'),
    };
};

const cleanJobTitle = (rawTitle) => {
    const s = normalizeWhitespace(rawTitle);
    if (!s) return null;
    const jobLabelTitle = parseListingLabel(s).title;
    if (jobLabelTitle) return normalizeWhitespace(jobLabelTitle);
    const first = s.split(',')[0] ?? s;
    const cleaned = first.replace(/^job\s*:\s*/i, '').trim();
    return cleaned || null;
};

async function extractJobMetaFromDetailPage(page) {
    return page.evaluate(() => {
        const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
        const lines = document.body ? document.body.innerText.split('\n').map(norm).filter(Boolean) : [];
        const lower = (v) => norm(v).toLowerCase();

        const valueAfter = (keys) => {
            const keySet = new Set(keys.map((k) => k.toLowerCase()));
            for (let i = 0; i < lines.length - 1; i++) {
                if (keySet.has(lower(lines[i]))) return lines[i + 1] || null;
            }
            return null;
        };

        return {
            location: valueAfter(['location']),
            salary: valueAfter(['salary', 'compensation']),
            job_type: valueAfter(['job type', 'employment type']),
        };
    });
}

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
        startUrls,
        keyword = '',
        location = '',
        job_type = '',
        sort = 'published_on',
        results_wanted: resultsWantedRaw = 100,
        max_pages: maxPagesRaw = 20,
        collectDetails = true,
        proxyConfiguration,
    } = input;

    const RESULTS_WANTED = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 20;
    const maxConcurrency = DEFAULTS.maxConcurrency;
    const sitemapLimit = DEFAULTS.sitemapLimit;

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const requestQueue = await RequestQueue.open();

    const seenJobIds = new Set();
    let saved = 0;
    let listPagesProcessed = 0;
    let detailsProcessed = 0;

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

    const discoveryUsesListing =
        Boolean(String(keyword || '').trim()) || Boolean(String(location || '').trim()) || Boolean(String(job_type || '').trim());

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

    if (initial.length) {
        for (const u of initial) {
            const label = isJobDetailUrl(u) ? 'DETAIL' : 'LIST';
            await requestQueue.addRequest({ url: u, userData: { label, pageNo: 1 } });
        }
    } else if (discoveryUsesListing) {
        await enqueueListPage(1);
    } else {
        const proxyUrl = proxyConf ? (await proxyConf.newUrl()) : undefined;
        const sitemapUrls = await fetchJobUrlsFromSitemap({ limit: Math.min(sitemapLimit, RESULTS_WANTED), proxyUrl });
        for (const u of sitemapUrls) await enqueueDetail(u);
    }

    log.info(
        `Starting crawl: keyword="${keyword}" location="${location}" job_type="${job_type}" collectDetails=${collectDetails} results_wanted=${RESULTS_WANTED} max_pages=${MAX_PAGES}`,
    );

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

                if (!DEFAULTS.blockAssets) return;
                await page.route('**/*', async (route) => {
                    const type = route.request().resourceType();
                    if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return route.abort();
                    return route.continue();
                });
            },
        ],
        async requestHandler({ request, page, log: crawlerLog, session }) {
            const label = request.userData?.label || 'LIST';
            if (saved >= RESULTS_WANTED) return;

            if (label === 'LIST') {
                const pageNo = request.userData?.pageNo || 1;
                listPagesProcessed += 1;
                crawlerLog.debug(`LIST page ${pageNo}: ${request.url}`);

                await page.waitForLoadState('domcontentloaded');
                try {
                    await page.waitForSelector('a[href*=\"/joblist/\"]', { timeout: 10000 });
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
                        const aria = a.getAttribute('aria-label') || null;
                        const textTitle = (a.textContent || '').trim() || null;
                        out.push({ url: abs, aria, textTitle });
                    }
                    return out;
                });

                const unique = new Map();
                for (const j of jobs) {
                    const jobId = getJobIdFromUrl(j.url);
                    if (!jobId) continue;
                    if (!unique.has(jobId)) unique.set(jobId, { ...j, jobId });
                }
                const found = [...unique.values()].map((j) => {
                    const fromLabel = parseListingLabel(j.aria);
                    const titleCandidate = cleanJobTitle(fromLabel.title || j.textTitle || j.aria);
                    return {
                        ...j,
                        title: titleCandidate,
                        company: fromLabel.company || null,
                        location: fromLabel.location || null,
                        salary: fromLabel.salary || null,
                        job_type: fromLabel.job_type || null,
                    };
                });
                crawlerLog.debug(`Found ${found.length} job links on page ${pageNo}`);

                if (found.length === 0) {
                    const pageTitle = await page.title().catch(() => '');
                    const maybeBlocked = pageTitle === 'Behance' && (await page.content()).length < 80000;

                    if (DEFAULTS.useSitemapFallback && pageNo === 1) {
                        crawlerLog.warning('No jobs found on LIST page 1, switching to sitemap discovery.');
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
                        await enqueueDetail(j.url, {
                            title: j.title || null,
                            company: j.company || null,
                            location: j.location || null,
                            salary: j.salary || null,
                            job_type: j.job_type || null,
                        });
                    }
                } else {
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = found.slice(0, Math.max(0, remaining)).map((j) => ({
                        id: j.jobId,
                        title: j.title || null,
                        company: j.company || null,
                        location: j.location || null,
                        salary: j.salary || null,
                        job_type: j.job_type || null,
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
                        if (saved % 50 === 0 || saved >= RESULTS_WANTED) {
                            crawlerLog.info(`Saved ${saved} jobs`);
                        }
                    }
                }

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    await enqueueListPage(pageNo + 1);
                }
                return;
            }

            if (label === 'DETAIL') {
                const jobId = request.userData?.jobId ?? getJobIdFromUrl(request.url);
                detailsProcessed += 1;
                crawlerLog.debug(`DETAIL ${jobId ?? ''}: ${request.url}`);

                await page.waitForLoadState('domcontentloaded');
                await page.waitForSelector('h1, script[type=\"application/ld+json\"]', { timeout: 15000 }).catch(() => {});

                const item = {
                    id: jobId,
                    title: request.userData?.partial?.title ?? null,
                    company: request.userData?.partial?.company ?? null,
                    location: request.userData?.partial?.location ?? null,
                    salary: request.userData?.partial?.salary ?? null,
                    job_type: request.userData?.partial?.job_type ?? null,
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
                    item.title = cleanJobTitle((await page.locator('h1').first().textContent().catch(() => null))?.trim() || null);
                }

                if (!item.location || !item.salary || !item.job_type) {
                    const meta = await extractJobMetaFromDetailPage(page).catch(() => ({}));
                    item.location = item.location || meta.location || null;
                    item.salary = item.salary || meta.salary || null;
                    item.job_type = item.job_type || meta.job_type || null;
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
                    if (saved % 25 === 0 || saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Saved ${saved} jobs`);
                    }
                }
            }
        },
        failedRequestHandler({ request, log: crawlerLog }, error) {
            crawlerLog.error(`Request failed: ${request.url} (${error?.message ?? error})`);
        },
    });

    await crawler.run();
    log.info(
        `Scraping completed. Saved ${saved} job items. Processed list pages=${listPagesProcessed}, detail pages=${detailsProcessed}.`,
    );
}

try {
    await main();
} finally {
    await Actor.exit();
}
