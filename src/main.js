import { Actor, log } from 'apify';
import { Dataset, HttpCrawler, RequestQueue } from 'crawlee';
import { gotScraping } from 'got-scraping';
import cheerio from 'cheerio';
import { chromium } from 'playwright';

const BEHANCE_CLIENT_ID = 'BehanceWebSusi1';
const JSON_API_BASE = 'https://www.behance.net/v2/jobs';
const HTML_LIST_URL = 'https://www.behance.net/joblist';
const MAX_CONCURRENT_REQS = 20;
const REQUEST_TIMEOUT_MS = 35000;
const LIST_PAGE_SIZE = 50;
const MAX_EMPTY_JSON_PAGES = 3;

const LABELS = {
    JSON_LIST: 'JSON_LIST',
    JSON_DETAIL: 'JSON_DETAIL',
    HTML_LIST: 'HTML_LIST',
    HTML_DETAIL: 'HTML_DETAIL',
    PLAYWRIGHT_LIST: 'PLAYWRIGHT_LIST',
    PLAYWRIGHT_DETAIL: 'PLAYWRIGHT_DETAIL',
    SITEMAP: 'SITEMAP',
};

const SORT_MAP = new Map([
    ['published_on', 'published_on'],
    ['relevance', 'relevance'],
]);

const headerGeneratorOptions = {
    browsers: [
        { name: 'chrome', minVersion: 114 },
        { name: 'edge', minVersion: 113 },
    ],
    devices: ['desktop'],
    locales: ['en-US', 'en'],
};

const metrics = {
    requests: { total: 0, json: 0, html: 0, playwright: 0 },
    statuses: {},
    jsonListEmptyPages: 0,
    fallbacks: { htmlList: 0, htmlDetail: 0, playwrightList: 0, playwrightDetail: 0 },
    samples: [],
};

let requestQueue;
let baseFilters = { keyword: '', location: '', jobType: '', sort: 'published_on' };
let RESULTS_WANTED = 100;
let MAX_PAGES = 20;
let COLLECT_DETAILS = true;
let proxyConfiguration;

const seenJobIds = new Set();
const jsonListRequests = new Set();
const htmlListRequests = new Set();
const htmlDetailRequests = new Set();
const playwrightListRequests = new Set();
const playwrightDetailRequests = new Set();

let saved = 0;
let listPagesProcessed = 0;
let detailsProcessed = 0;
let consecutiveEmptyJsonPages = 0;
let stopReason = null;
let sharedCookieHeader = '';

const diagSamples = [];

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLower(value) {
    return normalizeWhitespace(value).toLowerCase();
}

function unixToIso(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
}

function getJobIdFromUrl(url) {
    const match = String(url ?? '').match(/\/joblist\/(\d+)/i);
    return match?.[1] ? String(match[1]) : null;
}

function matchesLocation(job, locationInput) {
    const wanted = normalizeLower(locationInput);
    if (!wanted) return true;

    const jobLocation = normalizeLower(job?.location);
    const city = normalizeLower(job?.location_city);
    const country = normalizeLower(job?.location_country);

    if (wanted === 'remote' || wanted.includes('remote')) {
        return Boolean(job?.allow_remote) || jobLocation.includes('anywhere') || jobLocation.includes('remote');
    }

    return jobLocation.includes(wanted) || city.includes(wanted) || country.includes(wanted);
}

function matchesJobType(job, jobTypeInput) {
    const wanted = normalizeLower(jobTypeInput);
    if (!wanted) return true;
    const type = normalizeLower(job?.type) || normalizeLower(job?.job_type);
    return type.includes(wanted);
}

function sanitizeNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
}

function buildFilterKey(filters = baseFilters) {
    return [
        filters.keyword || 'all',
        filters.location || 'all',
        filters.jobType || 'all',
        filters.sort || 'published_on',
    ]
        .map((part) => normalizeLower(part) || 'all')
        .join('|');
}

function buildJobsListApiUrl({ page, filters }) {
    const resolved = { ...baseFilters, ...(filters || {}) };
    const url = new URL(JSON_API_BASE);
    url.searchParams.set('client_id', BEHANCE_CLIENT_ID);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(LIST_PAGE_SIZE));
    if (resolved.keyword) url.searchParams.set('search', resolved.keyword);
    if (resolved.location) url.searchParams.set('location', resolved.location);
    if (resolved.jobType) url.searchParams.set('type', resolved.jobType);
    if (resolved.sort && SORT_MAP.has(resolved.sort)) url.searchParams.set('sort', SORT_MAP.get(resolved.sort));
    return url.href;
}

function buildHtmlListingUrl(page, filters) {
    const resolved = { ...baseFilters, ...(filters || {}) };
    const url = new URL(HTML_LIST_URL);
    if (page) url.searchParams.set('page', String(page));
    if (resolved.keyword) url.searchParams.set('search', resolved.keyword);
    if (resolved.location) url.searchParams.set('location', resolved.location);
    if (resolved.jobType) url.searchParams.set('type', resolved.jobType);
    if (resolved.sort) url.searchParams.set('sort', resolved.sort);
    return url.href;
}

function buildJobDetailApiUrl(jobId) {
    const url = new URL(`${JSON_API_BASE}/${jobId}`);
    url.searchParams.set('client_id', BEHANCE_CLIENT_ID);
    return url.href;
}

function buildJobPageUrl(jobId) {
    return jobId ? `https://www.behance.net/joblist/${jobId}` : HTML_LIST_URL;
}

function pushDiag(sample) {
    const entry = { ...sample, ts: new Date().toISOString() };
    diagSamples.push(entry);
    if (diagSamples.length > 50) diagSamples.shift();
}
function updateCookieHeader(setCookieHeader) {
    if (!setCookieHeader) return;
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const store = new Map(
        (sharedCookieHeader ? sharedCookieHeader.split(';') : [])
            .map((pair) => pair.trim())
            .filter(Boolean)
            .map((pair) => {
                const [name, ...valueParts] = pair.split('=');
                return [name.trim(), valueParts.join('=').trim()];
            }),
    );
    for (const entry of cookies) {
        const [cookiePair] = entry.split(';');
        if (!cookiePair) continue;
        const [rawName, ...rawValue] = cookiePair.split('=');
        if (!rawName || rawValue.length === 0) continue;
        store.set(rawName.trim(), rawValue.join('=').trim());
    }
    sharedCookieHeader = Array.from(store.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function createHeaders(type = 'json') {
    const headers =
        type === 'html'
            ? {
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                  'Cache-Control': 'no-cache',
              }
            : {
                  Accept: 'application/json, text/plain, */*',
                  'Cache-Control': 'no-cache',
              };
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    if (sharedCookieHeader) headers.Cookie = sharedCookieHeader;
    return headers;
}

function recordRequest(label, statusCode) {
    metrics.requests.total += 1;
    if (label.startsWith('HTML')) metrics.requests.html += 1;
    else if (label.startsWith('PLAYWRIGHT')) metrics.requests.playwright += 1;
    else metrics.requests.json += 1;
    if (typeof statusCode === 'number') {
        metrics.statuses[statusCode] = (metrics.statuses[statusCode] || 0) + 1;
    }
}

async function fetchWithHttp({ url, session, proxyInfo, expectJson, label, headersType = 'json' }) {
    try {
        const response = await gotScraping({
            url,
            responseType: 'text',
            timeout: { request: REQUEST_TIMEOUT_MS },
            throwHttpErrors: false,
            headerGeneratorOptions,
            headers: createHeaders(headersType),
            proxyUrl: proxyInfo?.url,
        });
        recordRequest(label, response.statusCode);
        const body = response.body ?? '';
        if (response.headers['set-cookie']) updateCookieHeader(response.headers['set-cookie']);
        let json = null;
        if (expectJson && body) {
            try {
                json = JSON.parse(body);
            } catch (error) {
                pushDiag({ label, url, statusCode: response.statusCode, note: `JSON parse failed: ${error.message}` });
            }
        }
        if (response.statusCode >= 400) {
            pushDiag({
                label,
                url,
                statusCode: response.statusCode,
                note: `Status ${response.statusCode} body sample: ${String(body).slice(0, 500)}`,
            });
        }
        return { statusCode: response.statusCode, body: typeof body === 'string' ? body : body.toString('utf-8'), json };
    } catch (error) {
        pushDiag({ label, url, statusCode: null, note: error.message });
        session?.markBad();
        throw error;
    }
}

function hasEnoughResults() {
    return saved >= RESULTS_WANTED;
}

async function pushDatasetItems(items) {
    if (!items.length) return;
    const remaining = RESULTS_WANTED - saved;
    if (remaining <= 0) return;
    const slice = items.slice(0, remaining);
    await Dataset.pushData(slice);
    saved += slice.length;
    if (saved >= RESULTS_WANTED) stopReason = stopReason || 'results_wanted_reached';
}

function buildPartialFromJob(job) {
    if (!job || typeof job !== 'object') return {};
    return {
        id: job.id ? String(job.id) : getJobIdFromUrl(job.url),
        title: normalizeWhitespace(job.title) || null,
        company: normalizeWhitespace(job.company) || null,
        location: normalizeWhitespace(job.location) || null,
        location_city: normalizeWhitespace(job.location_city) || null,
        location_country: normalizeWhitespace(job.location_country) || null,
        job_type: normalizeWhitespace(job.type) || null,
        url: job.url || null,
        allow_remote: Boolean(job.allow_remote),
        date_posted: unixToIso(job.posted_on),
        tags: Array.isArray(job.tags) ? job.tags : [],
        fields: Array.isArray(job.fields) ? job.fields : job.fields ? Object.values(job.fields) : [],
        categories: job.categories ? Object.values(job.categories) : [],
    };
}

function composeJobItem(job, partial = {}) {
    return {
        id: String(job?.id ?? partial.id ?? ''),
        title: normalizeWhitespace(job?.title) || partial.title || null,
        company: normalizeWhitespace(job?.company) || partial.company || null,
        location: normalizeWhitespace(job?.location) || partial.location || null,
        location_city: normalizeWhitespace(job?.location_city) || partial.location_city || null,
        location_country: normalizeWhitespace(job?.location_country) || partial.location_country || null,
        salary: partial.salary ?? job?.salary ?? null,
        job_type: normalizeWhitespace(job?.type) || partial.job_type || null,
        allow_remote: typeof job?.allow_remote === 'boolean' ? job.allow_remote : Boolean(partial.allow_remote),
        date_posted: unixToIso(job?.posted_on) || job?.date_posted || partial.date_posted || null,
        description_html: job?.description || job?.description_html || partial.description_html || null,
        description_text: job?.description_plain || job?.description_text || partial.description_text || null,
        application_url: job?.application_url || partial.application_url || null,
        external_url: job?.external_url || partial.external_url || null,
        tags: Array.isArray(job?.tags) ? job.tags : partial.tags || [],
        fields: Array.isArray(job?.fields) ? job.fields : partial.fields || [],
        categories: Array.isArray(job?.categories)
            ? job.categories
            : job?.categories && typeof job.categories === 'object'
              ? Object.values(job.categories)
              : partial.categories || [],
        url: job?.url || job?.permalink || partial.url || null,
        scraped_at: new Date().toISOString(),
        source: 'behance.net',
    };
}
async function enqueueJobDetail(jobId, partial = {}, filters = baseFilters, { force = false } = {}) {
    const normalized = jobId ? String(jobId) : null;
    if (!normalized) return;
    if (!force && !COLLECT_DETAILS) return;
    if (seenJobIds.has(normalized)) return;
    seenJobIds.add(normalized);
    await requestQueue.addRequest({
        url: buildJobDetailApiUrl(normalized),
        uniqueKey: `DETAIL_JSON_${normalized}_${buildFilterKey(filters)}`,
        userData: { label: LABELS.JSON_DETAIL, jobId: normalized, partial, filters },
    });
}

async function scheduleListPage(pageNo, filters = baseFilters) {
    if (pageNo > MAX_PAGES) return;
    const filterKey = buildFilterKey(filters);
    const uniqueKey = `JSON_LIST_${filterKey}_${pageNo}`;
    if (jsonListRequests.has(uniqueKey)) return;
    jsonListRequests.add(uniqueKey);
    await requestQueue.addRequest({
        url: buildJobsListApiUrl({ page: pageNo, filters }),
        uniqueKey,
        userData: { label: LABELS.JSON_LIST, pageNo, filters },
    });
}

async function scheduleHtmlList(pageNo, filters, reason) {
    const key = `HTML_LIST_${buildFilterKey(filters)}_${pageNo}`;
    if (htmlListRequests.has(key)) return;
    htmlListRequests.add(key);
    metrics.fallbacks.htmlList += 1;
    if (reason) log.debug(`Scheduling HTML list fallback page ${pageNo}: ${reason}`);
    await requestQueue.addRequest({
        url: buildHtmlListingUrl(pageNo, filters),
        uniqueKey: key,
        userData: { label: LABELS.HTML_LIST, pageNo, filters },
    });
}

async function scheduleHtmlDetail(jobId, partial, filters, reason) {
    const key = `HTML_DETAIL_${jobId}`;
    if (htmlDetailRequests.has(key)) return;
    htmlDetailRequests.add(key);
    metrics.fallbacks.htmlDetail += 1;
    if (reason) log.debug(`Scheduling HTML detail fallback for job ${jobId}: ${reason}`);
    const detailUrl = partial?.url || buildJobPageUrl(jobId);
    await requestQueue.addRequest({
        url: detailUrl,
        uniqueKey: key,
        userData: { label: LABELS.HTML_DETAIL, jobId, partial, filters, detailUrl },
    });
}

async function schedulePlaywrightList(pageNo, filters, reason) {
    const key = `PLAYWRIGHT_LIST_${buildFilterKey(filters)}_${pageNo}`;
    if (playwrightListRequests.has(key)) return;
    playwrightListRequests.add(key);
    metrics.fallbacks.playwrightList += 1;
    if (reason) log.debug(`Scheduling Playwright list fallback page ${pageNo}: ${reason}`);
    await requestQueue.addRequest({
        url: buildHtmlListingUrl(pageNo, filters),
        uniqueKey: key,
        userData: { label: LABELS.PLAYWRIGHT_LIST, pageNo, filters },
    });
}

async function schedulePlaywrightDetail(jobId, partial, filters, reason) {
    const key = `PLAYWRIGHT_DETAIL_${jobId}`;
    if (playwrightDetailRequests.has(key)) return;
    playwrightDetailRequests.add(key);
    metrics.fallbacks.playwrightDetail += 1;
    if (reason) log.debug(`Scheduling Playwright detail fallback for job ${jobId}: ${reason}`);
    const detailUrl = partial?.url || buildJobPageUrl(jobId);
    await requestQueue.addRequest({
        url: detailUrl,
        uniqueKey: key,
        userData: { label: LABELS.PLAYWRIGHT_DETAIL, jobId, partial, filters, detailUrl },
    });
}
function collectJobsFromObject(root) {
    const jobs = [];
    const stack = [root];
    const visited = new WeakSet();
    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);
        if (Array.isArray(current)) {
            for (const value of current) stack.push(value);
            continue;
        }
        if (Array.isArray(current.jobs)) jobs.push(...current.jobs);
        if (current.job && typeof current.job === 'object') jobs.push(current.job);
        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') stack.push(value);
        }
    }
    return jobs;
}

function tryParseScriptJson(content) {
    const trimmed = String(content ?? '').trim();
    if (!trimmed) return null;
    const patterns = [
        /^window\.__NUXT__\s*=\s*(\{[\s\S]+})\s*;?$/,
        /^window\.__NUXT_DATA__\s*=\s*(\{[\s\S]+})\s*;?$/,
        /^window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+})\s*;?$/,
        /^__NUXT_JSONP__\([^,]+,\s*(\{[\s\S]+})\s*\);?$/,
        /^window\.__NUXT_JSON__\s*=\s*(\{[\s\S]+})\s*;?$/,
    ];
    for (const pattern of patterns) {
        const match = trimmed.match(pattern);
        if (match) {
            const candidate = match[1]?.trim();
            if (!candidate) continue;
            try {
                return JSON.parse(candidate);
            } catch {
                continue;
            }
        }
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    }
    return null;
}

function isJsonLdJob(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const type = entry['@type'];
    if (Array.isArray(type)) return type.includes('JobPosting');
    return type === 'JobPosting';
}

function mapJsonLdJob(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const jobLocation = Array.isArray(entry.jobLocation) ? entry.jobLocation[0] : entry.jobLocation;
    const address = jobLocation?.address || jobLocation?.addressCountry || {};
    const locationParts = [address.addressLocality, address.addressRegion, address.addressCountry]
        .map((part) => normalizeWhitespace(part))
        .filter(Boolean);
    const salaryValue = entry.baseSalary?.value;
    let salary = null;
    if (salaryValue?.value) {
        salary = `${salaryValue.value}${salaryValue.currency ? ` ${salaryValue.currency}` : ''}`.trim();
    }
    return {
        id: entry.identifier || entry.url || entry['@id'] || null,
        title: entry.title || entry.name || null,
        company: entry.hiringOrganization?.name || null,
        location: locationParts.join(', '),
        location_city: address.addressLocality || null,
        location_country: address.addressCountry || null,
        description: entry.description || null,
        description_plain: entry.description || null,
        job_type: Array.isArray(entry.employmentType) ? entry.employmentType.join(', ') : entry.employmentType,
        application_url: entry.hiringOrganization?.sameAs || null,
        external_url: entry.url || entry.mainEntityOfPage || null,
        posted_on: entry.datePosted ? Date.parse(entry.datePosted) / 1000 : null,
        allow_remote: String(entry.jobLocationType || '').toLowerCase().includes('remote'),
        salary,
        url: entry.url || entry.mainEntityOfPage || null,
    };
}

function extractJobsFromHtml(html) {
    const $ = cheerio.load(html);
    const jobs = [];
    $('script').each((_, element) => {
        const parsed = tryParseScriptJson($(element).html());
        if (parsed) jobs.push(...collectJobsFromObject(parsed));
    });
    if (!jobs.length) {
        $('script[type="application/ld+json"]').each((_, element) => {
            const content = $(element).html();
            if (!content) return;
            try {
                const data = JSON.parse(content);
                const entries = Array.isArray(data) ? data : [data];
                entries.forEach((entry) => {
                    if (isJsonLdJob(entry)) {
                        const mapped = mapJsonLdJob(entry);
                        if (mapped) jobs.push(mapped);
                    }
                });
            } catch {
                // ignore
            }
        });
    }
    return jobs;
}

function extractJobFromHtml(html) {
    const jobs = extractJobsFromHtml(html);
    if (jobs.length) return jobs[0];
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text();
    const description = $('meta[property="og:description"]').attr('content') || $('body').text();
    const url = $('meta[property="og:url"]').attr('content') || $('link[rel="canonical"]').attr('href') || null;
    return {
        id: getJobIdFromUrl(url),
        title,
        description_html: description,
        description_text: normalizeWhitespace(description),
        url,
    };
}
async function captureJsonWithPlaywright(url, { expectDetail }) {
    recordRequest(expectDetail ? LABELS.PLAYWRIGHT_DETAIL : LABELS.PLAYWRIGHT_LIST, 0);
    const launchOptions = { headless: true, args: ['--disable-dev-shm-usage'] };
    if (proxyConfiguration) {
        const proxyUrl = await proxyConfiguration.newUrl();
        if (proxyUrl) launchOptions.proxy = { server: proxyUrl };
    }
    const browser = await chromium.launch(launchOptions);
    try {
        const context = await browser.newContext({
            userAgent: createHeaders('html')['User-Agent'],
            viewport: { width: 1280, height: 900 },
        });
        const page = await context.newPage();
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
            return route.continue();
        });
        let captured = null;
        page.on('response', async (response) => {
            const responseUrl = response.url();
            if (!responseUrl.includes('/v2/jobs')) return;
            try {
                const json = await response.json();
                if ((expectDetail && json?.job) || (!expectDetail && Array.isArray(json?.jobs))) {
                    captured = json;
                }
            } catch {
                // ignore
            }
        });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        if (!captured) await page.waitForTimeout(4000);
        const cookies = await context.cookies();
        if (cookies.length) {
            sharedCookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        }
        await context.close();
        if (!captured) throw new Error('Playwright did not capture Behance API payload');
        return captured;
    } finally {
        await browser.close();
    }
}

async function processJobsFromSource(jobs, filters, sourceLabel) {
    if (!Array.isArray(jobs) || !jobs.length) return;
    const filtered = jobs.filter((job) => matchesLocation(job, filters.location) && matchesJobType(job, filters.jobType));
    if (!filtered.length) {
        pushDiag({ label: sourceLabel, url: 'N/A', statusCode: 200, note: 'No jobs passed filters' });
        return;
    }
    if (COLLECT_DETAILS) {
        const remaining = RESULTS_WANTED - seenJobIds.size;
        if (remaining <= 0) return;
        for (const job of filtered) {
            if (seenJobIds.size >= RESULTS_WANTED) break;
            const jobId = job?.id ? String(job.id) : getJobIdFromUrl(job?.url);
            if (!jobId) continue;
            await enqueueJobDetail(jobId, buildPartialFromJob(job), filters);
        }
    } else {
        const items = filtered.map((job) => composeJobItem(job));
        await pushDatasetItems(items);
    }
}
async function handleJsonList(context) {
    const { request, session, proxyInfo } = context;
    const filters = request.userData?.filters || baseFilters;
    const pageNo = request.userData?.pageNo || 1;
    const response = await fetchWithHttp({
        url: request.url,
        session,
        proxyInfo,
        expectJson: true,
        label: LABELS.JSON_LIST,
    });
    if (!response) return;
    if (response.statusCode >= 500) {
        session?.markBad();
        throw new Error(`LIST ${pageNo} failed with status ${response.statusCode}`);
    }
    if (response.statusCode >= 400) {
        session?.markBad();
        await scheduleHtmlList(pageNo, filters, `status_${response.statusCode}`);
        throw new Error(`LIST ${pageNo} blocked with status ${response.statusCode}`);
    }
    const jobs = Array.isArray(response.json?.jobs) ? response.json.jobs : [];
    listPagesProcessed += 1;
    if (!jobs.length) {
        metrics.jsonListEmptyPages += 1;
        consecutiveEmptyJsonPages += 1;
        await scheduleHtmlList(pageNo, filters, 'empty_json');
        if (consecutiveEmptyJsonPages >= MAX_EMPTY_JSON_PAGES) {
            stopReason = stopReason || 'empty_json_pages';
            return;
        }
    } else {
        consecutiveEmptyJsonPages = 0;
    }
    await processJobsFromSource(jobs, filters, LABELS.JSON_LIST);
    if (hasEnoughResults()) return;
    if (jobs.length && pageNo < MAX_PAGES) await scheduleListPage(pageNo + 1, filters);
}

async function handleJsonDetail(context) {
    const { request, session, proxyInfo } = context;
    const jobId = request.userData?.jobId;
    const partial = request.userData?.partial || {};
    const response = await fetchWithHttp({
        url: request.url,
        session,
        proxyInfo,
        expectJson: true,
        label: LABELS.JSON_DETAIL,
    });
    if (!response) return;
    if (response.statusCode >= 500) {
        session?.markBad();
        throw new Error(`DETAIL ${jobId} failed with status ${response.statusCode}`);
    }
    if (response.statusCode >= 400) {
        session?.markBad();
        await scheduleHtmlDetail(jobId, partial, request.userData?.filters, `status_${response.statusCode}`);
        throw new Error(`DETAIL ${jobId} blocked with status ${response.statusCode}`);
    }
    const job = response.json?.job;
    if (!job) {
        await scheduleHtmlDetail(jobId, partial, request.userData?.filters, 'missing_job_payload');
        return;
    }
    if (!matchesLocation(job, baseFilters.location) || !matchesJobType(job, baseFilters.jobType)) return;
    await pushDatasetItems([composeJobItem(job, partial)]);
    detailsProcessed += 1;
}
async function handleHtmlList(context) {
    const { request, session, proxyInfo } = context;
    const filters = request.userData?.filters || baseFilters;
    const pageNo = request.userData?.pageNo || 1;
    const response = await fetchWithHttp({
        url: request.url,
        session,
        proxyInfo,
        expectJson: false,
        label: LABELS.HTML_LIST,
        headersType: 'html',
    });
    if (!response) return;
    if (response.statusCode >= 500) {
        session?.markBad();
        throw new Error(`HTML LIST ${pageNo} failed with status ${response.statusCode}`);
    }
    if (response.statusCode >= 400) {
        session?.markBad();
        await schedulePlaywrightList(pageNo, filters, `status_${response.statusCode}`);
        throw new Error(`HTML LIST ${pageNo} blocked with status ${response.statusCode}`);
    }
    const jobs = extractJobsFromHtml(response.body);
    if (!jobs.length) {
        await schedulePlaywrightList(pageNo, filters, 'html_parse_failed');
        return;
    }
    await processJobsFromSource(jobs, filters, LABELS.HTML_LIST);
}

async function handleHtmlDetail(context) {
    const { request, session, proxyInfo } = context;
    const jobId = request.userData?.jobId;
    const response = await fetchWithHttp({
        url: request.userData?.detailUrl || request.url,
        session,
        proxyInfo,
        expectJson: false,
        label: LABELS.HTML_DETAIL,
        headersType: 'html',
    });
    if (!response) return;
    if (response.statusCode >= 500) {
        session?.markBad();
        throw new Error(`HTML DETAIL ${jobId} failed with status ${response.statusCode}`);
    }
    if (response.statusCode >= 400) {
        session?.markBad();
        await schedulePlaywrightDetail(jobId, request.userData?.partial, request.userData?.filters, `status_${response.statusCode}`);
        throw new Error(`HTML DETAIL ${jobId} blocked with status ${response.statusCode}`);
    }
    const job = extractJobFromHtml(response.body);
    if (!job) {
        await schedulePlaywrightDetail(jobId, request.userData?.partial, request.userData?.filters, 'html_detail_parse_failed');
        return;
    }
    if (!job.id && jobId) job.id = jobId;
    await pushDatasetItems([composeJobItem(job, request.userData?.partial)]);
    detailsProcessed += 1;
}
async function handlePlaywrightList(context) {
    const { request } = context;
    const filters = request.userData?.filters || baseFilters;
    const payload = await captureJsonWithPlaywright(request.url, { expectDetail: false });
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    await processJobsFromSource(jobs, filters, LABELS.PLAYWRIGHT_LIST);
}

async function handlePlaywrightDetail(context) {
    const { request } = context;
    const jobId = request.userData?.jobId;
    const payload = await captureJsonWithPlaywright(request.userData?.detailUrl || request.url, { expectDetail: true });
    const job = payload?.job;
    if (!job) throw new Error(`Playwright detail missing payload for ${jobId}`);
    await pushDatasetItems([composeJobItem(job, request.userData?.partial)]);
    detailsProcessed += 1;
}

async function handleSitemap(context) {
    const { request, session, proxyInfo, log: crawlerLog } = context;
    const response = await fetchWithHttp({
        url: request.url,
        session,
        proxyInfo,
        expectJson: false,
        label: LABELS.SITEMAP,
        headersType: 'html',
    });
    if (!response) return;
    if (response.statusCode >= 400) throw new Error(`Sitemap fetch failed with status ${response.statusCode}`);
    const $ = cheerio.load(response.body, { xmlMode: true });
    const urls = [];
    $('loc').each((_, element) => {
        const text = $(element).text().trim();
        if (text && text.includes('/joblist/')) urls.push(text);
    });
    crawlerLog.info(`Discovered ${urls.length} URLs from sitemap ${request.url}`);
    for (const url of urls) {
        if (hasEnoughResults()) break;
        const jobId = getJobIdFromUrl(url);
        if (jobId) await enqueueJobDetail(jobId, { url }, baseFilters, { force: true });
    }
}
async function handleRequest(context) {
    const label = context.request.userData?.label || LABELS.JSON_LIST;
    switch (label) {
        case LABELS.JSON_LIST:
            return handleJsonList(context);
        case LABELS.JSON_DETAIL:
            return handleJsonDetail(context);
        case LABELS.HTML_LIST:
            return handleHtmlList(context);
        case LABELS.HTML_DETAIL:
            return handleHtmlDetail(context);
        case LABELS.PLAYWRIGHT_LIST:
            return handlePlaywrightList(context);
        case LABELS.PLAYWRIGHT_DETAIL:
            return handlePlaywrightDetail(context);
        case LABELS.SITEMAP:
            return handleSitemap(context);
        default:
            return handleJsonList(context);
    }
}

async function prepareStartRequests(startUrls = []) {
    const normalized = startUrls
        .map((source) => (typeof source === 'string' ? { url: source } : source))
        .filter((source) => source?.url);
    if (!normalized.length) {
        await scheduleListPage(1, baseFilters);
        return;
    }
    const requestList = await Actor.openRequestList('START_URLS', normalized);
    for (;;) {
        const req = await requestList.fetchNextRequest();
        if (!req) break;
        const trimmed = req.url.trim();
        if (!trimmed) continue;
        if (/\.xml($|\?)/i.test(trimmed) || /sitemap/i.test(trimmed)) {
            await requestQueue.addRequest({
                url: trimmed,
                uniqueKey: `SITEMAP_${trimmed}`,
                userData: { label: LABELS.SITEMAP },
            });
            continue;
        }
        const jobId = getJobIdFromUrl(trimmed);
        if (jobId) {
            await enqueueJobDetail(jobId, { url: trimmed }, baseFilters, { force: true });
            continue;
        }
        if (/\/v2\/jobs/i.test(trimmed)) {
            await requestQueue.addRequest({
                url: trimmed,
                uniqueKey: `CUSTOM_JSON_${trimmed}`,
                userData: { label: LABELS.JSON_LIST, pageNo: 1, filters: baseFilters },
            });
            continue;
        }
        if (/\/joblist/i.test(trimmed)) {
            try {
                const parsed = new URL(trimmed);
                const filters = {
                    keyword: parsed.searchParams.get('search') || baseFilters.keyword,
                    location: parsed.searchParams.get('location') || baseFilters.location,
                    jobType: parsed.searchParams.get('type') || parsed.searchParams.get('job_type') || baseFilters.jobType,
                    sort: parsed.searchParams.get('sort') || baseFilters.sort,
                };
                const pageNo = Number(parsed.searchParams.get('page')) || 1;
                await scheduleListPage(pageNo, filters);
            } catch {
                await scheduleListPage(1, baseFilters);
            }
            continue;
        }
        await scheduleListPage(1, baseFilters);
    }
    await requestList.persistState();
}

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls,
        keyword: keywordInput = '',
        location: locationInput = '',
        job_type: jobTypeInput = '',
        sort: sortInput = 'published_on',
        results_wanted: resultsWantedRaw = 100,
        max_pages: maxPagesRaw = 20,
        collectDetails: collectDetailsInput = true,
        proxyConfiguration: proxyInput,
    } = input;

    RESULTS_WANTED = sanitizeNumber(resultsWantedRaw, 100, { min: 1, max: 10000 });
    MAX_PAGES = sanitizeNumber(maxPagesRaw, 20, { min: 1, max: 100 });
    COLLECT_DETAILS = collectDetailsInput !== false;
    baseFilters = {
        keyword: normalizeWhitespace(keywordInput),
        location: normalizeWhitespace(locationInput),
        jobType: normalizeWhitespace(jobTypeInput),
        sort: SORT_MAP.has(sortInput) ? sortInput : 'published_on',
    };

    proxyConfiguration = proxyInput ? await Actor.createProxyConfiguration(proxyInput) : undefined;
    requestQueue = await RequestQueue.open();

    log.info(
        `Starting Behance jobs crawl keyword="${baseFilters.keyword}" location="${baseFilters.location}" job_type="${baseFilters.jobType}" sort="${baseFilters.sort}" results=${RESULTS_WANTED} collectDetails=${COLLECT_DETAILS} max_pages=${MAX_PAGES}`,
    );

    await prepareStartRequests(Array.isArray(startUrls) ? startUrls : []);

    const crawler = new HttpCrawler({
        requestQueue,
        maxConcurrency: MAX_CONCURRENT_REQS,
        requestHandlerTimeoutSecs: 90,
        maxRequestRetries: 2,
        useSessionPool: true,
        proxyConfiguration,
        async requestHandler(context) {
            if (hasEnoughResults()) return;
            await handleRequest(context);
        },
        failedRequestHandler({ request, error, log: crawlerLog }) {
            crawlerLog.error(`Request failed ${request.url}: ${error?.message || error}`);
        },
    });

    await crawler.run();

    await Actor.setValue('RUN_STATS', {
        saved,
        listPagesProcessed,
        detailsProcessed,
        stopReason: stopReason || 'finished',
        metrics: { ...metrics, diagnostics: diagSamples },
    });

    log.info(
        `Scraping completed. Saved ${saved} jobs. Processed list pages=${listPagesProcessed} detail pages=${detailsProcessed}. Stop reason=${stopReason || 'finished'}.`,
    );
}

try {
    await Actor.init();
    await main();
} finally {
    await Actor.exit();
}
