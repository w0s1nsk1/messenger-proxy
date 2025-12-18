require('dotenv').config();
const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { chromium } = require('playwright');
const { persistMessages } = require('./sqlite');

let alreadyPolling = false;
const app = express();
const port = process.env.PORT || 3000;
const fbEmail = process.env.FB_EMAIL;
const fbPassword = process.env.FB_PASSWORD;
const storageStatePath = process.env.STORAGE_STATE;
const messengerPin = process.env.MESSENGER_PIN;
let sendInProgress = false;
const loginMode = (process.env.LOGIN_MODE || 'credentials').toLowerCase(); // 'credentials' | 'storage-only' | 'manual'
const watchConversation = process.env.WATCH_CONVERSATION;
const watchConversationId = process.env.WATCH_CONVERSATION_ID;
const watchPollMs = Number(process.env.WATCH_POLL_MS) || 10000;
const watchLimit = Number(process.env.WATCH_LIMIT) || 10;
const watchWebhookUrl = process.env.WATCH_WEBHOOK_URL;
const errorScreenshotDir =
  process.env.ERROR_SCREENSHOT_DIR || path.resolve(process.cwd(), 'storage', 'screenshots');

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/notify', async (req, res) => {
  const { conversation, message } = req.body || {};
  if (!conversation || !message) {
    res.status(400).json({ error: 'conversation and message are required' });
    return;
  }

  try {
    const sender = app.locals.sendMessage || sendMessage;
    await sender(conversation, message);
    res.status(202).json({ status: 'queued' });
  } catch (err) {
    console.error('Notify failed', err);
    res.status(500).json({ error: 'failed to deliver' });
  }
});

async function handleMessage(event) {
  const senderId = event.sender && event.sender.id;
  const text = event.message.text || '';
  console.log(`Received from ${senderId}: ${text}`);

  const instruction = parseSendInstruction(text);
  if (!instruction) {
    const readInstruction = parseReadInstruction(text);
    if (!readInstruction) {
      return;
    }

    const messages = await readMessages(readInstruction.conversation, readInstruction.limit);
    return;
  }

  await sendMessage(instruction.conversation, instruction.message);

  // Messenger Send API call can be plugged here if needed.
}

let browser;
let context;

async function captureScreenshot(page, conversationName) {
  if (!page) return null;
  try {
    fs.mkdirSync(errorScreenshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = (conversationName || 'conversation').replace(/[^a-z0-9-_]+/gi, '_');
    const filePath = path.join(errorScreenshotDir, `${safeName}-${timestamp}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (screenshotErr) {
    console.warn('Failed to capture error screenshot', screenshotErr);
    return null;
  }
}

async function ensureLoggedIn() {
  if (browser && context) {
    return;
  }
  if (browser && !context) {
    try {
      await browser.close();
    } catch (err) {
      console.warn('Previous browser instance could not be closed cleanly', err);
    } finally {
      browser = null;
      context = null;
    }
  }

  if (loginMode === 'manual') {
    await runManualLogin();
    return;
  }

  const storageAvailable = storageStatePath && fs.existsSync(storageStatePath);

  browser = await chromium.launch({ headless: true });

  if (storageAvailable) {
    context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage('https://m.facebook.com/messages');
    await maybeDeclineOptionalCookies(page);
    await maybeHandleLastLoginsSplash(page);
    console.log(`Using storage state from ${storageStatePath}`);
    return;
  }

  if (loginMode === 'storage-only') {
    throw new Error('LOGIN_MODE=storage-only but storage state not found');
  }

  if (!fbEmail || !fbPassword) {
    console.warn('FB_EMAIL/FB_PASSWORD not set; skipping login.');
    context = await browser.newContext();
    return;
  }

  context = await browser.newContext();
  const page = await context.newPage();
  console.log('Logging into Facebook with credentials.');

  try {
    await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle' });
    await maybeDeclineOptionalCookies(page);
    await page.fill('input[name="email"]', fbEmail);
    await page.fill('input[name="pass"]', fbPassword);
    await Promise.all([
      page.click('button[name="login"]'),
      page.waitForResponse('https://www.facebook.com/')
    ]);
    console.log('Logged into Facebook personal account.');

    if (storageStatePath) {
      const state = await context.storageState();
      fs.writeFileSync(storageStatePath, JSON.stringify(state, null, 2), 'utf-8');
      console.log(`Saved storage state to ${storageStatePath}`);
    }
  } catch (err) {
    console.error('Facebook login failed', err);
  } finally {
    await page.close();
  }
}

async function runManualLogin() {
  browser = await chromium.launch({ headless: false });
  context = await browser.newContext();
  const page = await context.newPage();

  console.log('Manual login mode: log into Facebook in the opened window, then close the tab to finish.');

  try {
    await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle' });
    await page.waitForEvent('close', { timeout: 120000 });

    if (storageStatePath) {
      const state = await context.storageState();
      fs.writeFileSync(storageStatePath, JSON.stringify(state, null, 2), 'utf-8');
      console.log(`Saved storage state to ${storageStatePath}`);
    } else {
      console.warn('STORAGE_STATE not set; storage state will not be saved.');
    }
  } catch (err) {
    console.error('Manual login failed', err);
  } finally {
    await browser.close();
    console.log('Manual login mode finished. Exiting process.');
    process.exit(0);
  }
}

async function maybeUnlockWithPin(page) {
  if (!messengerPin) return;

  // The PIN prompt shows up as a dialog with multiple single-digit inputs.
  const dialogHintSelectors = [
    'text=/Wprowad.z kod PIN/i',
    'text=/kod PIN/i',
    'text=/Enter your PIN/i',
    '[role="dialog"] input[maxlength="1"]',
    '[role="dialog"] >> text=/PIN/i'
  ];

  let pinDialog = null;
  for (const selector of dialogHintSelectors) {
    pinDialog = await page.$(selector);
    if (pinDialog) break;
  }

  if (!pinDialog) {
    // As a fallback, wait briefly to see if the prompt appears right after navigation.
    for (const selector of dialogHintSelectors) {
      pinDialog = await page.waitForSelector(selector, { timeout: 8000 }).catch(() => null);
      if (pinDialog) break;
    }
  }

  if (!pinDialog) {
    console.log('PIN prompt not detected.');
    return;
  }

  console.log('PIN prompt detected, attempting to unlock.');

  try {
    // Small delay to allow all PIN inputs to render before filling.
    await page.waitForTimeout(300);
    const pinInputs = await page.$$(
      'input[autocomplete="one-time-code"], input[maxlength="1"][type="tel"], input[maxlength="1"][type="password"], input[aria-label*="PIN" i]'
    );

    if (pinInputs.length > 1) {
      for (let i = 0; i < messengerPin.length && i < pinInputs.length; i += 1) {
        await pinInputs[i].fill(messengerPin[i]);
      }
    } else if (pinInputs.length === 1) {
      await pinInputs[0].fill(messengerPin);
    } else {
      await page.keyboard.type(messengerPin);
    }

    console.log('PIN prompt handled automatically.');
    await page.waitForSelector('[role=dialog]', { timeout: 10000, state: 'detached' }).catch(() => null);
  } catch (err) {
    console.warn('Could not auto-fill PIN prompt', err);
  }
}

async function maybeHandleLastLoginsSplash(page) {
  try {
    // look for multiple hints that indicate the saved-login splash is visible
    const hintSelectors = [
      'text=/Ostatnie logowania/i',
      'text=/Last logins/i',
      'text=/Dodaj konto/i',
      '[data-testid="login_account_switcher_add_account"]'
    ];
    let splashVisible = false;
    for (const selector of hintSelectors) {
      const element = await page.$(selector);
      if (element) {
        splashVisible = true;
        break;
      }
    }
    if (!splashVisible) return;

    console.log('Detected last login splash screen, trying to bypass.');

    const addAccountSelectors = [
      '[data-testid="login_account_switcher_add_account"]',
      'text=/Dodaj konto/i',
      'text=/Add account/i',
      'text=/Use another account/i',
      'text=/Użyj innego konta/i',
      'text=/Inne konto/i'
    ];
    for (const selector of addAccountSelectors) {
      const button = await page.$(selector);
      if (!button) continue;
      await button.click();
      await page.waitForLoadState('networkidle');
      return;
    }

    const continueButtons = await page.$$('text=/Zaloguj sie|Zaloguj się|Continue/i');
    if (continueButtons.length) {
      await continueButtons[0].click();
      await page.waitForLoadState('networkidle');
    }
  } catch (err) {
    console.warn('Could not bypass last login splash', err);
  }
}

async function maybeDeclineOptionalCookies(page) {
  try {
    const declineButton = await page.$('text="Decline optional cookies"');
    if (declineButton) {
      await declineButton.click();
    }
  } catch (err) {
    console.warn('Could not interact with cookie banner', err);
  }
}

function parseSendInstruction(text) {
  if (!text) return null;
  const match = text.match(/^send\s+(.+?)\s*::\s*(.+)$/i);
  if (!match) return null;
  return { conversation: match[1].trim(), message: match[2].trim() };
}

function parseReadInstruction(text) {
  if (!text) return null;
  const match = text.match(/^read\s+(.+?)(?:\s*::\s*(\d+))?$/i);
  if (!match) return null;
  return { conversation: match[1].trim(), limit: match[2] ? Number(match[2]) : 5 };
}

function diffMessages(prevLastKey, messages) {
  const keys = messages.map((m) => `${m.sender || ''}:${m.text}`);
  const lastIndex = prevLastKey ? keys.lastIndexOf(prevLastKey) : -1;
  const newMessages = lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
  const lastSeenKey = messages.length ? keys[keys.length - 1] : prevLastKey;
  return { newMessages, lastSeenKey };
}

function dedupeMessages(messages) {
  const seen = new Set();
  const result = [];
  // iterate from end to keep latest occurrence, then reverse at the end
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const key = `${messages[i].sender || ''}:${messages[i].text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(messages[i]);
  }
  return result.reverse();
}

function filterMessages(messages) {
  if (!messages || !messages.length) return [];
  const ignorePatterns = [
    /Wiadomości i połączenia są zabezpieczone pełnym szyfrowaniem/i,
    /^Otw[oó]rz$/i,
    /^Dowiedz się więcej$/i,
    /^Wprowadź kod PIN/i,
    /^Odpowiedz\??$/i,
    /^\d{1,2}:\d{2}$/,
    /^(Pon|Wt|Śr|Sro|Czw|Pt|Sob|Nd|Niedz|Sun|Mon|Tue|Wed|Thu|Fri|Sat)[, ]+\d{1,2}:\d{2}$/i,
    /Powiadomienia push są wyłączone/i,
    /Włącz powiadomienia, aby być na bieżąco/i,
    /^Włącz$/i,
    /^Nie teraz$/i
  ];
  return messages.filter((m) => m.text && !ignorePatterns.some((re) => re.test(m.text)));
}

function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function postJson(urlString, data) {
  return new Promise((resolve, reject) => {
    if (!urlString) {
      resolve();
      return;
    }

    try {
      const body = JSON.stringify(data || {});
      const parsed = new URL(urlString);
      const isHttp = parsed.protocol === 'http:';
      const client = isHttp ? http : https;
      const options = {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = client.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            const responseBody = Buffer.concat(chunks).toString();
            reject(new Error(`Webhook responded with ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function waitForSearchInput(page) {
  const searchSelectors = [
    'input[name="query"]',
    'input[placeholder*="Szukaj w Messengerze"]',
    'input[aria-label="Szukaj w Messengerze"]',
    'input[placeholder*="Search Messenger"]',
    'input[aria-label="Search Messenger"]'
  ];
  for (const selector of searchSelectors) {
    const input = await page.$(selector);
    if (input) return input;
  }
  const locator = page.locator(searchSelectors.join(','));
  await locator.first().waitFor({ state: 'visible', timeout: 15000 });
  return locator.first();
}

async function clickConversation(page, target) {
  const buildSelectors = () => {
    const candidates = [];
    if (target.id) {
      candidates.push(
        `a[href$="/${target.id}/"]`,
        `a[href*="${target.id}"]`,
        `div[role="row"] a[href*="${target.id}"]`,
        `div[role="gridcell"] a[href*="${target.id}"]`
      );
    }
    if (target.name) {
      candidates.push(
        `a:has-text("${target.name}")`,
        `div[role="row"]:has-text("${target.name}")`,
        `div[role="gridcell"]:has-text("${target.name}")`
      );
    }
    return candidates;
  };

  const trySelectors = async () => {
    const candidates = buildSelectors();
    for (const selector of candidates) {
      console.log(`Trying selector: ${selector}`);
      const loc = page.locator(selector);
      console.log(`Found ${await loc.count()} elements for selector "${selector}"`);
      const count = await loc.count();
      if (count === 0) continue;
      const ariaCurrent = await loc.first().getAttribute('aria-current');
      if (ariaCurrent === 'page') {
        return true;
      }
      try {
        await loc.first().waitFor({ state: 'visible', timeout: 15000 });
        await loc.first().click({ timeout: 15000 });
        return true;
      } catch (err) {
        console.warn('Normal click failed, retrying with force', err);
        try {
          await loc.first().click({ timeout: 10000, force: true });
          return true;
        } catch {
          try {
            await loc.first().evaluate((el) => el.click());
            return true;
          } catch {
            const href = await loc.first().getAttribute('href');
            if (href) {
              const absolute = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
              await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 30000 });
              return true;
            }
          }
        }
      }
    }
    return false;
  };

  const selectorsWorked = await trySelectors();
  if (selectorsWorked) return;

  if (target.name || target.id) {
    const searchValue = target.name || target.id;
    try {
      console.log(`Trying Messenger search for "${searchValue}"`);
      const input = await waitForSearchInput(page);
      await input.fill('');
      await input.type(searchValue, { delay: 50 });
      await page.waitForTimeout(1000);
      const searched = await trySelectors();
      if (searched) return;
    } catch (err) {
      console.warn('Search attempt failed', err);
    }
  }

  throw new Error(`Conversation "${target.name || target.id}" not found`);
}

async function navigateToMessages(page) {
  try {
    await page.goto('https://m.facebook.com/messages', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.warn('Navigation to messages hit timeout, continuing', err);
  }
  await maybeUnlockWithPin(page);
}

function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')            // split accents from base characters
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function isInConversation(page, target) {
  const url = page.url();
  if (target.id && url.includes(target.id)) {
    return true;
  }

  const targetName = target.name ? normalizeText(target.name) : null;
  const ariaCandidate = await page.$(
    `[aria-label*="konwersacji z"], [aria-label*="ForestLand*"], [aria-label*="Messages in conversation with"], [aria-label*="Conversation with"]`
  );
  if (ariaCandidate) {
    const label = await ariaCandidate.getAttribute('aria-label');
    const norm = normalizeText(label);
    if ((targetName && norm.includes(targetName)) || (target.id && norm.includes(target.id))) return true;
  }

  const heading = await page.$('h1 span, h1 div, h2 span, h2 div');
  if (heading) {
    const text = await heading.textContent();
    const norm = normalizeText(text);
    if ((targetName && norm.includes(targetName)) || (target.id && norm.includes(target.id))) return true;
  }

  return false;
}

function resolveConversationTarget(value) {
  if (!value) return { name: null, id: null };
  const isId = /^\d{6,}$/.test(value);
  return isId ? { id: value, name: null } : { name: value, id: null };
}

async function sendMessage(conversationName, messageText) {
  await ensureLoggedIn();
  const page = await context.newPage();
  let screenshotPath = null;
  sendInProgress = true;

  try {
    await navigateToMessages(page);
    const target = resolveConversationTarget(conversationName);
    const alreadyThere = await isInConversation(page, target);
    if (!alreadyThere) {
      await clickConversation(page, target);
    }
    await maybeUnlockWithPin(page);

    const composerSelectors = [
      'textarea[name="body"]',
      'div[role="textbox"]',
      'div[aria-label="Wiadomość"]',
      'div[contenteditable="true"]'
    ];
    let composer = null;
    for (const selector of composerSelectors) {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) continue;
      try {
        await loc.waitFor({ state: 'visible', timeout: 15000 });
        await loc.scrollIntoViewIfNeeded();
        try {
          await loc.click({ timeout: 5000 });
        } catch (clickErr) {
          console.warn('Composer click intercepted, retrying with force', clickErr);
          await loc.click({ timeout: 5000, force: true });
        }
        composer = loc;
        break;
      } catch {
        continue;
      }
    }

    if (!composer) {
      throw new Error('Composer not found');
    }

    const canFill = await composer.evaluate((node) => node.isContentEditable || 'value' in node);
    if (canFill) {
      await composer.fill(messageText);
    } else {
      await page.keyboard.type(messageText);
    }

    const sendSelectors = ['button[type="submit"]', 'button[name="Send"]', 'button:has-text("Send")', 'a:has-text("Send")'];
    let sent = false;
    for (const selector of sendSelectors) {
      const sendButton = await page.$(selector);
      if (sendButton) {
        await sendButton.click();
        sent = true;
        break;
      }
    }

    if (!sent) {
      // fallback: Enter often sends on m.facebook after focus
      await page.keyboard.press('Enter');
    }
    // Wait briefly for send confirmation to reduce double-sends.
    const sendStateSelector = 'text=/Wys[łl]ano|Sent/i';
    const sendingSelector = 'text=/Wys[łl]anie/i';
    const sendState = await page.waitForSelector(`${sendStateSelector}, ${sendingSelector}`, { timeout: 8000 }).catch(() => null);
    if (sendState) {
      // If we caught the "sending" state, wait for it to disappear.
      const text = await sendState.textContent().catch(() => '');
      if (text && /Wys[łl]anie/i.test(text)) {
        await sendState.waitForElementState('detached', { timeout: 5000 }).catch(() => null);
      }
    }

    screenshotPath = await captureScreenshot(page, conversationName);
    if (screenshotPath) {
      console.log(`Sent message to "${conversationName}" (screenshot saved to ${screenshotPath})`);
    } else {
      console.log(`Sent message to "${conversationName}"`);
    }
  } catch (err) {
    screenshotPath = await captureScreenshot(page, conversationName);
    if (screenshotPath) {
      console.error(
        `Failed to send message to "${conversationName}" (screenshot saved to ${screenshotPath})`,
        err
      );
    } else {
      console.error(`Failed to send message to "${conversationName}"`, err);
    }
  } finally {
    sendInProgress = false;
    await page.close();
  }
}

async function readMessages(conversationName, limit = 5) {
  await ensureLoggedIn();
  const page = await context.newPage();

  try {
    await navigateToMessages(page);
    const target = resolveConversationTarget(conversationName);
    const alreadyThere = await isInConversation(page, target);
    if (!alreadyThere) {
      await clickConversation(page, target);
    }
    await maybeUnlockWithPin(page);

    await page.waitForTimeout(2000); // wait for messages to load
    const messages = await page.$$eval('div[role="row"]', (rows, lim) => {
      const collected = [];

      const pickSender = (row) => {
        const avatar = row.querySelector('img[alt]');
        if (avatar && avatar.getAttribute('alt')) {
          const alt = avatar.getAttribute('alt').trim();
          if (alt) return alt;
        }
        const senderEl = row.querySelector('h5 span, h5 div, h5');
        const raw = senderEl ? senderEl.textContent.trim() : null;
        if (!raw) return null;
        if (/wys[łl]ano/i.test(raw)) return 'me';
        return raw;
      };

      rows.forEach((row) => {
        const sender = pickSender(row);
        const textEls = row.querySelectorAll('div[dir="auto"], span[dir="auto"]');
        const texts = Array.from(textEls)
          .map((n) => n.textContent.trim())
          .filter(Boolean);
        const filteredTexts = texts.filter((t) => t !== sender && !/wys[łl]ano/i.test(t));
        if (!filteredTexts.length) return;
        filteredTexts.forEach((text) => collected.push({ sender, text }));
      });

      // If earlier messages missed a sender but a newer one has it, assume they came from the same person.
      let lastKnownSender = null;
      for (let i = collected.length - 1; i >= 0; i -= 1) {
        if (collected[i].sender) {
          lastKnownSender = collected[i].sender;
          continue;
        }
        if (lastKnownSender) {
          collected[i].sender = lastKnownSender;
        }
      }

      // Fallback to legacy mobile selector if nothing found.
      if (!collected.length) {
        document.querySelectorAll('div[data-sigil="message-text"]').forEach((n) => {
          const text = (n.textContent || '').trim();
          if (text) collected.push({ sender: null, text });
        });
      }

      return collected.slice(-lim);
    }, limit);

    const deduped = dedupeMessages(messages);
    const filtered = filterMessages(deduped);
    console.log(
      `Read ${messages.length} messages from "${conversationName}" (deduped to ${deduped.length}, filtered ${
        deduped.length - filtered.length
      })`
    );
    return filtered;
  } catch (err) {
    const screenshotPath = await captureScreenshot(page, conversationName);
    if (screenshotPath) {
      console.error(
        `Failed to read messages from "${conversationName}" (screenshot saved to ${screenshotPath})`,
        err
      );
    } else {
      console.error(`Failed to read messages from "${conversationName}"`, err);
    }
    return null;
  } finally {
    await page.close();
  }
}

async function sendWatchWebhook(conversationRef, messages) {
  if (!watchWebhookUrl || !messages || !messages.length) return;
  for (const message of messages) {
    const payload = {
      conversation: {
        key: conversationRef.key,
        id: conversationRef.id,
        name: conversationRef.name
      },
      message
    };
    try {
      await postJson(watchWebhookUrl, payload);
    } catch (err) {
      console.error('Failed to deliver watch webhook payload', err);
    }
  }
}

function start() {
  if (loginMode === 'manual') {
    runManualLogin();
    return;
  }

  const server = app.listen(port, () => {
    console.log(`Messenger proxy listening on :${port}`);
  });

  // Optional background watcher to log incoming messages from a conversation.
  const watchTargetValue = watchConversationId || watchConversation;
  if (watchTargetValue) {
    const watchConversationRef = {
      key: watchTargetValue,
      id: watchConversationId || null,
      name: watchConversation || null
    };
    const lastSeen = new Map();
    const poll = async () => {
      if (alreadyPolling) return;
      alreadyPolling = true;
      try {
        if (sendInProgress) {
          alreadyPolling = false;
          return;
        }
        const messages = await readMessages(watchTargetValue, watchLimit);
        if (!messages || !messages.length) {
          alreadyPolling = false;
          return;
        }
        const { newMessages, lastSeenKey } = diffMessages(lastSeen.get(watchTargetValue), messages);
        if (newMessages.length) {
          console.log(newMessages);
          newMessages.forEach((m) => console.log(`[Incoming][${m.sender || watchTargetValue}] ${m.text}`));
          await persistMessages(watchConversationRef, newMessages);
          await sendWatchWebhook(watchConversationRef, newMessages);
        }
        lastSeen.set(watchTargetValue, lastSeenKey);
        alreadyPolling = false;
      } catch (err) {
        console.error('Watcher error', err);
      }
    };
    poll();
    setInterval(poll, watchPollMs);
  }

  async function shutdown() {
    if (browser) {
      await browser.close();
    }
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, parseSendInstruction, parseReadInstruction, ensureLoggedIn, sendMessage, diffMessages };
