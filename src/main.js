// Behance Jobs Scraper - fast JSON API-first implementation
import { Actor, log } from 'apify';
import { Dataset, HttpCrawler, RequestQueue } from 'crawlee';

await Actor.init();

const BEHANCE_CLIENT_ID = 'BehanceWebSusi1';
const MAX_CONCURRENT_REQS = 25;
const MAX_EMPTY_LIST_PAGES = 2;
const SORT_MAP = new Map([
    ['published_on', 'published_on'],
    ['relevance', 'relevance'],
]);

const normalizeWhitespace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normalizeLower = (s) => normalizeWhitespace(s).toLowerCase();

const getJobIdFromUrl = (u) => {
    const m = String(u).match(/\/joblist\/(\d+)/);
    return m?.[1] ?? null;
};

const unixToIso = (seconds) => {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
};

const buildJobsListApiUrl = ({ page, keyword, sort }) => {
    const u = new URL('https://www.behance.net/v2/jobs');
    u.searchParams.set('client_id', BEHANCE_CLIENT_ID);
    u.searchParams.set('page', String(page));
    if (keyword && String(keyword).trim()) u.searchParams.set('search', String(keyword).trim());
    if (sort && SORT_MAP.has(sort)) u.searchParams.set('sort', SORT_MAP.get(sort));
    return u.href;
};

const buildJobDetailApiUrl = (jobId) => {
    const u = new URL(`https://www.behance.net/v2/jobs/${jobId}`);
    u.searchParams.set('client_id', BEHANCE_CLIENT_ID);
    return u.href;
};

const matchesLocation = (job, locationInput) => {
    const wanted = normalizeLower(locationInput);
    if (!wanted) return true;

    const jobLocation = normalizeLower(job?.location);
    const city = normalizeLower(job?.location_city);
    const country = normalizeLower(job?.location_country);

    if (wanted === 'remote' || wanted.includes('remote')) {
        return Boolean(job?.allow_remote) || jobLocation.includes('anywhere') || jobLocation.includes('remote');
    }

    return jobLocation.includes(wanted) || city.includes(wanted) || country.includes(wanted);
};

const matchesJobType = (job, jobTypeInput) => {
    const wanted = normalizeLower(jobTypeInput);
    if (!wanted) return true;
    const t = normalizeLower(job?.type);
    return t.includes(wanted);
};

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        startUrls,
        keyword: keywordInput = '',
        location = '',
        job_type = '',
        sort: sortInput = 'published_on',
        results_wanted: resultsWantedRaw = 100,
        max_pages: maxPagesRaw = 20,
        collectDetails = true,
        proxyConfiguration,
    } = input;

    const keyword = normalizeWhitespace(keywordInput);
    const sort = SORT_MAP.has(sortInput) ? sortInput : 'published_on';
    const RESULTS_WANTED = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 20;

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const requestQueue = await RequestQueue.open();

    const seenJobIds = new Set();
    let saved = 0;
    let listPagesProcessed = 0;
    let detailsProcessed = 0;
    let consecutiveEmptyListPages = 0;
    let stopReason = null;

    const enqueueJobDetail = async (jobId, partial = {}) => {
        if (!jobId) return;
        const id = String(jobId);
        if (seenJobIds.has(id)) return;
        seenJobIds.add(id);
        await requestQueue.addRequest({
            url: buildJobDetailApiUrl(id),
            userData: { label: 'DETAIL', jobId: id, partial },
        });
    };

    const enqueueListPage = async (pageNo) => {
        await requestQueue.addRequest({
            url: buildJobsListApiUrl({ page: pageNo, keyword, sort }),
            userData: { label: 'LIST', pageNo },
        });
    };

    const createListRequestFromStartUrl = (startUrl) => {
        try {
            const parsed = new URL(startUrl);
            if (/\/v2\/jobs/i.test(parsed.pathname)) {
                parsed.searchParams.set('client_id', BEHANCE_CLIENT_ID);
                return { url: parsed.href, userData: { label: 'LIST', pageNo: Number(parsed.searchParams.get('page')) || 1 } };
            }

            if (/\/joblist/i.test(parsed.pathname)) {
                const startPage = Number(parsed.searchParams.get('page')) || 1;
                const startKeyword = parsed.searchParams.get('search') || keyword;
                const startSort = parsed.searchParams.get('sort') || sort;
                const apiUrl = buildJobsListApiUrl({ page: startPage, keyword: startKeyword, sort: startSort });
                return { url: apiUrl, userData: { label: 'LIST', pageNo: startPage } };
            }
        } catch {
            // ignore malformed URLs
        }
        return null;
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

    if (initial.length) {
        for (const u of initial) {
            const jobId = getJobIdFromUrl(u);
            if (jobId) {
                await enqueueJobDetail(jobId);
            } else {
                const converted = createListRequestFromStartUrl(u);
                if (converted) {
                    await requestQueue.addRequest(converted);
                } else {
                    await requestQueue.addRequest({ url: buildJobsListApiUrl({ page: 1, keyword, sort }), userData: { label: 'LIST', pageNo: 1 } });
                    log.warning(`Unsupported start URL format "${u}", falling back to standard search.`);
                }
            }
        }
    } else {
        await enqueueListPage(1);
    }

    log.info(
        `Starting crawl (API-first): keyword="${keyword}" location="${location}" job_type="${job_type}" collectDetails=${collectDetails} results_wanted=${RESULTS_WANTED} max_pages=${MAX_PAGES} sort=${sort}`,
    );

    const headers = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    const crawler = new HttpCrawler({
        requestQueue,
        proxyConfiguration: proxyConf,
        useSessionPool: true,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 60,
        maxConcurrency: MAX_CONCURRENT_REQS,
        autoscaledPoolOptions: { logIntervalSecs: 300 },
        statisticsOptions: { logIntervalSecs: 300 },
        async requestHandler({ request, sendRequest, log: crawlerLog, session }) {
            if (saved >= RESULTS_WANTED) {
                stopReason = stopReason || 'results_wanted_reached';
                return;
            }

            const label = request.userData?.label || 'LIST';
            const response = await sendRequest({
                headers,
                responseType: 'text',
            });
            const body = response?.body ?? '';
            const text = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '');

            if (label === 'LIST') {
                const pageNo = request.userData?.pageNo || 1;
                listPagesProcessed += 1;
                crawlerLog.debug(`LIST page ${pageNo}: ${request.url}`);

                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    session.markBad();
                    throw new Error('LIST response is not valid JSON');
                }

                const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
                const filtered = jobs.filter((j) => matchesLocation(j, location) && matchesJobType(j, job_type));

                crawlerLog.debug(`Found ${jobs.length} jobs (filtered=${filtered.length}) on page ${pageNo}`);

                if (collectDetails) {
                    const remainingToDiscover = RESULTS_WANTED - seenJobIds.size;
                    for (const j of filtered.slice(0, Math.max(0, remainingToDiscover))) {
                        await enqueueJobDetail(j.id, {
                            id: String(j.id),
                            title: normalizeWhitespace(j.title) || null,
                            company: normalizeWhitespace(j.company) || null,
                            location: normalizeWhitespace(j.location) || null,
                            job_type: normalizeWhitespace(j.type) || null,
                            url: j.url || null,
                            date_posted: unixToIso(j.posted_on),
                        });
                    }
                } else {
                    const remaining = RESULTS_WANTED - saved;
                    const toPush = filtered.slice(0, Math.max(0, remaining)).map((j) => ({
                        id: String(j.id),
                        title: normalizeWhitespace(j.title) || null,
                        company: normalizeWhitespace(j.company) || null,
                        location: normalizeWhitespace(j.location) || null,
                        salary: null,
                        job_type: normalizeWhitespace(j.type) || null,
                        date_posted: unixToIso(j.posted_on),
                        description_html: null,
                        description_text: null,
                        url: j.url || null,
                        scraped_at: new Date().toISOString(),
                        source: 'behance.net',
                    }));

                    if (toPush.length) {
                        await Dataset.pushData(toPush);
                        saved += toPush.length;
                        if (saved % 50 === 0 || saved >= RESULTS_WANTED) crawlerLog.info(`Saved ${saved} jobs`);
                    }
                }

                const progressCount = collectDetails ? seenJobIds.size : saved;
                if (filtered.length === 0) {
                    consecutiveEmptyListPages += 1;
                    if (consecutiveEmptyListPages >= MAX_EMPTY_LIST_PAGES) {
                        stopReason = 'empty_pages_limit';
                        crawlerLog.info('Stopping pagination due to repeated empty pages.');
                        return;
                    }
                } else {
                    consecutiveEmptyListPages = 0;
                }

                if (progressCount >= RESULTS_WANTED) {
                    stopReason = 'results_wanted_reached';
                    return;
                }

                if (pageNo >= MAX_PAGES) {
                    stopReason = 'max_pages_reached';
                    return;
                }

                if (jobs.length === 0) {
                    stopReason = stopReason || 'no_more_results';
                    return;
                }

                await enqueueListPage(pageNo + 1);
                return;
            }

            if (label === 'DETAIL') {
                detailsProcessed += 1;
                const jobId = request.userData?.jobId ?? null;
                crawlerLog.debug(`DETAIL ${jobId ?? ''}: ${request.url}`);

                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    session.markBad();
                    throw new Error('DETAIL response is not valid JSON');
                }

                const job = data?.job;
                if (!job || typeof job !== 'object') throw new Error('DETAIL response missing job');
                if (!matchesLocation(job, location) || !matchesJobType(job, job_type)) return;

                const item = {
                    id: String(job.id ?? request.userData?.partial?.id ?? ''),
                    title: normalizeWhitespace(job.title) || request.userData?.partial?.title || null,
                    company: normalizeWhitespace(job.company) || request.userData?.partial?.company || null,
                    location: normalizeWhitespace(job.location) || request.userData?.partial?.location || null,
                    salary: null,
                    job_type: normalizeWhitespace(job.type) || request.userData?.partial?.job_type || null,
                    date_posted: unixToIso(job.posted_on) || request.userData?.partial?.date_posted || null,
                    description_html: job.description || null,
                    description_text: job.description_plain || null,
                    url: job.url || request.userData?.partial?.url || null,
                    application_url: job.application_url || null,
                    external_url: job.external_url || null,
                    scraped_at: new Date().toISOString(),
                    source: 'behance.net',
                };

                if (!item.title) return;
                await Dataset.pushData(item);
                saved += 1;
                if (saved % 25 === 0 || saved >= RESULTS_WANTED) crawlerLog.info(`Saved ${saved} jobs`);
                if (saved >= RESULTS_WANTED) stopReason = 'results_wanted_reached';
            }
        },
        failedRequestHandler({ request, log: crawlerLog }, error) {
            crawlerLog.error(`Request failed: ${request.url} (${error?.message ?? error})`);
        },
    });

    await crawler.run();
    log.info(`Scraping completed. Saved ${saved} job items. Processed list pages=${listPagesProcessed}, detail pages=${detailsProcessed}. Stop reason: ${stopReason || 'finished'}.`);
}

try {
    await main();
} finally {
    await Actor.exit();
}
