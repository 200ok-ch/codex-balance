#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROVIDER = String(process.env.BALANCE_PROVIDER || 'all').toLowerCase();
const CODEX_URL = 'https://chatgpt.com/codex/cloud/settings/analytics';
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OPENCODE_CONSOLE = 'https://opencode.ai/console';
const OPENCODE_ORG = process.env.OPENCODE_ORG || null;
const TIMEOUT_MS = Number(process.env.BALANCE_TIMEOUT_MS || process.env.CODEX_BALANCE_TIMEOUT_MS || 6000);
const DEFAULT_PROFILE_INIS = [
  path.join(os.homedir(), '.mozilla', 'firefox', 'profiles.ini'),
  path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'profiles.ini'),
];
const PROFILE_INI = process.env.FIREFOX_PROFILES_INI || DEFAULT_PROFILE_INIS.find((candidate) => fs.existsSync(candidate)) || DEFAULT_PROFILE_INIS[0];
const FIREFOX_EXECUTABLE = process.env.FIREFOX_EXECUTABLE;
const HISTORY_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.BALANCE_HISTORY || '').toLowerCase());
const HISTORY_DB = process.env.BALANCE_HISTORY_DB
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-balance', 'history.sqlite');
// Several polybar bars (one per monitor) each run the script; samples this close together are duplicates.
const HISTORY_DEDUPE_SECONDS = 60;

const PROFILE_HELP = 'Set FIREFOX_PROFILE_DIR to a Firefox profile that is signed in to ChatGPT.';

function loadPlaywright() {
  const candidates = [
    { id: 'playwright', source: 'package' },
    { id: '/usr/share/nodejs/playwright', source: 'system' },
  ];

  for (const candidate of candidates) {
    try {
      return { playwright: require(candidate.id), source: candidate.source };
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Unable to load Playwright. Run `npm install`, then `npx playwright install firefox`.');
}

function installedPlaywrightFirefoxExecutable() {
  const msPlaywrightDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(msPlaywrightDir)) return undefined;

  const executables = fs.readdirSync(msPlaywrightDir)
    .map((name) => {
      const match = name.match(/^firefox-(\d+)$/);
      if (!match) return null;
      return {
        revision: Number(match[1]),
        executable: path.join(msPlaywrightDir, name, 'firefox', 'firefox'),
      };
    })
    .filter((entry) => entry && fs.existsSync(entry.executable))
    .sort((a, b) => b.revision - a.revision);

  return executables[0]?.executable;
}

function parseIni(contents) {
  const sections = [];
  let current = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const section = line.match(/^\[(.+)]$/);
    if (section) {
      current = { name: section[1], values: {} };
      sections.push(current);
      continue;
    }

    const pair = line.match(/^([^=]+)=(.*)$/);
    if (pair && current) current.values[pair[1].trim()] = pair[2].trim();
  }

  return sections;
}

function firefoxBaseDir(profileIni = PROFILE_INI) {
  return path.dirname(profileIni);
}

function resolveProfilePath(profile, profileIni = PROFILE_INI) {
  const profilePath = profile.values.Path;
  if (!profilePath) return null;
  return profile.values.IsRelative === '1' ? path.join(firefoxBaseDir(profileIni), profilePath) : profilePath;
}

function profileIniCandidates() {
  if (process.env.FIREFOX_PROFILES_INI) return [PROFILE_INI];
  return DEFAULT_PROFILE_INIS.filter((profileIni) => fs.existsSync(profileIni));
}

function firefoxProfiles(profileIni = PROFILE_INI) {
  if (!fs.existsSync(profileIni)) {
    throw new Error(`Firefox profiles.ini was not found at ${profileIni}. ${PROFILE_HELP}`);
  }

  const sections = parseIni(fs.readFileSync(profileIni, 'utf8'));
  const installDefaultPath = sections.find((section) => section.name.startsWith('Install'))?.values.Default;

  return sections
    .filter((section) => section.name.startsWith('Profile'))
    .map((section) => {
      const profileDir = resolveProfilePath(section, profileIni);
      return {
        name: section.values.Name || section.name,
        path: profileDir,
        profilesIni: profileIni,
        exists: Boolean(profileDir && fs.existsSync(profileDir)),
        default: section.values.Default === '1' || section.values.Path === installDefaultPath,
      };
    });
}

function cookieHosts(profileDir, domains) {
  const source = path.join(profileDir, 'cookies.sqlite');
  if (!fs.existsSync(source)) return [];

  const copied = copyCookieDatabase(profileDir);
  try {
    const now = Math.floor(Date.now() / 1000);
    const where = domains.map((domain) => `host like '%${domain.replace(/'/g, "''")}'`).join(' or ');
    const output = execFileSync('sqlite3', [
      '-json',
      copied.database,
      `select distinct host
       from moz_cookies
       where (${where})
         and (expiry = 0 or expiry > ${now})
       order by host`,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });

    return (output.trim() ? JSON.parse(output) : []).map((row) => row.host);
  } finally {
    fs.rmSync(copied.tmpRoot, { recursive: true, force: true });
  }
}

function chatgptCookieHosts(profileDir) {
  return cookieHosts(profileDir, ['chatgpt.com', 'openai.com']);
}

function opencodeCookieHosts(profileDir) {
  return cookieHosts(profileDir, ['opencode.ai']);
}

function listProfiles() {
  const profiles = profileIniCandidates().flatMap((profileIni) => firefoxProfiles(profileIni));
  if (profiles.length === 0) throw new Error(`No Firefox profiles found in ${PROFILE_INI}.`);

  let previousProfileIni = null;

  for (const profile of profiles) {
    if (profile.profilesIni !== previousProfileIni) {
      if (previousProfileIni) console.log('');
      console.log(`profiles.ini: ${profile.profilesIni}`);
      previousProfileIni = profile.profilesIni;
    }

    const labels = [];
    if (profile.default) labels.push('default');
    if (!profile.exists) labels.push('missing');

    let cookieInfo = 'ChatGPT cookies: not checked';
    if (profile.exists) {
      const hosts = chatgptCookieHosts(profile.path);
      cookieInfo = hosts.length > 0 ? `ChatGPT cookies: yes (${hosts.join(', ')})` : 'ChatGPT cookies: no';
    }

    console.log(`  ${profile.name}${labels.length ? ` [${labels.join(', ')}]` : ''}`);
    console.log(`    path: ${profile.path || '(none)'}`);
    console.log(`    ${cookieInfo}`);
  }
}

function defaultFirefoxProfileDir() {
  if (process.env.FIREFOX_PROFILE_DIR) return path.resolve(process.env.FIREFOX_PROFILE_DIR);

  if (!fs.existsSync(PROFILE_INI)) {
    throw new Error(`Firefox profiles.ini was not found. ${PROFILE_HELP}`);
  }

  const sections = parseIni(fs.readFileSync(PROFILE_INI, 'utf8'));
  const profiles = sections.filter((section) => section.name.startsWith('Profile'));
  const installDefaultPath = sections.find((section) => section.name.startsWith('Install'))?.values.Default;

  const profile =
    (installDefaultPath && profiles.find((section) => section.values.Path === installDefaultPath)) ||
    profiles.find((section) => section.values.Default === '1') ||
    profiles.find((section) => section.values.Name === 'default') ||
    profiles[0];

  const profileDir = profile && resolveProfilePath(profile);
  if (!profileDir || !fs.existsSync(profileDir)) {
    throw new Error(`Unable to find a Firefox profile. ${PROFILE_HELP}`);
  }

  return profileDir;
}

function copyCookieDatabase(profileDir) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-balance-cookies-'));
  const source = path.join(profileDir, 'cookies.sqlite');
  const target = path.join(tmpRoot, 'cookies.sqlite');

  if (!fs.existsSync(source)) throw new Error('Firefox cookies.sqlite was not found in the selected profile.');

  fs.copyFileSync(source, target);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${source}${suffix}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${target}${suffix}`);
  }

  return { tmpRoot, database: target };
}

function firefoxCookies(profileDir, { domains, requireDomain, missingHelp } = { domains: ['chatgpt.com', 'openai.com'] }) {
  const copied = copyCookieDatabase(profileDir);

  try {
    const now = Math.floor(Date.now() / 1000);
    let output;
    try {
      const where = (domains || []).map((domain) => `host like '%${domain.replace(/'/g, "''")}'`).join(' or ');
      output = execFileSync('sqlite3', [
        '-json',
        copied.database,
        `select name, value, host, path, expiry, isSecure, isHttpOnly
         from moz_cookies
         where (${where})
           and (expiry = 0 or expiry > ${now})`,
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('sqlite3 is required to read Firefox cookies. Install sqlite3 and try again.');
      throw new Error('Unable to read Firefox cookies with sqlite3.');
    }

    const rows = output.trim() ? JSON.parse(output) : [];

    const cookies = rows.map((row) => {
      const expiry = Number(row.expiry);
      return {
        name: row.name,
        value: row.value,
        domain: row.host,
        path: row.path || '/',
        expires: expiry > 0 ? Math.floor(expiry > 9999999999 ? expiry / 1000 : expiry) : -1,
        httpOnly: Boolean(row.isHttpOnly),
        secure: Boolean(row.isSecure),
      };
    });

    const required = requireDomain || 'chatgpt.com';
    if (!cookies.some((cookie) => cookie.domain.includes(required))) {
      throw new Error(missingHelp || `No ${required} cookies found in the selected Firefox profile. Sign in to ChatGPT in Firefox first, or set FIREFOX_PROFILE_DIR to a Firefox profile that is signed in to ChatGPT.`);
    }

    return cookies;
  } finally {
    fs.rmSync(copied.tmpRoot, { recursive: true, force: true });
  }
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// A meter is { remaining, resetsAt }: remaining percent as an unrounded number
// (0-100) and the reset time in unix seconds (null when the provider doesn't say).
// Rounding happens only for display, so recorded history keeps full precision.
function meter(remaining, resetsAt = null) {
  const value = parseFloat(remaining);
  if (!Number.isFinite(value)) return null;
  const reset = Number(resetsAt);
  return { remaining: Math.max(0, Math.min(100, value)), resetsAt: Number.isFinite(reset) && reset > 0 ? Math.round(reset) : null };
}

function pct(m) {
  return m ? `${Math.round(m.remaining)}%` : 'n/a';
}

function formatBalance({ weekly }) {
  return `week: ${pct(weekly)}`;
}

function formatZaiBalance({ fiveHour, weekly }) {
  return `5h: ${pct(fiveHour)} | week: ${pct(weekly)}`;
}

function zaiApiKey() {
  if (process.env.ZAI_API_KEY) return { key: process.env.ZAI_API_KEY, source: 'ZAI_API_KEY' };
  if (process.env.GLM_API_KEY) return { key: process.env.GLM_API_KEY, source: 'GLM_API_KEY' };
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const candidates = [
    path.join(dataHome, 'opencode', 'auth.json'),
    path.join(os.homedir(), '.config', 'openusage', 'zai.json'),
    path.join(os.homedir(), '.config', 'zai', 'key.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = parsed?.apiKey || parsed?.api_key || parsed?.key || parsed?.['zai-coding-plan']?.key;
      if (key) return { key: String(key), source: file };
    } catch {
      // Missing or unparsable; try the next source.
    }
  }
  throw new Error('No Z.ai API key found. Set ZAI_API_KEY (or GLM_API_KEY), sign in via omp/opencode (zai-coding-plan), or add {"apiKey":"…"} to ~/.config/openusage/zai.json.');
}

function zaiRemaining(entry) {
  const resetsAt = Number(entry?.nextResetTime) / 1000;
  const raw = Number(entry?.percentage);
  if (Number.isFinite(raw)) return meter(100 - raw, resetsAt);
  const remaining = Number(entry?.remaining);
  const total = Number(entry?.usage);
  if (Number.isFinite(remaining) && Number.isFinite(total) && total > 0) {
    return meter((remaining / total) * 100, resetsAt);
  }
  return null;
}

function zaiWindowMs(unit, number) {
  const hour = 60 * 60 * 1000;
  const unitMs = { 3: hour, 4: 24 * hour, 5: 30 * 24 * hour, 6: 7 * 24 * hour }[Number(unit)];
  if (!unitMs || !(Number(number) > 0)) return null;
  return unitMs * Number(number);
}

function parseZaiQuotaJson(json) {
  if (json && json.success === false && !json.data) {
    throw new Error('No active GLM Coding Plan for this Z.ai API key. Subscribe at z.ai/subscribe to see usage.');
  }
  const container = json?.data && typeof json.data === 'object' ? json.data : json;
  const limits = container?.limits;
  if (!Array.isArray(limits)) throw new Error(`Could not parse Z.ai quota response: ${JSON.stringify(json).slice(0, 200)}`);
  let fiveHour = null;
  let weekly = null;
  for (const entry of limits) {
    const type = entry?.type || entry?.name;
    if (type !== 'CREDIT_LIMIT' && type !== 'TOKENS_LIMIT') continue;
    const windowMs = zaiWindowMs(entry?.unit, entry?.number);
    if (windowMs === null) continue;
    // Sub-daily window (unit 3, hours) is the 5h quota; multi-day (unit 6, weeks) is weekly.
    if (windowMs < 24 * 60 * 60 * 1000) fiveHour = fiveHour || zaiRemaining(entry);
    else weekly = weekly || zaiRemaining(entry);
  }
  if (!fiveHour && !weekly) throw new Error(`No 5h or weekly quota in Z.ai response: ${JSON.stringify(json).slice(0, 200)}`);
  return { fiveHour, weekly };
}

async function fetchZaiBalance() {
  const { key } = zaiApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ZAI_QUOTA_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error('Z.ai API key invalid (rejected with ' + response.status + '). Regenerate it at z.ai/manage-apikey/apikey-list.');
    }
    if (!response.ok) throw new Error(`Z.ai quota request failed with HTTP ${response.status}.`);
    return parseZaiQuotaJson(await response.json());
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Z.ai quota request timed out after ${TIMEOUT_MS}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function claudeOauthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const file = path.join(CLAUDE_CONFIG_DIR, '.credentials.json');
  let oauth;
  try {
    oauth = JSON.parse(fs.readFileSync(file, 'utf8'))?.claudeAiOauth;
  } catch {
    throw new Error(`No Claude Code credentials at ${file}. Run \`claude\` and log in, or set CLAUDE_CODE_OAUTH_TOKEN.`);
  }
  if (!oauth?.accessToken) throw new Error(`No OAuth access token in ${file}. Run \`claude\` and log in with your Claude subscription.`);
  // Claude Code refreshes the token itself; refreshing here would rotate the refresh token out from under it.
  if (Number(oauth.expiresAt) && Number(oauth.expiresAt) < Date.now()) {
    throw new Error('Claude Code OAuth token expired. Run `claude` once to refresh it.');
  }
  return oauth.accessToken;
}

function claudeRemaining(window) {
  const used = Number(window?.utilization);
  if (window?.utilization === null || window?.utilization === undefined || !Number.isFinite(used)) return null;
  return meter(100 - used, Date.parse(window.resets_at) / 1000);
}

function parseClaudeUsageJson(json) {
  const fiveHour = claudeRemaining(json?.five_hour);
  const weekly = claudeRemaining(json?.seven_day);
  const opus = claudeRemaining(json?.seven_day_opus);
  const sonnet = claudeRemaining(json?.seven_day_sonnet);
  if (!fiveHour && !weekly) throw new Error(`Could not parse Claude usage response: ${JSON.stringify(json).slice(0, 200)}`);
  return { fiveHour, weekly, opus, sonnet };
}

async function fetchClaudeBalance() {
  const token = claudeOauthToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Claude usage request rejected with ${response.status}. Run \`claude\` once to refresh the login.`);
    }
    if (!response.ok) throw new Error(`Claude usage request failed with HTTP ${response.status}.`);
    return parseClaudeUsageJson(await response.json());
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Claude usage request timed out after ${TIMEOUT_MS}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatClaudeBalance({ fiveHour, weekly, opus, sonnet }) {
  const parts = [`5h: ${pct(fiveHour)}`, `week: ${pct(weekly)}`];
  if (opus) parts.push(`opus week: ${pct(opus)}`);
  if (sonnet) parts.push(`sonnet week: ${pct(sonnet)}`);
  return parts.join(' | ');
}

function parseUsageJson(json) {
  const windows = [json?.rate_limit?.primary_window, json?.rate_limit?.secondary_window].filter(Boolean);
  const remainingForDuration = (seconds) => {
    const window = windows.find((candidate) => candidate.limit_window_seconds === seconds);
    if (typeof window?.used_percent !== 'number') return null;
    const resetsAt = window.reset_at ?? (Number.isFinite(window.reset_after_seconds) ? Date.now() / 1000 + window.reset_after_seconds : null);
    return meter(100 - window.used_percent, resetsAt);
  };
  const weekly = remainingForDuration(7 * 24 * 60 * 60);

  if (weekly) return { weekly };

  const text = JSON.stringify(json);
  const weeklyFallback = text.match(/"(?:remaining_percentage|remaining_percent|percent_remaining|percentage_remaining|remaining)"\s*:\s*(\d+(?:\.\d+)?).*?"(?:weekly|week)/i)?.[1];

  if (weeklyFallback) return { weekly: meter(weeklyFallback) };

  const candidates = [];
  function visit(value, pathParts = []) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      if (typeof child === 'number' || typeof child === 'string') {
        candidates.push({ path: nextPath.join('.'), value: child });
      } else {
        visit(child, nextPath);
      }
    }
  }

  visit(json);

  const weeklyCandidate = candidates.find((candidate) => /week/i.test(candidate.path) && /remain|percent|percentage/i.test(candidate.path));

  const weeklyCandidateMeter = weeklyCandidate && meter(weeklyCandidate.value);
  if (weeklyCandidateMeter) {
    return { weekly: weeklyCandidateMeter };
  }

  throw new Error(`Could not parse usage response: ${text.slice(0, 500)}`);
}

async function extractBalances(page) {
  await page.route('**/*', (route) => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url();

    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (['fetch', 'xhr'].includes(type)) {
      const required = url.includes('/backend-api/wham/') || url.includes('/cdn-cgi/challenge-platform/');
      const noisy = url.includes('/backend-api/') || url.includes('/ces/') || url.includes('ab.chatgpt.com');
      if (!required && noisy) return route.abort();
    }

    return route.continue();
  });

  const usageResponse = page.waitForResponse((response) => (
    /\/backend-api\/wham\/usage(?:$|[?#])/.test(response.url()) && response.status() === 200
  ), { timeout: TIMEOUT_MS });

  await page.goto(CODEX_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

  try {
    const response = await usageResponse;
    const json = await response.json();
    return parseUsageJson(json);
  } catch {
    // Fall back to the rendered text if the API shape changes or the response is not JSON.
  }

  try {
    await page.getByText('Balance', { exact: true }).waitFor({ timeout: TIMEOUT_MS });
  } catch {
    throw new Error('Balance section did not load. Check that Firefox is signed in to ChatGPT and Codex analytics is available.');
  }

  const bodyText = normalizeWhitespace(await page.locator('body').innerText({ timeout: TIMEOUT_MS }));
  const weekly = meter(bodyText.match(/Weekly\s+usage\s+limit\s+(\d+(?:\.\d+)?)%\s+remaining/i)?.[1]);

  if (!weekly) {
    throw new Error('Could not parse balance values from the Codex analytics page.');
  }

  return { weekly };
}

async function launchWithCookies(cookies) {
  const { playwright, source } = loadPlaywright();
  const { firefox } = playwright;
  const executablePath = FIREFOX_EXECUTABLE || (source === 'system' ? installedPlaywrightFirefoxExecutable() : undefined);

  const launchOptions = {
    headless: true,
    timeout: TIMEOUT_MS,
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await firefox.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookies);
  return { browser, context, page: await context.newPage() };
}

async function fetchCodexBalance() {
  const sourceProfile = defaultFirefoxProfileDir();
  const cookies = firefoxCookies(sourceProfile);

  let browser;

  try {
    const launched = await launchWithCookies(cookies);
    browser = launched.browser;
    const { weekly } = await extractBalances(launched.page);
    return { weekly };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// "Resets in 3d 8h" -> seconds. Only as precise as the page, so the derived
// resetsAt can drift by up to the smallest unit shown between polls.
function relativeSeconds(text) {
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, amount, unit] of String(text).matchAll(/(\d+)\s*([dhms])/gi)) total += Number(amount) * units[unit.toLowerCase()];
  return total || null;
}

// The Go page has rendered both "Rolling usage 2%" (used) and
// "Rolling usage 100% left" (remaining); honour the suffix when present.
function opencodeRemaining(bodyText, label) {
  const match = bodyText.match(new RegExp(`${label} usage (\\d+(?:\\.\\d+)?)%(\\s+(?:left|remaining))?(?:\\s+Resets in ((?:\\d+\\s*[dhms]\\s*)+))?`, 'i'));
  if (!match) return null;
  const value = Number(match[1]);
  const remaining = match[2] ? value : 100 - value;
  const resetIn = relativeSeconds(match[3]);
  return meter(remaining, resetIn && Date.now() / 1000 + resetIn);
}

async function fetchOpencodeBalance() {
  const sourceProfile = defaultFirefoxProfileDir();
  const cookies = firefoxCookies(sourceProfile, {
    domains: ['opencode.ai'],
    requireDomain: 'opencode.ai',
    missingHelp: 'No opencode.ai cookies found in the selected Firefox profile. Sign in to opencode.ai in Firefox first, or set FIREFOX_PROFILE_DIR to a Firefox profile that is signed in.',
  });

  let browser;

  try {
    const launched = await launchWithCookies(cookies);
    browser = launched.browser;
    const { page, context } = launched;
    // The org id is part of the route (/console/<orgId>/go). OPENCODE_ORG skips
    // discovery; otherwise resolve it via the orgs API (no navigation), then load
    // the Go page on a fresh page — re-navigating the same page races the SPA
    // router and aborts (NS_BINDING_ABORTED).
    let goPage = page;
    let orgId = OPENCODE_ORG;
    if (!orgId) {
      await page.goto(`${OPENCODE_CONSOLE}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
      const orgs = await page.evaluate(async () => {
        const resp = await fetch('/console/api/orgs', { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`opencode org lookup failed with HTTP ${resp.status}.`);
        return resp.json();
      });
      orgId = (Array.isArray(orgs) ? orgs[0]?.id : orgs?.orgs?.[0]?.id || orgs?.id) || null;
      if (!orgId) throw new Error('No opencode org found. Set OPENCODE_ORG to your org id.');
      await page.close();
      goPage = await context.newPage();
    }
    await goPage.goto(`${OPENCODE_CONSOLE}/${orgId}/go`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await goPage.getByText('Rolling usage', { exact: false }).waitFor({ timeout: TIMEOUT_MS * 2 });
    const bodyText = normalizeWhitespace(await goPage.locator('body').innerText({ timeout: TIMEOUT_MS }));
    const fiveHour = opencodeRemaining(bodyText, 'Rolling');
    const weekly = opencodeRemaining(bodyText, 'Weekly');
    const monthly = opencodeRemaining(bodyText, 'Monthly');
    if (!fiveHour && !weekly && !monthly) {
      throw new Error('Could not parse usage meters from the opencode Go page. Check that Firefox is signed in to opencode.ai and the Go subscription is active.');
    }
    return { fiveHour, weekly, monthly };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const PROVIDERS = {
  codex: {
    label: 'C',
    fetch: fetchCodexBalance,
    format: formatBalance,
    compact: ({ weekly }) => pct(weekly),
  },
  zai: {
    label: 'Z',
    fetch: fetchZaiBalance,
    format: formatZaiBalance,
    compact: ({ fiveHour, weekly }) => `${pct(fiveHour)}/${pct(weekly)}`,
  },
  opencode: {
    label: 'O',
    fetch: fetchOpencodeBalance,
    format: ({ fiveHour, weekly, monthly }) => `5h: ${pct(fiveHour)} | week: ${pct(weekly)} | month: ${pct(monthly)}`,
    compact: ({ fiveHour, weekly, monthly }) => `${pct(fiveHour)}/${pct(weekly)}/${pct(monthly)}`,
  },
  claude: {
    label: 'CC',
    fetch: fetchClaudeBalance,
    format: formatClaudeBalance,
    compact: ({ fiveHour, weekly }) => `${pct(fiveHour)}/${pct(weekly)}`,
  },
};

// Meter keys as returned by the fetchers -> window names stored in history.
const HISTORY_WINDOWS = { fiveHour: '5h', weekly: 'week', monthly: 'month', opus: 'opus_week', sonnet: 'sonnet_week' };

function openHistory() {
  // node:sqlite is still flagged experimental on Node 22 and warns on every load; keep stderr quiet.
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning?.message ?? warning).includes('SQLite')) return;
    return emitWarning.call(this, warning, ...rest);
  };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(`needs Node.js 22.13 or newer (running ${process.version}); set BALANCE_HISTORY=0 to silence this.`);
  } finally {
    process.emitWarning = emitWarning;
  }
  fs.mkdirSync(path.dirname(HISTORY_DB), { recursive: true });
  const db = new DatabaseSync(HISTORY_DB);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS samples (
      created_at    INTEGER NOT NULL, -- unix seconds, shared by every row of one run
      provider      TEXT    NOT NULL,
      window        TEXT    NOT NULL,
      remaining_pct REAL    NOT NULL,
      resets_at     INTEGER           -- unix seconds; null when the provider doesn't say
    );
    CREATE INDEX IF NOT EXISTS samples_lookup ON samples (provider, window, created_at);
  `);
  return db;
}

// Append one row per meter of every provider that answered. Never affects the printed balance.
function recordHistory(results) {
  if (!HISTORY_ENABLED) return;
  const rows = results.flatMap(({ name, value }) => Object.entries(value || {})
    .filter(([key, m]) => m && HISTORY_WINDOWS[key])
    .map(([key, m]) => ({ provider: name, window: HISTORY_WINDOWS[key], ...m })));
  if (!rows.length) return;
  let db;
  try {
    db = openHistory();
    const createdAt = Math.floor(Date.now() / 1000);
    const insert = db.prepare(`
      INSERT INTO samples (created_at, provider, window, remaining_pct, resets_at)
      SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM samples WHERE provider = ? AND window = ? AND created_at > ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    for (const row of rows) {
      insert.run(createdAt, row.provider, row.window, row.remaining, row.resetsAt,
        row.provider, row.window, createdAt - HISTORY_DEDUPE_SECONDS);
    }
    db.exec('COMMIT');
  } catch (error) {
    // close() below rolls back an unfinished transaction.
    console.error(`codex-balance: history: ${error.message}`);
  } finally {
    db?.close();
  }
}

function selectedProviders() {
  const flag = process.argv.indexOf('--provider');
  const raw = flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1] : PROVIDER;
  const names = raw.toLowerCase().split(',').map((name) => name.trim()).filter(Boolean);
  const expanded = names.flatMap((name) => (name === 'all' ? Object.keys(PROVIDERS) : [name]));
  const unknown = expanded.find((name) => !PROVIDERS[name]);
  if (unknown || !expanded.length) {
    throw new Error(`Unknown provider "${unknown || raw}". Use --provider ${Object.keys(PROVIDERS).join('|')}|all, or a comma-separated list.`);
  }
  return { names: [...new Set(expanded)], combined: names.length > 1 || names.includes('all') };
}

// Compact one-liner; a failing provider prints "?" (reason on stderr) instead of hiding the others.
async function runCombined(names) {
  const results = await Promise.allSettled(names.map((name) => PROVIDERS[name].fetch()));
  const parts = results.map((result, index) => {
    const provider = PROVIDERS[names[index]];
    if (result.status === 'fulfilled') return `${provider.label} ${provider.compact(result.value)}`;
    console.error(`codex-balance: ${names[index]}: ${result.reason?.message || result.reason}`);
    return `${provider.label} ?`;
  });
  console.log(parts.join(' | '));
  recordHistory(results.flatMap((result, index) => (result.status === 'fulfilled' ? [{ name: names[index], value: result.value }] : [])));
  if (results.every((result) => result.status === 'rejected')) process.exitCode = 1;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: codex-balance.js [--list-profiles] [--provider <name>[,<name>...]]');
    console.log('');
    console.log('Providers (--provider or BALANCE_PROVIDER, default all):');
    console.log('  codex     Weekly Codex limit via headless Firefox (ChatGPT login required).');
    console.log('  zai       Z.ai 5h + weekly GLM Coding Plan quotas via API key (ZAI_API_KEY).');
    console.log('  opencode  OpenCode Go 5h + weekly + monthly meters via headless Firefox (opencode.ai login).');
    console.log('  claude    Claude Code 5h + weekly limits via your Claude Code login (~/.claude/.credentials.json).');
    console.log('  all       Every provider on one line.');
    console.log('');
    console.log('Several providers (e.g. --provider claude,zai) print a compact line in the given order:');
    console.log('  C <week> | Z <5h>/<week> | O <5h>/<week>/<month> | CC <5h>/<week>');
    console.log('');
    console.log(`Every run appends the fetched meters to ${HISTORY_DB}`);
    console.log('(BALANCE_HISTORY_DB to move it, BALANCE_HISTORY=0 to turn it off).');
    return;
  }
  const { names, combined } = selectedProviders();
  if (process.argv.includes('--list-profiles')) {
    if (combined || names[0] !== 'codex') throw new Error('--list-profiles only applies to the codex provider.');
    listProfiles();
    return;
  }
  if (combined) {
    await runCombined(names);
    return;
  }
  const provider = PROVIDERS[names[0]];
  const value = await provider.fetch();
  console.log(provider.format(value));
  recordHistory([{ name: names[0], value }]);
}

main().catch((error) => {
  console.error(`codex-balance: ${error.message}`);
  process.exit(1);
});
