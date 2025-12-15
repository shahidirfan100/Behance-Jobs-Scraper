// Behance Jobs Scraper - fast JSON API-first implementation
import { Actor, log } from 'apify';
import { Dataset, HttpCrawler, RequestQueue } from 'crawlee';

await Actor.init();

const BEHANCE_CLIENT_ID = 'BehanceWebSusi1';

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

const buildJobsListApiUrl = ({ page, keyword }) => {
    const u = new URL('https://www.behance.net/v2/jobs');
    u.searchParams.set('client_id', BEHANCE_CLIENT_ID);
    u.searchParams.set('page', String(page));
    if (keyword && String(keyword).trim()) u.searchParams.set('search', String(keyword).trim());
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

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
    const requestQueue = await RequestQueue.open();

    const seenJobIds = new Set();
    let saved = 0;
    let listPagesProcessed = 0;
    let detailsProcessed = 0;

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
            url: buildJobsListApiUrl({ page: pageNo, keyword }),
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

    if (initial.length) {
        for (const u of initial) {
            const jobId = getJobIdFromUrl(u);
            if (jobId) {
                await enqueueJobDetail(jobId);
            } else {
                await requestQueue.addRequest({ url: u, userData: { label: 'LIST', pageNo: 1 } });
            }
        }
    } else {
        await enqueueListPage(1);
    }

    log.info(
        `Starting crawl (API-first): keyword="${keyword}" location="${location}" job_type="${job_type}" collectDetails=${collectDetails} results_wanted=${RESULTS_WANTED} max_pages=${MAX_PAGES} sort=${sort}`,
    );

    const crawler = new HttpCrawler({
        requestQueue,
        proxyConfiguration: proxyConf,
        useSessionPool: true,
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 60,
        maxConcurrency: 25,
        autoscaledPoolOptions: { logIntervalSecs: 300 },
        statisticsOptions: { logIntervalSecs: 300 },
        async requestHandler({ request, body, log: crawlerLog, session }) {
            if (saved >= RESULTS_WANTED) return;

            const label = request.userData?.label || 'LIST';
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
                if (progressCount < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    await enqueueListPage(pageNo + 1);
                }
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

