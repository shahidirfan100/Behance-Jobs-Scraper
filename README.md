# Behance Jobs Scraper

Extract creative job opportunities from Behance's job board efficiently and reliably. This scraper uses a Playwright browser crawler to handle Behance's client-side rendering and collect job listings including titles, companies, locations, salaries, job types, and detailed descriptions.

## What does the Behance Jobs Scraper do?

The Behance Jobs Scraper enables you to extract comprehensive job data from Behance's job board programmatically. It uses a browser-based crawler with optional sitemap fallback to ensure reliable extraction even when pages are rendered client-side.

<strong>Key capabilities:</strong>

- Search jobs by keyword, location, and employment type
- Extract complete job details including descriptions
- Handle pagination automatically
- Export data in multiple formats (JSON, CSV, Excel, HTML)
- Scale to thousands of job listings
- Bypass rate limiting with proxy support

## Why scrape Behance jobs?

<ul>
  <li><strong>Competitive Analysis:</strong> Monitor salary ranges and job requirements in the creative industry</li>
  <li><strong>Market Research:</strong> Understand hiring trends for design and creative roles</li>
  <li><strong>Job Aggregation:</strong> Build job boards or career platforms focused on creative positions</li>
  <li><strong>Talent Intelligence:</strong> Identify which companies are actively hiring creative professionals</li>
  <li><strong>Career Planning:</strong> Track opportunities across multiple locations and specializations</li>
</ul>

## How much does it cost to scrape Behance jobs?

<table>
  <thead>
    <tr>
      <th>Jobs Scraped</th>
      <th>Compute Units</th>
      <th>Approximate Cost</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>100 jobs (basic info)</td>
      <td>~0.05 CU</td>
      <td>$0.02</td>
    </tr>
    <tr>
      <td>500 jobs (full details)</td>
      <td>~0.25 CU</td>
      <td>$0.10</td>
    </tr>
    <tr>
      <td>1,000 jobs (full details)</td>
      <td>~0.50 CU</td>
      <td>$0.20</td>
    </tr>
  </tbody>
</table>

<p><em>Prices are approximate and based on Apify's pay-as-you-go pricing. <a href="https://apify.com/pricing">Learn more about Apify pricing</a>.</em></p>

## Input Configuration

The scraper accepts the following configuration options:

### Search Parameters

<table>
  <thead>
    <tr>
      <th>Field</th>
      <th>Type</th>
      <th>Description</th>
      <th>Required</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>keyword</code></td>
      <td>String</td>
      <td>Job title or keyword (e.g., "Graphic Designer", "UX Designer")</td>
      <td>No</td>
    </tr>
    <tr>
      <td><code>location</code></td>
      <td>String</td>
      <td>City, state, or "Remote" to filter by location</td>
      <td>No</td>
    </tr>
    <tr>
      <td><code>job_type</code></td>
      <td>String</td>
      <td>Employment type (Full-time, Part-time, Freelance, Contract)</td>
      <td>No</td>
    </tr>
    <tr>
      <td><code>sort</code></td>
      <td>String</td>
      <td>Sort order: "published_on" (most recent) or "relevance"</td>
      <td>No</td>
    </tr>
  </tbody>
</table>

### Scraping Options

<table>
  <thead>
    <tr>
      <th>Field</th>
      <th>Type</th>
      <th>Description</th>
      <th>Default</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>results_wanted</code></td>
      <td>Integer</td>
      <td>Maximum number of jobs to scrape</td>
      <td>100</td>
    </tr>
    <tr>
      <td><code>max_pages</code></td>
      <td>Integer</td>
      <td>Maximum listing pages to process</td>
      <td>20</td>
    </tr>
    <tr>
      <td><code>collectDetails</code></td>
      <td>Boolean</td>
      <td>Extract full job descriptions (slower but more complete)</td>
      <td>true</td>
    </tr>
    <tr>
      <td><code>proxyConfiguration</code></td>
      <td>Object</td>
      <td>Proxy settings (Residential proxies recommended)</td>
      <td>Apify Proxy</td>
    </tr>
  </tbody>
</table>

### Example Input

```json
{
  "keyword": "graphic designer",
  "location": "New York",
  "job_type": "Full-time",
  "sort": "published_on",
  "results_wanted": 50,
  "max_pages": 5,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

## Output Format

The scraper exports data in a structured format with the following fields:

```json
{
  "title": "Senior Graphic Designer",
  "company": "Creative Agency Inc.",
  "location": "New York, NY",
  "salary": "$70,000 - $90,000",
  "job_type": "Full-time",
  "date_posted": "2 days ago",
  "description_html": "<p>We are seeking a talented graphic designer...</p>",
  "description_text": "We are seeking a talented graphic designer...",
  "url": "https://www.behance.net/joblist/...",
  "scraped_at": "2025-12-15T10:30:00.000Z",
  "source": "behance.net"
}
```

### Field Descriptions

<ul>
  <li><strong>title:</strong> Job position title</li>
  <li><strong>company:</strong> Hiring organization name</li>
  <li><strong>location:</strong> Job location or "Remote"</li>
  <li><strong>salary:</strong> Compensation range (if available)</li>
  <li><strong>job_type:</strong> Employment type (Full-time, Part-time, etc.)</li>
  <li><strong>date_posted:</strong> When the job was published</li>
  <li><strong>description_html:</strong> Full job description in HTML format</li>
  <li><strong>description_text:</strong> Plain text version of description</li>
  <li><strong>url:</strong> Direct link to the job posting</li>
  <li><strong>scraped_at:</strong> Timestamp of data extraction</li>
  <li><strong>source:</strong> Data source identifier</li>
</ul>

## How to use the Behance Jobs Scraper

<h3>1. Create a free Apify account</h3>

<p>Sign up at <a href="https://console.apify.com/sign-up">apify.com</a> - no credit card required for the free tier.</p>

<h3>2. Configure your search</h3>

<p>Enter your search parameters in the input fields or provide a JSON configuration.</p>

<h3>3. Run the scraper</h3>

<p>Click <strong>Start</strong> and monitor progress in real-time.</p>

<h3>4. Export your data</h3>

<p>Download results in JSON, CSV, Excel, or other formats directly from the platform.</p>

## Use Cases

<h3>Recruitment & Talent Acquisition</h3>
<p>Identify qualified candidates by tracking which companies are hiring for similar positions and what skills they require.</p>

<h3>Competitive Intelligence</h3>
<p>Monitor competitor hiring patterns, salary ranges, and job requirements to inform your hiring strategy.</p>

<h3>Market Analysis</h3>
<p>Analyze trends in the creative job market including popular locations, in-demand skills, and compensation ranges.</p>

<h3>Job Aggregation Platforms</h3>
<p>Build or enhance job boards focused on creative industries with fresh, structured job data.</p>

<h3>Career Development</h3>
<p>Research job opportunities across multiple locations and identify skill gaps in your target roles.</p>

## Performance & Limitations

<h3>Speed</h3>
<ul>
  <li>Basic info (no details): ~100 jobs/minute</li>
  <li>Full details: ~20-30 jobs/minute</li>
</ul>

<h3>Best Practices</h3>
<ul>
  <li>Use residential proxies for reliable access</li>
  <li>Start with smaller runs to test your configuration</li>
  <li>Enable full details only when needed</li>
  <li>Set reasonable <code>max_pages</code> to control runtime</li>
</ul>

<h3>Rate Limiting</h3>
<p>The scraper implements intelligent request throttling and uses proxies to prevent rate limiting. Residential proxies are recommended for large-scale extractions.</p>

## Support & Feedback

<p>Need help or have suggestions?</p>

<ul>
  <li>Check the <a href="https://docs.apify.com">Apify Documentation</a></li>
  <li>Contact support through the Apify Console</li>
  <li>Report issues or request features via the actor's page</li>
</ul>

## Legal & Compliance

<p>This scraper is provided for legitimate use cases such as market research, job aggregation, and competitive analysis. Users are responsible for ensuring their use complies with:</p>

<ul>
  <li>Behance's Terms of Service</li>
  <li>Applicable data protection regulations (GDPR, CCPA, etc.)</li>
  <li>Local laws regarding data collection and usage</li>
</ul>

<p><em>Always respect robots.txt and rate limits. Use scraped data responsibly and ethically.</em></p>

## Technical Details

<ul>
  <li><strong>Runtime:</strong> Node.js 22</li>
  <li><strong>Memory:</strong> 256-512 MB recommended</li>
  <li><strong>Timeout:</strong> 3600 seconds maximum</li>
  <li><strong>Proxy Support:</strong> Yes (Apify Proxy recommended)</li>
</ul>
