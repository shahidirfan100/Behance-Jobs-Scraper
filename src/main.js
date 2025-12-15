// Behance Jobs Scraper - Hybrid API + HTML implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            job_type = '',
            sort = 'published_on',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 20,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

        const toAbs = (href, base = 'https://www.behance.net') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildApiUrl = (page = 1, kw = '', loc = '', jType = '', sortBy = 'published_on') => {
            const u = new URL('https://www.behance.net/joblist');
            u.searchParams.set('page', String(page));
            if (kw) u.searchParams.set('search', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            if (jType) u.searchParams.set('job_type', String(jType).trim());
            if (sortBy) u.searchParams.set('sort', sortBy);
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildApiUrl(1, keyword, location, job_type, sort));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        let currentPage = 1;

        // Try JSON API first, fallback to HTML parsing
        async function fetchBehanceJobsJson(page, kw, loc, jType, sortBy, proxyUrl) {
            try {
                const apiUrl = `https://www.behance.net/joblist`;
                const params = new URLSearchParams();
                params.set('page', String(page));
                if (kw) params.set('search', kw);
                if (loc) params.set('location', loc);
                if (jType) params.set('job_type', jType);
                if (sortBy) params.set('sort', sortBy);

                const response = await gotScraping({
                    url: `${apiUrl}?${params.toString()}`,
                    proxyUrl,
                    responseType: 'text',
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                return response.body;
            } catch (err) {
                log.warning(`JSON API fetch failed for page ${page}: ${err.message}`);
                return null;
            }
        }

        function extractJobsFromHtml($, base) {
            const jobs = [];
            
            // Try extracting from job cards - Behance uses various selectors
            const jobCards = $('[class*="JobCard"], [class*="job-card"], .job-item, [data-job-id]').toArray();
            
            jobCards.forEach(card => {
                const $card = $(card);
                const jobUrl = $card.find('a[href*="/joblist/"]').first().attr('href') || 
                              $card.find('a[href*="/job/"]').first().attr('href');
                
                if (jobUrl) {
                    jobs.push({
                        url: toAbs(jobUrl, base),
                        title: $card.find('[class*="title"], h2, h3').first().text().trim() || null,
                        company: $card.find('[class*="company"], [class*="employer"]').first().text().trim() || null,
                        location: $card.find('[class*="location"]').first().text().trim() || null,
                        job_type: $card.find('[class*="job-type"], [class*="employment"]').first().text().trim() || null,
                        salary: $card.find('[class*="salary"], [class*="compensation"]').first().text().trim() || null,
                    });
                }
            });

            // Fallback: extract all job links
            if (jobs.length === 0) {
                $('a[href]').each((_, a) => {
                    const href = $(a).attr('href');
                    if (href && (/\/joblist\//i.test(href) || /\/job\//i.test(href))) {
                        const abs = toAbs(href, base);
                        if (abs && !jobs.find(j => j.url === abs)) {
                            jobs.push({ url: abs });
                        }
                    }
                });
            }

            return jobs;
        }

        function findNextPage($, currentPageNum) {
            // Look for pagination links
            const nextLink = $('a[rel="next"]').attr('href') || 
                           $('a:contains("Next")').attr('href') ||
                           $('a:contains("›")').attr('href');
            
            if (nextLink) return nextLink;
            
            // Try to find next page number
            const nextPageLink = $(`a:contains("${currentPageNum + 1}")`).attr('href');
            if (nextPageLink) return nextPageLink;
            
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    crawlerLog.info(`Processing LIST page ${pageNo}: ${request.url}`);

                    // Extract jobs from HTML
                    const jobs = extractJobsFromHtml($, request.url);
                    crawlerLog.info(`Found ${jobs.length} job listings on page ${pageNo}`);

                    if (jobs.length === 0) {
                        crawlerLog.warning(`No jobs found on page ${pageNo}. Stopping pagination.`);
                        return;
                    }

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = jobs.slice(0, Math.max(0, remaining));
                        const urls = toEnqueue.map(j => j.url).filter(Boolean);
                        
                        if (urls.length) {
                            await enqueueLinks({ 
                                urls, 
                                userData: { label: 'DETAIL' } 
                            });
                        }
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = jobs.slice(0, Math.max(0, remaining)).map(j => ({
                            ...j,
                            scraped_at: new Date().toISOString(),
                            source: 'behance.net'
                        }));
                        
                        if (toPush.length) {
                            await Dataset.pushData(toPush);
                            saved += toPush.length;
                            crawlerLog.info(`Saved ${toPush.length} jobs (total: ${saved})`);
                        }
                    }

                    // Paginate if needed
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const nextPageUrl = buildApiUrl(pageNo + 1, keyword, location, job_type, sort);
                        await enqueueLinks({ 
                            urls: [nextPageUrl], 
                            userData: { label: 'LIST', pageNo: pageNo + 1 } 
                        });
                        crawlerLog.info(`Enqueued next page: ${pageNo + 1}`);
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Already reached target of ${RESULTS_WANTED} results, skipping.`);
                        return;
                    }

                    crawlerLog.info(`Processing DETAIL page: ${request.url}`);

                    try {
                        const item = {
                            title: null,
                            company: null,
                            location: null,
                            job_type: null,
                            salary: null,
                            date_posted: null,
                            description_html: null,
                            description_text: null,
                            url: request.url,
                            scraped_at: new Date().toISOString(),
                            source: 'behance.net'
                        };

                        // Extract title
                        item.title = $('h1, [class*="job-title"], [class*="JobTitle"]').first().text().trim() || null;

                        // Extract company
                        item.company = $('[class*="company"], [class*="employer"], [class*="CompanyName"]').first().text().trim() || null;

                        // Extract location
                        item.location = $('[class*="location"], [class*="Location"]').first().text().trim() || null;

                        // Extract job type
                        item.job_type = $('[class*="job-type"], [class*="employment-type"], [class*="JobType"]').first().text().trim() || null;

                        // Extract salary
                        item.salary = $('[class*="salary"], [class*="compensation"], [class*="Salary"]').first().text().trim() || null;

                        // Extract date posted
                        const dateText = $('[class*="posted"], [class*="date"], time').first().text().trim();
                        item.date_posted = dateText || null;

                        // Extract description
                        const descElem = $('[class*="description"], [class*="Description"], .job-description, [class*="JobDescription"]').first();
                        if (descElem && descElem.length) {
                            item.description_html = String(descElem.html()).trim();
                            item.description_text = cleanText(item.description_html);
                        }

                        // Only save if we have at least a title
                        if (item.title) {
                            await Dataset.pushData(item);
                            saved++;
                            crawlerLog.info(`Saved job: "${item.title}" at ${item.company} (total: ${saved})`);
                        } else {
                            crawlerLog.warning(`No title found for ${request.url}, skipping`);
                        }
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`✓ Scraping completed. Saved ${saved} job listings from Behance.`);
    } catch (error) {
        log.error(`Fatal error: ${error.message}`);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { 
    console.error('Unhandled error:', err); 
    process.exit(1); 
});
