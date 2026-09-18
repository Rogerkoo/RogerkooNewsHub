const crypto = require('crypto');

const categories = [
  'News', 'News - Malaysia', 'IT / Software Engineering', 'Business',
  'Cars', 'AI', 'Science', 'Lifestyle', 'Sports', 'Technology', 'Entertainment'
];

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';').map(value => value.trim());
  const cookie = cookies.find(value => value.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function sessionToken() {
  const password = process.env.NEWS_ADMIN_PASSWORD || '';
  return crypto.createHmac('sha256', password).update('news-hub-admin-session').digest('hex');
}

function isAuthenticated(req) {
  return Boolean(process.env.NEWS_ADMIN_PASSWORD) && cookieValue(req, 'news_hub_session') === sessionToken();
}

function adminPasswordConfigured() {
  return Boolean(process.env.NEWS_ADMIN_PASSWORD);
}

function githubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function requireAuthenticated(req, res) {
  if (!adminPasswordConfigured()) {
    json(res, 503, { error: 'Set NEWS_ADMIN_PASSWORD in Vercel environment variables.' });
    return false;
  }
  if (!githubConfigured()) {
    json(res, 503, { error: 'Configure GITHUB_TOKEN and GITHUB_REPO in Vercel environment variables.' });
    return false;
  }
  if (!isAuthenticated(req)) {
    json(res, 401, { error: 'Admin sign-in required.' });
    return false;
  }
  return true;
}

function passwordMatches(password) {
  const expected = Buffer.from(process.env.NEWS_ADMIN_PASSWORD || '');
  const supplied = Buffer.from(String(password || ''));
  return expected.length === supplied.length && crypto.timingSafeEqual(supplied, expected);
}

function setSession(res, token, maxAge = 60 * 60 * 24 * 7) {
  res.setHeader('Set-Cookie', `news_hub_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

async function requestBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseArticle(html, url) {
  const meta = {};
  const metaTagPattern = /<meta\s+([^>]+)>/gi;
  let match;
  while ((match = metaTagPattern.exec(html)) !== null) {
    const attrsStr = match[1];
    const nameMatch = attrsStr.match(/(?:property|name)=["']([^"']+)["']/i);
    const contentMatch = attrsStr.match(/content=["']([^"']*)["']/i);
    if (nameMatch && contentMatch) {
      meta[nameMatch[1].toLowerCase()] = decodeEntities(contentMatch[1]);
    }
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const timeMatch = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
  const hostname = new URL(url).hostname;
  const rawTitle = meta['og:title'] || meta['twitter:title'] || (titleMatch && titleMatch[1].replace(/\s+/g, ' '));
  const title = decodeEntities(rawTitle);
  const summary = decodeEntities(meta['og:description'] || meta.description || meta['twitter:description'] || '');
  const source = decodeEntities(meta['og:site_name']) || hostname;
  const rawDate = meta['article:published_time'] || meta.datepublished || (timeMatch && timeMatch[1]) || new Date().toISOString();
  const date = rawDate.slice(0, 10);
  if (!title) throw new Error('No article title could be found at that URL.');
  return { title, summary, url, source, date };
}

async function fetchArticle(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enter a complete http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Enter a complete http:// or https:// URL.');
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) throw new Error(`Article fetch failed with HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error('That URL did not return an HTML article page.');
  }
  return parseArticle((await response.text()).slice(0, 2000000), url);
}

function githubConfig() {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error('Configure GITHUB_TOKEN and GITHUB_REPO environment variables in Vercel.');
  return { token: GITHUB_TOKEN, repo: GITHUB_REPO, branch: GITHUB_BRANCH };
}

async function githubRequest(path, options = {}) {
  const { token } = githubConfig();
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `GitHub API returned HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson.message) message += `: ${errJson.message}`;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function readNews() {
  const { repo, branch } = githubConfig();
  const result = await githubRequest(`${repo}/contents/news.json?ref=${encodeURIComponent(branch)}`);
  return { data: JSON.parse(Buffer.from(result.content, 'base64').toString('utf8')), sha: result.sha };
}

async function addArticle(item) {
  const { repo, branch } = githubConfig();
  const { data, sha } = await readNews();
  if (data.items.some(existing => existing.url === item.url)) throw new Error('That article is already in the dashboard.');
  if (!categories.includes(item.category)) throw new Error('Choose one of the available categories.');
  const tags = String(item.tags || '').split(/[,#]/).map(tag => tag.trim().toLowerCase()).filter(Boolean);
  const newItem = {
    title: String(item.title || '').trim(), summary: String(item.summary || '').trim(),
    url: String(item.url || '').trim(), source: String(item.source || '').trim(),
    category: item.category || 'News', tags: [...new Set(tags)], date: item.date || new Date().toISOString().slice(0, 10), addedAt: new Date().toISOString()
  };
  if (!newItem.title || !newItem.url) throw new Error('The article title and URL are required.');
  data.items.push(newItem);
  await githubRequest(`${repo}/contents/news.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Add article: ${newItem.title}`, content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString('base64'), sha, branch })
  });
  return newItem;
}

async function commitNews(data, message, sha) {
  const { repo, branch } = githubConfig();
  await githubRequest(`${repo}/contents/news.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString('base64'), sha, branch })
  });
}

async function updateArticle(item, originalUrl) {
  const { data, sha } = await readNews();
  const index = data.items.findIndex(existing => existing.url === originalUrl);
  if (index < 0) throw new Error('Article not found.');
  if (data.items.some((existing, position) => position !== index && existing.url === item.url)) throw new Error('That article URL is already in the dashboard.');
  if (!categories.includes(item.category)) throw new Error('Choose one of the available categories.');
  const tags = String(item.tags || '').split(/[,#]/).map(tag => tag.trim().toLowerCase()).filter(Boolean);
  const updated = { title: String(item.title || '').trim(), summary: String(item.summary || '').trim(), url: String(item.url || '').trim(), source: String(item.source || '').trim(), category: item.category, tags: [...new Set(tags)], date: item.date || '', addedAt: data.items[index].addedAt || '' };
  if (!updated.title || !updated.url) throw new Error('The article title and URL are required.');
  data.items[index] = updated;
  await commitNews(data, `Update article: ${updated.title}`, sha);
  return updated;
}

async function deleteArticle(url) {
  const { data, sha } = await readNews();
  const previousLength = data.items.length;
  data.items = data.items.filter(item => item.url !== url);
  if (data.items.length === previousLength) throw new Error('Article not found.');
  await commitNews(data, 'Delete article', sha);
  return data.items;
}

async function keepToday() {
  const { data, sha } = await readNews();
  const today = new Date().toISOString().slice(0, 10);
  data.items = data.items.filter(item => String(item.addedAt || '').startsWith(today));
  await commitNews(data, `Keep articles from ${today}`, sha);
  return data.items;
}

module.exports = async (req, res) => {
  const route = new URL(req.url, `https://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (req.method === 'GET' && route === '/api/session') {
      return json(res, 200, {
        authenticated: isAuthenticated(req),
        configured: adminPasswordConfigured() && githubConfigured()
      });
    }
    if (req.method === 'POST' && route === '/api/login') {
      if (!adminPasswordConfigured()) {
        return json(res, 503, { error: 'Set NEWS_ADMIN_PASSWORD in Vercel environment variables.' });
      }
      const body = await requestBody(req);
      if (!passwordMatches(body.password)) return json(res, 401, { error: 'Incorrect admin password.' });
      setSession(res, sessionToken());
      return json(res, 200, { authenticated: true });
    }
    if (req.method === 'POST' && route === '/api/logout') {
      setSession(res, '', 0);
      return json(res, 200, { authenticated: false });
    }
    if (req.method === 'GET' && route === '/api/news') {
      if (!requireAuthenticated(req, res)) return;
      return json(res, 200, (await readNews()).data);
    }
    if (!['/api/preview', '/api/add', '/api/update', '/api/delete', '/api/keep-today'].includes(route) || req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
    if (!requireAuthenticated(req, res)) return;
    const body = await requestBody(req);
    if (route === '/api/preview') return json(res, 200, { item: await fetchArticle(String(body.url || '').trim()) });
    if (route === '/api/add') return json(res, 200, { item: await addArticle(body.item || {}) });
    if (route === '/api/update') return json(res, 200, { item: await updateArticle(body.item || {}, String(body.originalUrl || '').trim()) });
    if (route === '/api/delete') return json(res, 200, { items: await deleteArticle(String(body.url || '').trim()) });
    return json(res, 200, { items: await keepToday() });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Request failed.' });
  }
};
