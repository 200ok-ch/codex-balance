#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CODEX_URL = 'https://chatgpt.com/codex/cloud/settings/analytics';
const TIMEOUT_MS = Number(process.env.CODEX_BALANCE_TIMEOUT_MS || 6000);
const DEFAULT_PROFILE_INIS = [
  path.join(os.homedir(), '.mozilla', 'firefox', 'profiles.ini'),
  path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox', 'profiles.ini'),
];
const PROFILE_INI = process.env.FIREFOX_PROFILES_INI || DEFAULT_PROFILE_INIS.find((candidate) => fs.existsSync(candidate)) || DEFAULT_PROFILE_INIS[0];
const FIREFOX_EXECUTABLE = process.env.FIREFOX_EXECUTABLE;

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

function chatgptCookieHosts(profileDir) {
  const source = path.join(profileDir, 'cookies.sqlite');
  if (!fs.existsSync(source)) return [];

  const copied = copyCookieDatabase(profileDir);
  try {
    const now = Math.floor(Date.now() / 1000);
    const output = execFileSync('sqlite3', [
      '-json',
      copied.database,
      `select distinct host
       from moz_cookies
       where (host like '%chatgpt.com' or host like '%openai.com')
         and (expiry = 0 or expiry > ${now})
       order by host`,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });

    return (output.trim() ? JSON.parse(output) : []).map((row) => row.host);
  } finally {
    fs.rmSync(copied.tmpRoot, { recursive: true, force: true });
  }
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

function firefoxCookies(profileDir) {
  const copied = copyCookieDatabase(profileDir);

  try {
    const now = Math.floor(Date.now() / 1000);
    let output;
    try {
      output = execFileSync('sqlite3', [
        '-json',
        copied.database,
        `select name, value, host, path, expiry, isSecure, isHttpOnly
         from moz_cookies
         where (host like '%chatgpt.com' or host like '%openai.com')
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

    if (!cookies.some((cookie) => cookie.domain.includes('chatgpt.com'))) {
      throw new Error(`No chatgpt.com cookies found in the selected Firefox profile. Sign in to ChatGPT in Firefox first, or set FIREFOX_PROFILE_DIR to a Firefox profile that is signed in to ChatGPT.`);
    }

    return cookies;
  } finally {
    fs.rmSync(copied.tmpRoot, { recursive: true, force: true });
  }
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function formatBalance({ weekly }) {
  return `week: ${weekly || 'n/a'}`;
}

function percent(value) {
  if (typeof value === 'number') return `${Math.round(value)}%`;
  if (typeof value === 'string') return value.endsWith('%') ? value : `${value}%`;
  return null;
}

function parseUsageJson(json) {
  const windows = [json?.rate_limit?.primary_window, json?.rate_limit?.secondary_window].filter(Boolean);
  const remainingForDuration = (seconds) => {
    const window = windows.find((candidate) => candidate.limit_window_seconds === seconds);
    if (typeof window?.used_percent !== 'number') return null;
    return percent(Math.max(0, 100 - window.used_percent));
  };
  const weekly = remainingForDuration(7 * 24 * 60 * 60);

  if (weekly) return { weekly };

  const text = JSON.stringify(json);
  const weeklyFallback = text.match(/"(?:remaining_percentage|remaining_percent|percent_remaining|percentage_remaining|remaining)"\s*:\s*(\d+(?:\.\d+)?).*?"(?:weekly|week)/i)?.[1];

  if (weeklyFallback) return { weekly: percent(Number(weeklyFallback)) };

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

  if (weeklyCandidate) {
    return { weekly: percent(weeklyCandidate.value) };
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
  const weekly = bodyText.match(/Weekly\s+usage\s+limit\s+(\d+%)\s+remaining/i)?.[1];

  if (!weekly) {
    throw new Error('Could not parse balance values from the Codex analytics page.');
  }

  return { weekly };
}

async function main() {
  if (process.argv.includes('--list-profiles')) {
    listProfiles();
    return;
  }

  const sourceProfile = defaultFirefoxProfileDir();
  const cookies = firefoxCookies(sourceProfile);

  const { playwright, source } = loadPlaywright();
  const { firefox } = playwright;
  const executablePath = FIREFOX_EXECUTABLE || (source === 'system' ? installedPlaywrightFirefoxExecutable() : undefined);
  let browser;

  try {
    const launchOptions = {
      headless: true,
      timeout: TIMEOUT_MS,
    };
    if (executablePath) launchOptions.executablePath = executablePath;

    browser = await firefox.launch(launchOptions);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const { weekly } = await extractBalances(page);
    console.log(formatBalance({ weekly }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`codex-balance: ${error.message}`);
  process.exit(1);
});
