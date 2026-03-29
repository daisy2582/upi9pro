/**
 * Background service worker for Agent Withdrawal Automation
 */

let isRunning = false;
let settings = null;
let statusLog = [];

// GatewayHub keys (UPI 9 Pro)
const GATEWAYHUB_PUBLIC_KEY = '2685f162836f1fa163014ee9b7d375f7e07440409379618d32a7684d250b20f8_1771317918656';
const GATEWAYHUB_PRIVATE_KEY = '08b64e868c2088efbfadf37c937a38c49a0660f142eb8f8d41eb9fcd9fe1e31b_1771317918656';
// Architecture: Reader tab is persistent; mismatch uses fresh tab per batch (open → process → close)
let readerLoopTimer = null;      // Timer for Tab 1 (row reading) loop
let mismatchPollTimer = null;    // Timer for mismatch polling loop
let readerTabId = null;          // Tab 1: flat + crypto row reading → DB/GatewayHub
let creatingReaderTab = false;   // Lock to prevent concurrent reader tab creation
let readerLoopBusy = false;     // Lock to prevent overlapping reader loop iterations (and duplicate runProcessCycle)
let mismatchPollBusy = false;   // Lock to prevent overlapping mismatch poll cycles
const MISMATCH_POLL_INTERVAL_MS = 1 * 60 * 1000; // 1 minute — mismatch clearing is priority
const MISMATCH_PARALLEL_TABS = 5;  // Max tabs open at the same time
const MISMATCH_ORDERS_PER_TAB = 3; // Orders processed sequentially per tab (5 tabs × 3 orders = 15 per batch)
const MISMATCH_INTER_ORDER_DELAY_MS = 3000; // 3s between orders within a tab
const MISMATCH_INTER_BATCH_DELAY_MS = 10000; // 10s between parallel batches
const PROCESS_INTERVAL_MS = 30 * 1000; // 30 sec delay between reader loop runs — avoids triggering panel rate limiter
const CRYPTO_PAGE_SWITCH_INTERVAL_MS = 5 * 60 * 1000; // Switch to crypto page every 5 minutes
let lastCryptoPageVisitAt = 0; // Timestamp of last crypto page visit

const LOG_PREFIX = '🔵 AGENT-WITHDRAWAL';

function logToPage(msg, level = 'info', stepName = null, details = null) {
  const detailsStr = details != null ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null;
  const payload = { action: 'logFromBackground', msg, level, stepName, details: detailsStr };
  // Send to reader tab so F12 shows all logs
  if (readerTabId) chrome.tabs.sendMessage(readerTabId, payload).catch(() => {});
}

function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  statusLog.push(line);
  if (statusLog.length > 100) statusLog.shift();
  const out = `${LOG_PREFIX} [${ts}] ${msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
  logToPage(msg, level);
}

function logStep(stepName, details) {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`${LOG_PREFIX} ========== ${stepName} ==========`);
  if (details != null) {
    if (typeof details === 'object') {
      console.log(`${LOG_PREFIX}`, details);
    } else {
      console.log(`${LOG_PREFIX}`, details);
    }
  }
  console.log(`${LOG_PREFIX} ========================================`);
  statusLog.push(`[${ts}] ${stepName}: ${typeof details === 'object' ? JSON.stringify(details) : details}`);
  if (statusLog.length > 100) statusLog.shift();
  logToPage(stepName, 'info', stepName, details);
}

async function loadSettings() {
  log('[loadSettings] Loading settings from chrome.storage.local...');
  const r = await chrome.storage.local.get([
    'panelUsername', 'panelPassword', 'dbApiUrl', 'loginGroupKey', 'gatewayhubUserId'
  ]);
  log(`[loadSettings] Raw storage values:`, 'info');
  log(`[loadSettings]   - panelUsername: ${r.panelUsername ? `${r.panelUsername.substring(0, 5)}*** (${r.panelUsername.length} chars)` : 'NOT SET'}`);
  log(`[loadSettings]   - panelPassword: ${r.panelPassword ? '*** SET' : 'NOT SET'}`);
  log(`[loadSettings]   - dbApiUrl: ${r.dbApiUrl || 'NOT SET (will use default)'}`);
  log(`[loadSettings]   - loginGroupKey: ${r.loginGroupKey || 'NOT SET'}`);
  log(`[loadSettings]   - gatewayhubUserId: ${r.gatewayhubUserId || 'NOT SET (will use default: 1)'}`);
  
  settings = {
    panelUsername: r.panelUsername || '',
    panelPassword: r.panelPassword || '',
    dbApiUrl: (r.dbApiUrl || 'https://autoflow-ce-api.botauto.online').replace(/\/$/, ''),
    gatewayhubPublicKey: GATEWAYHUB_PUBLIC_KEY,
    gatewayhubPrivateKey: GATEWAYHUB_PRIVATE_KEY,
    loginGroupKey: r.loginGroupKey || null,
    gatewayhubUserId: r.gatewayhubUserId || 1
  };
  
  log(`[loadSettings] Final settings object:`, 'info');
  log(`[loadSettings]   - dbApiUrl: ${settings.dbApiUrl}`);
  log(`[loadSettings]   - panelUsername: ${settings.panelUsername ? `${settings.panelUsername.substring(0, 5)}***` : '(empty)'}`);
  log(`[loadSettings]   - panelPassword: ${settings.panelPassword ? 'SET' : '(empty)'}`);
  log(`[loadSettings]   - loginGroupKey: ${settings.loginGroupKey || 'none'}`);
  log(`[loadSettings]   - gatewayhubUserId: ${settings.gatewayhubUserId}`);
  log(`[loadSettings]   - gatewayhubPublicKey: ${settings.gatewayhubPublicKey ? `${settings.gatewayhubPublicKey.substring(0, 20)}...` : 'NOT SET'}`);
  log(`[loadSettings]   - gatewayhubPrivateKey: ${settings.gatewayhubPrivateKey ? 'SET' : 'NOT SET'}`);
  log(`[loadSettings] Settings loaded successfully`);
  return settings;
}

/**
 * Wait for a tab to finish loading (status = 'complete').
 * Shared helper used by both getOrCreateReaderTab and getOrCreateMismatchTab.
 */
async function waitForTabComplete(tabId, timeoutMs = 15000) {
  let status;
  try { status = (await chrome.tabs.get(tabId)).status; } catch { return; }
  if (status === 'complete') return;
  log(`[waitForTabComplete] Waiting for tab ${tabId} to finish loading...`);
    await new Promise((resolve) => {
      const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
        log(`[waitForTabComplete] Tab ${tabId} finished loading`);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
      log(`[waitForTabComplete] Tab ${tabId} load timeout after ${timeoutMs}ms (continuing anyway)`, 'warn');
        resolve();
    }, timeoutMs);
  });
}

/**
 * Tab 1 — Reader Tab: flat + crypto row reading → DB / GatewayHub.
 * Prefers an existing tab already on withdrawals page (so your open tab is used).
 * Otherwise creates the tab in the background (active: false). Reuses stored readerTabId if still alive.
 */
async function getOrCreateReaderTab() {
  log('[getOrCreateReaderTab] Ensuring reader tab...');
  
  // Check if tab is already being created (prevent concurrent creation)
  if (creatingReaderTab) {
    log('[getOrCreateReaderTab] Tab creation already in progress, waiting...');
    // Wait for creation to complete
    for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
      if (readerTabId && !creatingReaderTab) {
        try {
          const t = await chrome.tabs.get(readerTabId);
          if (t && !t.discarded) {
            log(`[getOrCreateReaderTab] Tab creation completed, using id=${readerTabId}`);
            return t;
          }
        } catch (e) {
          // Tab creation failed, continue to create new one
          break;
        }
      }
    }
    log('[getOrCreateReaderTab] Timeout waiting for tab creation, will create new one', 'warn');
  }
  
  if (readerTabId) {
    try {
      const t = await chrome.tabs.get(readerTabId);
      if (t && !t.discarded) {
        log(`[getOrCreateReaderTab] Reusing existing reader tab id=${readerTabId}`);
        await ensureContentScriptInjected(readerTabId);
        return t;
      }
    } catch (e) {
      log(`[getOrCreateReaderTab] Stored readerTabId=${readerTabId} is gone: ${e.message} — will find or create`, 'warn');
      readerTabId = null;
    }
  }
  // Prefer an existing tab already on the withdrawals page with Reader Tab title
  // Check for tab with "Reader Tab" in title to avoid reusing mismatch tab
  try {
    const tabs = await chrome.tabs.query({ url: 'https://agent.upi9.pro/*' });
    // First, try to find a tab with "Reader Tab" in title
    for (const tab of tabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title
        });
        if (results && results[0] && results[0].result && results[0].result.includes('Reader Tab')) {
          readerTabId = tab.id;
          chrome.storage.local.set({ readerTabId });
          log(`[getOrCreateReaderTab] Found existing Reader Tab id=${readerTabId}`);
          await ensureContentScriptInjected(readerTabId);
          return await chrome.tabs.get(readerTabId);
        }
      } catch (e) {
        // Tab might not be accessible, skip it
        continue;
      }
    }
    // If no Reader Tab found, check for withdrawals page tab
    const withdrawalsTab = tabs.find(t => {
      const url = t.url || '';
      return url.includes('withdrawl');
    });
    if (withdrawalsTab) {
      readerTabId = withdrawalsTab.id;
      chrome.storage.local.set({ readerTabId });
      log(`[getOrCreateReaderTab] Using existing withdrawals tab id=${readerTabId}`);
      await ensureContentScriptInjected(readerTabId);
      chrome.scripting.executeScript({
        target: { tabId: readerTabId },
        func: () => { document.title = '📖 BOT – Reader Tab'; }
      }).catch(() => {});
      return await chrome.tabs.get(readerTabId);
    }
  } catch (e) {
    log(`[getOrCreateReaderTab] Query for existing tab failed: ${e.message}`, 'warn');
  }
  // Before creating, check if there are already bot tabs open (prevent duplicates)
  try {
    const allTabs = await chrome.tabs.query({ url: 'https://agent.upi9.pro/*' });
    const botTabs = [];
    for (const tab of allTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title
        });
        if (results && results[0] && results[0].result) {
          const title = results[0].result;
          if (title.includes('Reader Tab')) {
            botTabs.push({ id: tab.id, type: 'reader' });
          } else if (title.includes('Mismatch Tab')) {
            botTabs.push({ id: tab.id, type: 'mismatch' });
          }
        }
      } catch (e) {
        // Tab not accessible, skip
      }
    }
    
    // If we already have a reader tab, use it
    const existingReaderTab = botTabs.find(t => t.type === 'reader');
    if (existingReaderTab) {
      readerTabId = existingReaderTab.id;
      chrome.storage.local.set({ readerTabId });
      log(`[getOrCreateReaderTab] Found existing Reader Tab id=${readerTabId}, reusing it`);
      await ensureContentScriptInjected(readerTabId);
      return await chrome.tabs.get(readerTabId);
    }
    
    // If no reader tab found but there are agent tabs, use the first available one
    if (allTabs.length >= 1 && !existingReaderTab) {
      const tabToUse = allTabs[0];
      if (tabToUse) {
        readerTabId = tabToUse.id;
        chrome.storage.local.set({ readerTabId });
        log(`[getOrCreateReaderTab] Reusing existing tab as Reader (only 2 tabs) id=${readerTabId}`);
        await ensureContentScriptInjected(readerTabId);
        await chrome.scripting.executeScript({
          target: { tabId: readerTabId },
          func: () => { document.title = '📖 BOT – Reader Tab'; }
        }).catch(() => {});
        return await chrome.tabs.get(readerTabId);
      }
    }
  } catch (e) {
    log(`[getOrCreateReaderTab] Error checking existing tabs: ${e.message}`, 'warn');
  }
  
  // Set lock to prevent concurrent creation
  creatingReaderTab = true;
  try {
    log('[getOrCreateReaderTab] Creating new reader tab (background)...');
    const tab = await chrome.tabs.create({ url: 'https://agent.upi9.pro/withdrawls/', active: false });
    readerTabId = tab.id;
    chrome.storage.local.set({ readerTabId });
    log(`[getOrCreateReaderTab] Created reader tab id=${readerTabId}`);
    // Set title for identification
    chrome.scripting.executeScript({
      target: { tabId: readerTabId },
      func: () => { document.title = '📖 BOT – Reader Tab'; }
    }).catch(() => {});
    await waitForTabComplete(readerTabId);
    // Disable bfcache to prevent "extension port moved into back/forward cache" error
    try {
      await chrome.scripting.executeScript({
        target: { tabId: readerTabId },
        func: () => { window.addEventListener('unload', () => {}); },
      });
    } catch {}
    await ensureContentScriptInjected(readerTabId);
    await new Promise(r => setTimeout(r, 300));
    log(`[getOrCreateReaderTab] Reader tab ready id=${readerTabId}`);
    return await chrome.tabs.get(readerTabId);
  } finally {
    creatingReaderTab = false;
  }
}

/**
 * Creates a fresh mismatch tab, disables bfcache, injects content script, and returns tabId.
 * Caller MUST close the tab when done (via closeMismatchTab).
 * Modeled after depositflow-ce: open → process → close.
 */
async function createFreshMismatchTab(url = 'https://agent.upi9.pro/withdrawls/') {
  log(`[createFreshMismatchTab] Creating fresh tab for: ${url}`);
  // MUST be active: true — Chrome throttles background tabs (DOM clicks/scrolls don't work)
  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = tab.id;
  log(`[createFreshMismatchTab] Created tab id=${tabId}`);

  // Wait for page to fully load
  await waitForTabComplete(tabId, 20000);

  // Disable bfcache to prevent "extension port moved into back/forward cache" error
  // (from depositflow-ce pattern)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.addEventListener('unload', () => {}); },
    });
  } catch {}

  // Set title for identification
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { document.title = '⚡ BOT – Mismatch Tab (temp)'; }
    });
  } catch {}

  // Inject content script
  await ensureContentScriptInjected(tabId);
  await new Promise(r => setTimeout(r, 500));

  log(`[createFreshMismatchTab] Tab id=${tabId} ready`);
  return tabId;
}

/**
 * Close a mismatch tab. Always call this after processing a batch.
 */
async function closeMismatchTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
    log(`[closeMismatchTab] Closed tab id=${tabId}`);
  } catch (e) {
    log(`[closeMismatchTab] Failed to close tab ${tabId}: ${e.message}`, 'warn');
  }
}

async function ensureContentScriptInjected(tabId) {
  try {
    // Ping first — if content script already loaded (e.g. from manifest), skip injection to avoid "LOG_PREFIX already declared"
    try {
      const pingResponse = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
        setTimeout(() => reject(new Error('Ping timeout')), 3000);
      });
      if (pingResponse) {
        log(`[ensureContentScriptInjected] Content script already running (ping OK), skipping inject`);
        return true;
      }
    } catch (_) {
      /* ping failed, need to inject */
    }

    log(`[ensureContentScriptInjected] Attempting to inject content.js into tab ${tabId}...`);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    log(`[ensureContentScriptInjected] Content script injected successfully into tab ${tabId}`);
    log(`[ensureContentScriptInjected] Waiting 1s for content script to initialize...`);
    await new Promise(r => setTimeout(r, 1000));
    
    log(`[ensureContentScriptInjected] Verifying content script is responding...`);
    try {
      const pingResponse = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
        setTimeout(() => reject(new Error('Ping timeout')), 5000);
      });
      log(`[ensureContentScriptInjected] ✅ Content script ping SUCCESS: ${JSON.stringify(pingResponse)}`);
    } catch (pingError) {
      log(`[ensureContentScriptInjected] ❌ Content script ping FAILED: ${pingError.message}`, 'error');
    }
    
    return true;
  } catch (e) {
    log(`[ensureContentScriptInjected] Failed to inject content script into tab ${tabId}: ${e.message}`, 'error');
    return false;
  }
}

async function sendToContent(tabId, action, data = {}, retried = false, customTimeoutMs = null) {
  const dataStr = Object.keys(data).length > 0 ? ` with data: ${JSON.stringify(data).substring(0, 100)}` : '';
  log(`[sendToContent] Sending to tab ${tabId}: action=${action}${dataStr}${retried ? ' (retry)' : ''}`);
  const startTime = Date.now();
  
  // Add timeout to prevent hanging forever
  // extractAllRows can take 5–10 min (many rows × search + View Details); 10 min so we don't cut off mid-cycle
  const timeoutMs = customTimeoutMs ?? (action === 'extractAllRows' ? 600000 : action === 'searchAndClickAction' ? 30000 : 10000);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`sendToContent timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  
  const messagePromise = new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action, ...data }, (response) => {
      const elapsed = Date.now() - startTime;
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        log(`[sendToContent] Error after ${elapsed}ms: ${errMsg}`, 'error');
        const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(errMsg);
        if (noReceiver && !retried) {
          log(`[sendToContent] Content script not loaded (${errMsg}), attempting injection...`, 'warn');
          ensureContentScriptInjected(tabId).then((ok) => {
            if (ok) {
              log(`[sendToContent] Content script injected successfully, retrying ${action} after 1s...`);
              setTimeout(() => {
                sendToContent(tabId, action, data, true).then(resolve).catch(reject);
              }, 1000);
            } else {
              log(`[sendToContent] Content script injection failed for ${action}`, 'error');
              reject(new Error(errMsg));
            }
          }).catch((e) => {
            log(`[sendToContent] Content script injection error: ${e.message}`, 'error');
            reject(new Error(errMsg));
          });
        } else {
          log(`[sendToContent] Content script error for ${action} (retried=${retried}): ${errMsg}`, 'error');
          reject(new Error(errMsg));
        }
        return;
      }
      if (!response) {
        log(`[sendToContent] No response from content script for ${action} after ${elapsed}ms`, 'warn');
        resolve(null);
        return;
      }
      const responseStr = typeof response === 'object' ? JSON.stringify(response).substring(0, 150) : String(response);
      log(`[sendToContent] Page responded to ${action} after ${elapsed}ms: ${responseStr}`);
      resolve(response);
    });
  });
  
  return Promise.race([messagePromise, timeoutPromise]);
}

async function proxyFetch(url, options = {}) {
  const method = options.method || 'GET';
  const shortUrl = url.replace(/^https?:\/\/[^/]+/, '');
  log(`API: ${method} ${shortUrl}`);
  const start = Date.now();
  try {
  const res = await fetch(url, {
    method,
    headers: options.headers || {},
    body: options.body
  });
  const text = await res.text();
  const ms = Date.now() - start;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  log(`API: ${method} ${shortUrl} → ${res.status} (${ms}ms)`);
  if (res.status >= 400 && data) {
    logStep(`HTTP ERROR ${res.status}`, { url: shortUrl, status: res.status, body: data });
  }
  return { ok: res.ok, status: res.status, data };
  } catch (error) {
    const ms = Date.now() - start;
    log(`API: ${method} ${shortUrl} → ERROR (${ms}ms): ${error.message}`, 'error');
    // Return error response instead of throwing
    return { 
      ok: false, 
      status: 0, 
      data: { error: error.message || 'Network error', type: 'fetch_error' } 
    };
  }
}

function sha256Hex(str) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
    .then(buf => Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join(''));
}

async function hmacSha256Base64(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function formatOrderDate(raw) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return raw;
  }
}

async function saveOrderToDb(orderData) {
  const url = `${settings.dbApiUrl}/api/orders`;
  logStep('DB SAVE ORDER', orderData);
  const body = JSON.stringify(orderData);
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (res.ok) log(`DB: Order saved successfully order_id=${orderData.order_id}`);
  else log(`DB: Save failed order_id=${orderData.order_id} status=${res.status}`, res.status >= 400 ? 'error' : 'warn');
  return res;
}

async function callGatewayHub(orderData) {
  // Format amount: int if whole number, else decimal (match auto-flow pending_processor_pool)
  let amount = Number(orderData.amount) || 0;
  const rounded = Math.round(amount * 100) / 100;
  const formattedAmount = rounded === Math.floor(rounded) ? Math.floor(rounded) : rounded;

  // Payload: EXACT key order and format as auto-flow pending_processor_pool
  // CRITICAL: name = ONLY username from User column — never replace with acc_holder_name or other fields
  const username = String(orderData.username || orderData.userName || orderData.user || '').trim();
  const accHolderName = String(orderData.acc_holder_name || '').trim(); // Use ONLY acc_holder_name, no fallback to username
  
  // Validation: Do not send FLAT transactions with empty bank details (never send as crypto or with empty bank).
  if (!formattedAmount || formattedAmount <= 0) {
    log(`callGatewayHub: ERROR - Invalid amount: ${formattedAmount}`, 'error');
    return { ok: false, status: 400, data: { error: 'Invalid amount' } };
  }
  const hasBankDetails = !!(orderData.acc_number && String(orderData.acc_number).trim() && orderData.bank_name && String(orderData.bank_name).trim() && orderData.ifsc && String(orderData.ifsc).trim());
  if (!hasBankDetails) {
    log(`callGatewayHub: ERROR - Empty bank details. Not sending. acc_number=${!!orderData.acc_number}, bank_name=${!!orderData.bank_name}, ifsc=${!!orderData.ifsc}`, 'error');
    return { ok: false, status: 400, data: { error: 'Empty bank details - not sent' } };
  }
  
  const payload = {
    amount: formattedAmount,
    name: username, // ONLY username from User column — never replace with acc_holder_name or other fields
    order_id: String(orderData.order_id || '').trim(),
    acc_holder_name: accHolderName,
    acc_number: String(orderData.acc_number || '').trim(),
    bank_name: String(orderData.bank_name || '').trim(),
    ifsc: String(orderData.ifsc || '').trim().toUpperCase(),
    userId: settings.gatewayhubUserId || 1
  };
  logStep('GATEWAYHUB REQUEST (FLAT/INR)', {
    url: 'https://api-prod.gatewayhub.live/withdraw/bot',
    method: 'POST',
    payload,
    note: 'This is a FLAT/INR transaction (NOT crypto)',
    headers: {
      'Content-Type': 'application/json',
      'public-key': settings.gatewayhubPublicKey.substring(0, 20) + '...' + settings.gatewayhubPublicKey.slice(-15),
      'payload-hash': '(computed HMAC-SHA256 base64, normalized)'
    }
  });
  log(`callGatewayHub: FLAT transaction payload - amount=${payload.amount}, name=${payload.name}, order_id=${payload.order_id}, bank=${payload.bank_name}, acc_number=${payload.acc_number}, ifsc=${payload.ifsc}, acc_holder_name=${payload.acc_holder_name}`);
  // Hash: remove ALL whitespace before HMAC (match auto-flow: "".join(str(json_dumps).split()))
  const payloadStr = JSON.stringify(payload);
  const dataStr = payloadStr.split(/\s+/).join('');
  const payloadHash = await hmacSha256Base64(dataStr, settings.gatewayhubPrivateKey);
  log(`GatewayHub: Sending POST, payload-hash length=${payloadHash.length}`);

  const GATEWAYHUB_MAX_RETRIES = 3;
  let lastRes = null;
  for (let attempt = 1; attempt <= GATEWAYHUB_MAX_RETRIES; attempt++) {
    try {
      const res = await proxyFetch('https://api-prod.gatewayhub.live/withdraw/bot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'public-key': settings.gatewayhubPublicKey,
          'payload-hash': payloadHash
        },
        body: dataStr
      });
      lastRes = res;
      logStep('GATEWAYHUB RESPONSE', { status: res.status, ok: res.ok, body: res.data });
      if (res.ok && res.status === 201) {
        log(`GatewayHub: SUCCESS order_id=${orderData.order_id} status=201 (attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES})`, 'info');
        return res;
      }
      log(`GatewayHub: attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES} failed order_id=${orderData.order_id} status=${res.status}`, 'warn');
    } catch (e) {
      log(`GatewayHub: attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES} error order_id=${orderData.order_id} ${e.message}`, 'warn');
      lastRes = { ok: false, status: 0, data: { error: e.message } };
    }
    if (attempt < GATEWAYHUB_MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (lastRes && !lastRes.ok) {
    log(`GatewayHub: FAILED order_id=${orderData.order_id} after ${GATEWAYHUB_MAX_RETRIES} attempts status=${lastRes.status}`, 'error');
  }
  return lastRes || { ok: false, status: 0, data: { error: 'GatewayHub failed after 3 attempts' } };
}

async function updateOrderStatusToInProcess(orderHash) {
  log(`DB: Updating order to in_process hash=${orderHash.substring(0, 16)}...`);
  const url = `${settings.dbApiUrl}/api/orders/hash/${encodeURIComponent(orderHash)}/status`;
  const res = await proxyFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in_process' })
  });
  if (res.ok) log(`DB: Status updated to in_process`);
  return res;
}

async function updateOrderFinalAction(orderId, finalAction, statusDetail) {
  const action = finalAction === 'approve' ? 'approved' : 'rejected';
  log(`DB: Updating final_action to ${action} for order_id=${orderId}`);
  const url = `${settings.dbApiUrl}/api/orders/${encodeURIComponent(orderId)}/status`;
  const payload = { finalAction: action, statusDetail: statusDetail || '' };
  log(`DB: PUT ${url} payload=${JSON.stringify(payload)}`);
  let res = await proxyFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  log(`DB: PUT response status=${res.status} ok=${res.ok} data=${JSON.stringify(res.data)}`);
  if (res.ok) {
    log(`DB: ✅ final_action=${action} saved for order_id=${orderId}`);
    return res;
  }
  if (res.status === 404 && typeof orderId === 'string' && orderId.includes('_')) {
    const transferRef = orderId.replace(/_[^_]+$/, '');
    log(`DB: 404 for full order_id, retrying with transfer_ref=${transferRef}`);
    const retryUrl = `${settings.dbApiUrl}/api/orders/${encodeURIComponent(transferRef)}/status`;
    res = await proxyFetch(retryUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    log(`DB: retry response status=${res.status} ok=${res.ok} data=${JSON.stringify(res.data)}`);
    if (res.ok) log(`DB: ✅ final_action=${action} saved for order_id=${transferRef}`);
    else log(`DB: ❌ retry also failed status=${res.status}`, 'error');
  } else if (!res.ok) {
    log(`DB: ❌ updateOrderFinalAction FAILED status=${res.status} for order_id=${orderId}`, 'error');
  }
  return res;
}

// Mismatch = orders where status != gateway_status; gateway_status may be 'success', 'failed', or 'rejected' (rejected treated like failed → click Reject).
async function getMismatchOrders() {
  let url = `${settings.dbApiUrl}/api/orders/with-mismatch`;
  if (settings.loginGroupKey) {
    url += `?login_group_key=${encodeURIComponent(settings.loginGroupKey)}`;
  }
  log(`Fetching mismatch orders from DB...`);
  const res = await proxyFetch(url);
  if (!res.ok) {
    log(`Mismatch fetch failed: status=${res.status}`, 'warn');
    return { orders: [], count: 0 };
  }
  const data = res.data || { orders: [], count: 0 };
  log(`Mismatch fetch: ${data.count || (data.orders?.length || 0)} order(s) with mismatch`);
  if (data.orders?.length > 0) {
    logStep('MISMATCH ORDERS FROM DB', data.orders);
  }
  return data;
}

async function checkOrderExists(orderHash) {
  log(`Checking if order exists hash=${orderHash.substring(0, 16)}...`);
  const url = `${settings.dbApiUrl}/api/orders/exists/${encodeURIComponent(orderHash)}`;
  const res = await proxyFetch(url);
  if (!res.ok) return { exists: false };
  const exists = res.data?.exists ?? false;
  if (exists) log(`Order already exists (duplicate), skipping`);
  return res.data || { exists: false };
}

/** Check if order exists in DB by order_id (transfer_id + _ + slug). Used instead of local storage. */
async function checkOrderExistsByOrderId(orderId) {
  const url = `${settings.dbApiUrl}/api/orders/${encodeURIComponent(orderId)}`;
  const res = await proxyFetch(url);
  return res.ok && res.data?.order != null;
}

/**
 * Fetch transfer_reference_id set for orders that are pending or in_process.
 * Used so we skip opening View Details / sending to Autoflow for rows already created.
 * order_id in DB is "uuid_username" — we use the UUID part (prefix) for matching.
 */
async function getExistingTransferIdsFromApi() {
  const set = new Set();
  if (!settings.dbApiUrl) {
    log('getExistingTransferIdsFromApi: no dbApiUrl, returning empty set', 'warn');
    return set;
  }
  for (const status of ['pending', 'in_process']) {
    try {
      const url = `${settings.dbApiUrl}/api/orders/status/${encodeURIComponent(status)}`;
      const res = await proxyFetch(url);
      if (!res.ok) {
        log(`getExistingTransferIdsFromApi: ${status} fetch failed status=${res.status}`, 'warn');
        continue;
      }
      const orders = res.data?.orders || res.data || [];
      if (!Array.isArray(orders)) continue;
      for (const o of orders) {
        const orderId = o.order_id || o.orderId || '';
        const tid = typeof orderId === 'string' && orderId.includes('_')
          ? orderId.split('_')[0].trim()
          : (orderId || '').trim();
        if (tid && /^[0-9a-f-]{8,}/i.test(tid)) set.add(tid);
      }
      log(`getExistingTransferIdsFromApi: ${status} → ${orders.length} order(s), total unique transfer_refs=${set.size}`);
    } catch (e) {
      log(`getExistingTransferIdsFromApi: ${status} error ${e.message}`, 'warn');
    }
  }
  return set;
}

function getPanelUsernameSlug(panelUsername) {
  if (!panelUsername) return 'agent';
  const local = panelUsername.split('@')[0] || panelUsername;
  return local.split('.')[0] || local || 'agent';
}

/** Returns true if s looks like a UUID (transfer_reference_id). Never use as username. */
function looksLikeUuid(s) {
  if (!s || typeof s !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s).trim());
}

async function processExtractedRow(row, tabId) {
  // SAFEGUARD: Reject crypto transactions - they should use processCryptoExtractedRow
  if (row.is_crypto === true || row.wallet_address || row.currency || row.crypto_name) {
    log(`processExtractedRow: REJECTED - This is a crypto transaction (is_crypto=${row.is_crypto}, wallet_address=${row.wallet_address ? 'present' : 'none'}). Use processCryptoExtractedRow instead.`, 'error');
    return { error: 'Cannot process crypto transaction in processExtractedRow' };
  }

  const transferRefId = (row.transfer_reference_id || '').trim();
  const amount = Number(row.amount);
  const hasTransferId = transferRefId.length >= 8 && /[0-9a-f-]{8,}/i.test(transferRefId);
  const hasSaneAmount = !isNaN(amount) && amount >= 1 && amount <= 1e8;
  if (!hasTransferId) {
    log(`processExtractedRow: REJECTED - Invalid or missing transfer_reference_id. transfer_ref="${transferRefId}"`, 'error');
    return { error: 'Invalid transfer_reference_id - skipping create' };
  }
  if (!hasSaneAmount) {
    log(`processExtractedRow: REJECTED - Invalid amount (must be 1 to 10 crore INR). amount=${row.amount}`, 'error');
    return { error: 'Invalid amount - skipping create' };
  }

  // SAFEGUARD: Do not send transactions with empty bank details. Empty bank = do not create/send (never treat as crypto).
  const hasBankDetails = !!(row.bank_name && String(row.bank_name).trim() && row.acc_number && String(row.acc_number).trim() && row.ifsc && String(row.ifsc).trim());
  if (!hasBankDetails) {
    log(`processExtractedRow: REJECTED - Empty or missing bank details. Do not create or send. bank_name="${row.bank_name || ''}", acc_number="${row.acc_number || ''}", ifsc="${row.ifsc || ''}". Empty bank details are never sent as crypto.`, 'error');
    return { error: 'Empty bank details - skipping create (not sent as flat or crypto)' };
  }
  
  logStep('PROCESS ROW (FLAT/INR transaction)', row);
  const slug = getPanelUsernameSlug(settings.panelUsername);
  const order_id = `${transferRefId}_${slug}`;
  log(`Processing FLAT: order_id=${order_id}, transfer_ref=${transferRefId}, slug=${slug}, amount=${row.amount}`);

  const order_date = formatOrderDate(row.order_date_raw);
  // IMPORTANT: Use ONLY actual User column value - no fallbacks to merchant_reference_id, never UUID/transfer_reference_id
  let username = row.userName || row.username || row.user || '';
  if (username === row.transfer_reference_id || looksLikeUuid(username)) {
    log(`processExtractedRow: WARNING - Username was UUID/transfer_reference_id "${username}", clearing to empty`, 'warn');
    username = '';
  }
  if (!username) log(`processExtractedRow: WARNING - No User column value found. Check table User column (col-id="userName") is being read.`, 'warn');
  if (username === row.application_name) {
    log(`processExtractedRow: WARNING - Username matches application_name "${username}" - this might be wrong!`, 'warn');
  }
  const order_hash_str = `${row.amount}|${order_date}|${username}|${row.acc_number}|${row.ifsc}`;
  logStep('ORDER HASH INPUT', { order_hash_str, amount: row.amount, order_date, username, acc_number: row.acc_number, ifsc: row.ifsc });
  const order_hash = await sha256Hex(order_hash_str);
  log(`order_hash (sha256): ${order_hash.substring(0, 32)}...`);

  const existing = await checkOrderExists(order_hash);
  if (existing.exists) {
    log(`TRANSACTION NOT CREATED - duplicate order_hash=${order_hash.substring(0, 16)}... (order already in DB)`);
    return { skipped: true, reason: 'duplicate' };
  }

  log(`Building order payload for DB...`);
  const orderPayload = {
    order_hash,
    order_id,
    username,
    payment_name: null,
    panel_username: settings.panelUsername,
    acc_holder_name: row.acc_holder_name || '',
    amount: row.amount,
    bank_name: row.bank_name,
    acc_number: row.acc_number,
    ifsc: row.ifsc,
    order_date,
    status: 'pending',
    txn_id: '',
    utr: row.utr || '',
    api_status: 'pending'
  };

  const saveRes = await saveOrderToDb(orderPayload);
  if (!saveRes.ok && saveRes.status !== 409) {
    const errMsg = JSON.stringify(saveRes.data || {});
    if (saveRes.status === 500 && /duplicate key|unique constraint|order_id_key/i.test(errMsg)) {
      log(`Order already exists (500 duplicate key), skipping`);
      return { skipped: true, reason: 'duplicate' };
    }
    log(`DB save failed order_id=${order_id}: ${errMsg}`, 'error');
    return { error: 'DB save failed' };
  }
  if (saveRes.status === 409) {
    log(`Order already exists (409 conflict), skipping`);
    return { skipped: true, reason: 'duplicate' };
  }

  log(`DB save OK, calling GatewayHub for order_id=${order_id}...`);
  // Prepare GatewayHub payload - ensure it's FLAT transaction (not crypto)
  const gatewayHubPayload = {
    ...row,
    order_id,
    transfer_reference_id: transferRefId,
    username,
    application_name: row.application_name,
    is_crypto: false // Explicitly mark as NOT crypto
  };
  
  log(`processExtractedRow: Sending FLAT transaction to GatewayHub: amount=${gatewayHubPayload.amount}, bank=${gatewayHubPayload.bank_name}, acc_number=${gatewayHubPayload.acc_number}, ifsc=${gatewayHubPayload.ifsc}, acc_holder_name=${gatewayHubPayload.acc_holder_name}`);
  
  const gwRes = await callGatewayHub(gatewayHubPayload);
  if (!gwRes.ok || gwRes.status !== 201) {
    log(`GatewayHub failed order_id=${order_id}: status=${gwRes.status} body=${JSON.stringify(gwRes.data)?.substring(0, 200)}`, 'error');
    return { error: 'GatewayHub failed' };
  }

  await updateOrderStatusToInProcess(order_hash);
  log(`✅ DONE: order_id=${order_id} saved, GatewayHub 201, status→in_process`);
  return { success: true };
}

async function callGatewayHubCrypto(orderData) {
  // For USDT/crypto: use CRYPTO amount only (converted_amount = USDT value), NOT native INR amount.
  // GatewayHub expects the crypto withdrawal amount (e.g. 835.463918 USDT), not the INR equivalent.
  const sourceAmount = orderData.converted_amount != null && orderData.converted_amount !== ''
    ? orderData.converted_amount
    : orderData.amount;
  let parsedAmount = 0;
  if (sourceAmount != null && sourceAmount !== '') {
    const cleanAmount = String(sourceAmount).replace(/[₹$,\s]/g, '');
    const amountFloat = parseFloat(cleanAmount) || 0;
    const roundedAmount = Math.round(amountFloat * 100) / 100;
    if (roundedAmount === Math.floor(roundedAmount)) {
      parsedAmount = Math.floor(roundedAmount);
    } else {
      parsedAmount = roundedAmount;
    }
  }
  log(`callGatewayHubCrypto: Using USDT/crypto value only - converted_amount=${orderData.converted_amount}, amount(native)=${orderData.amount} → sending amount=${parsedAmount}`);

  // Same 8-field payload as flat — crypto values mapped into the bank fields.
  // Key order must match exactly (used for HMAC hash).
  // CRITICAL: name = ONLY username from User column — never replace with acc_holder_name, application_name, or any other field.
  const payload = {
    amount: parsedAmount,
    name: String((orderData.username || '').trim()), // ONLY username from User column — no fallback to .name or other fields
    order_id: String((orderData.order_id || '').trim()),
    acc_holder_name: String((orderData.acc_holder_name || '').trim()), // Use ONLY actual acc_holder_name, no fallbacks
    acc_number: String((orderData.wallet_address || '').trim()),   // wallet address → acc_number (TRC20 address)
    bank_name: 'CRYPTO',                                         // always "CRYPTO" for crypto orders
    ifsc: 'SBIN0000001',                                         // placeholder IFSC for crypto
    userId: settings.gatewayhubUserId || 1
  };
  logStep('GATEWAYHUB CRYPTO REQUEST', {
    url: 'https://api-prod.gatewayhub.live/withdraw/bot',
    method: 'POST',
    payload,
    headers: {
      'Content-Type': 'application/json',
      'public-key': settings.gatewayhubPublicKey.substring(0, 20) + '...' + settings.gatewayhubPublicKey.slice(-15),
      'payload-hash': '(computed HMAC-SHA256 base64, normalized)'
    }
  });
  // Generate JSON string - Python removes ALL whitespace before hashing
  // Reference: data_str = "".join(str(json_dumps).split())
  const payloadJsonString = JSON.stringify(payload);
  
  // Normalize for hash: remove ALL whitespace (spaces, tabs, newlines)
  const normalizedPayload = payloadJsonString.split(/\s+/).join('');
  const payloadHash = await hmacSha256Base64(normalizedPayload, settings.gatewayhubPrivateKey);
  
  log(`GatewayHub CRYPTO: Sending POST, payload-hash length=${payloadHash.length}`);
  log(`GatewayHub CRYPTO: Payload JSON (used for hash & body): ${payloadJsonString.substring(0, 150)}...`);

  const GATEWAYHUB_MAX_RETRIES = 3;
  let lastRes = null;
  for (let attempt = 1; attempt <= GATEWAYHUB_MAX_RETRIES; attempt++) {
    try {
      const res = await proxyFetch('https://api-prod.gatewayhub.live/withdraw/bot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'public-key': settings.gatewayhubPublicKey,
          'payload-hash': payloadHash
        },
        body: payloadJsonString // Use the exact same JSON string that was normalized for hash (match autoflow-ce)
      });
      lastRes = res;
      logStep('GATEWAYHUB CRYPTO RESPONSE', { status: res.status, ok: res.ok, body: res.data });
      if (res.ok && res.status === 201) {
        log(`GatewayHub CRYPTO: SUCCESS order_id=${orderData.order_id} status=201 (attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES})`, 'info');
        return res;
      }
      log(`GatewayHub CRYPTO: attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES} failed order_id=${orderData.order_id} status=${res.status}`, 'warn');
    } catch (e) {
      log(`GatewayHub CRYPTO: attempt ${attempt}/${GATEWAYHUB_MAX_RETRIES} error order_id=${orderData.order_id} ${e.message}`, 'warn');
      lastRes = { ok: false, status: 0, data: { error: e.message } };
    }
    if (attempt < GATEWAYHUB_MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (lastRes && !lastRes.ok) {
    log(`GatewayHub CRYPTO: FAILED order_id=${orderData.order_id} after ${GATEWAYHUB_MAX_RETRIES} attempts status=${lastRes.status}`, 'error');
  }
  return lastRes || { ok: false, status: 0, data: { error: 'GatewayHub failed after 3 attempts' } };
}

async function processCryptoExtractedRow(row, tabId) {
  logStep('PROCESS CRYPTO ROW (input from panel)', row);
  // SAFEGUARD: Only process as crypto when we have is_crypto and a valid wallet. Empty bank/wallet = flat, not crypto.
  const hasCryptoWallet = !!(row.wallet_address && String(row.wallet_address).trim() && row.wallet_address !== '-');
  if (row.is_crypto !== true || !hasCryptoWallet) {
    log(`processCryptoExtractedRow: REJECTED - Not a crypto transaction (is_crypto=${row.is_crypto}, wallet_address=${row.wallet_address ? 'present' : 'empty'}). Use processExtractedRow for flat.`, 'error');
    return { error: 'Cannot process as crypto - missing is_crypto or wallet_address (empty bank details = flat)' };
  }
  const transferRefId = row.transfer_reference_id;
  const slug = getPanelUsernameSlug(settings.panelUsername);
  const order_id = `${transferRefId}_${slug}`;
  log(`Processing CRYPTO: order_id=${order_id}, transfer_ref=${transferRefId}, slug=${slug}, amount=${row.amount}`);

  const order_date = formatOrderDate(row.order_date_raw);
  // IMPORTANT: Use ONLY actual User column value - no fallbacks, never UUID/transfer_reference_id
  let username = row.userName || row.username || row.user || '';
  if (username === row.transfer_reference_id || looksLikeUuid(username)) {
    log(`processCryptoExtractedRow: WARNING - Username was UUID/transfer_reference_id "${username}", clearing to empty`, 'warn');
    username = '';
  }
  if (!username) log(`processCryptoExtractedRow: WARNING - No User column value found. Check table User column (col-id="userName") is being read.`, 'warn');
  if (username === row.application_name) {
    log(`processCryptoExtractedRow: WARNING - Username matches application_name "${username}" - this might be wrong!`, 'warn');
  }
  // Hash uses wallet_address + currency instead of bank fields
  const order_hash_str = `${row.amount}|${order_date}|${username}|${row.wallet_address}|${row.currency}`;
  logStep('CRYPTO ORDER HASH INPUT', { order_hash_str, amount: row.amount, order_date, username, wallet_address: row.wallet_address, currency: row.currency });
  const order_hash = await sha256Hex(order_hash_str);
  log(`order_hash CRYPTO (sha256): ${order_hash.substring(0, 32)}...`);

  const existing = await checkOrderExists(order_hash);
  if (existing.exists) {
    log(`Skip duplicate crypto order_hash=${order_hash.substring(0, 16)}...`);
    return { skipped: true, reason: 'duplicate' };
  }

  log(`Building crypto order payload for DB...`);
  const orderPayload = {
    order_hash,
    order_id,
    username,
    payment_name: null,
    panel_username: settings.panelUsername,
    acc_holder_name: (row.acc_holder_name && String(row.acc_holder_name).trim()) || '', // Only from modal/row — never use username here
    amount: row.amount,
    bank_name: row.crypto_name || row.currency || '',
    acc_number: row.wallet_address || '',
    ifsc: row.currency || '',
    order_date,
    status: 'pending',
    txn_id: '',
    utr: row.utr || '',
    api_status: 'pending',
    is_crypto: true,
    wallet_address: row.wallet_address || '',
    currency: row.currency || '',
    crypto_name: row.crypto_name || '',
    converted_amount: row.converted_amount || 0
  };

  const saveRes = await saveOrderToDb(orderPayload);
  if (!saveRes.ok && saveRes.status !== 409) {
    const errMsg = JSON.stringify(saveRes.data || {});
    if (saveRes.status === 500 && /duplicate key|unique constraint|order_id_key/i.test(errMsg)) {
      log(`Crypto order already exists (500 duplicate key), skipping`);
      return { skipped: true, reason: 'duplicate' };
    }
    log(`DB save failed crypto order_id=${order_id}: ${errMsg}`, 'error');
    return { error: 'DB save failed' };
  }
  if (saveRes.status === 409) {
    log(`Crypto order already exists (409 conflict), skipping`);
    return { skipped: true, reason: 'duplicate' };
  }

  log(`DB save OK, calling GatewayHub (crypto) for order_id=${order_id}...`);
  const gwRes = await callGatewayHubCrypto({
    ...row,
    order_id,
    transfer_reference_id: transferRefId,
    username,
    application_name: row.application_name
  });
  if (!gwRes.ok || gwRes.status !== 201) {
    log(`GatewayHub CRYPTO failed order_id=${order_id}: status=${gwRes.status} body=${JSON.stringify(gwRes.data)?.substring(0, 200)}`, 'error');
    return { error: 'GatewayHub failed' };
  }

  await updateOrderStatusToInProcess(order_hash);
  log(`✅ DONE CRYPTO: order_id=${order_id} saved, GatewayHub 201, status→in_process`);
  return { success: true };
}

async function runCryptoProcessCycle(tabId) {
  if (!isRunning) return;
  try {
  log('=== Crypto process cycle START (read PENDING crypto rows + send to backend) ===');
  await loadSettings();
  const slug = getPanelUsernameSlug(settings.panelUsername);
    // NOTE: Transfer Reference IDs are NOT in table rows - they're only in View Details modals
    // So we skip getTransferIdsFromTable and let extractAllRows get IDs from modals
    log('Crypto: extracting rows via View Details modals (transfer IDs are in modals, not table)...');
    // Only process rows NOT already pending/in_process in DB (skip by transfer_ref prefix match)
    const existingTransferIds = await getExistingTransferIdsFromApi();
    log(`Crypto: ${existingTransferIds.size} existing transfer_ref(s) from API (pending+in_process) — will skip those rows`);
    log('Crypto: processing ALL rows (no date filtering, only skipping duplicates)...');
    let res;
    try {
      // Wrap in timeout to prevent hanging
      log(`Crypto: Starting extractAllRows call (120s timeout, isCrypto=true)...`);
      const extractPromise = sendToContent(tabId, 'extractAllRows', { existingIds: Array.from(existingTransferIds), lastProcessedAt: null, isCrypto: true }, false, 120000); // 120s timeout for crypto extraction
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('extractAllRows timeout after 120s')), 120000)
      );
      res = await Promise.race([extractPromise, timeoutPromise]);
      log(`Crypto: extractAllRows completed, response type: ${typeof res}, isArray: ${Array.isArray(res)}, has rows: ${res?.rows ? 'yes' : 'no'}`);
      if (res) {
        log(`Crypto: extractAllRows response preview: ${JSON.stringify(res).substring(0, 300)}`);
      }
    } catch (e) {
      log(`Crypto extractAllRows error: ${e.message}`, 'error');
      log(`Crypto extractAllRows error stack: ${e.stack}`, 'error');
      return;
    }
    const rows = Array.isArray(res) ? res : (res && Array.isArray(res.rows) ? res.rows : []);
    if (!Array.isArray(rows)) {
      log(`Crypto extract returned invalid data: ${typeof res}, value: ${JSON.stringify(res)?.substring(0, 200)}`, 'warn');
      return;
    }
    log(`Crypto: extracted ${rows.length} row(s) (new, not already in DB)`);
    if (rows.length > 0) {
      log(`Crypto: First row preview: transfer_id=${rows[0]?.transfer_reference_id}, username=${rows[0]?.username || rows[0]?.userName || rows[0]?.user}`);
    }
    if (rows.length > 0) {
    logStep('EXTRACTED CRYPTO ROWS FROM PANEL (pending)', rows);
    }
    if (rows.length === 0) {
      log('No new pending crypto rows to process (USDT/crypto)');
      log('Possible reasons: (1) All visible rows already in DB (pending/in_process). (2) Wallet address not found in View Details modal — check crypto page console for "Wallet address is empty" or "is_crypto=false". (3) Panel uses a different list-key for wallet (e.g. "Receiver Address") — we try several. (4) Session expired (401).', 'info');
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isRunning) break;
      if (!row.transfer_reference_id) {
        log(`Crypto Row ${i + 1}: no transfer_reference_id, skip`);
        continue;
      }
      // Only process rows that are actually crypto (is_crypto + wallet). Empty bank/wallet = flat, do NOT send as crypto.
      const hasCryptoWallet = !!(row.wallet_address && String(row.wallet_address).trim() && row.wallet_address !== '-');
      if (row.is_crypto !== true || !hasCryptoWallet) {
        log(`Crypto Row ${i + 1}: skipped - not treated as crypto (is_crypto=${row.is_crypto}, wallet_address=${row.wallet_address ? 'present' : 'empty'}). To create USDT: View Details modal must have a wallet field (User Wallet Address / Wallet Address / Public Key / Receiver Address).`, 'info');
        continue;
      }
      const tid = row.transfer_reference_id;
      // Check if order already exists in DB (since transfer IDs are in modals, not table)
      const orderId = `${tid}_${slug}`;
      const exists = await checkOrderExistsByOrderId(orderId);
      if (exists) {
        log(`Crypto Row ${i + 1}/${rows.length}: transfer_id=${tid} ALREADY IN DB (order_id=${orderId}), skip`);
        continue;
      }
      try {
        log(`Crypto Row ${i + 1}/${rows.length}: NEW transfer_id=${tid}, processing...`);
        const result = await processCryptoExtractedRow(row, tabId);
        if (result?.success || result?.skipped) {
          log(`Crypto Row ${i + 1}: done (${result.success ? 'success' : 'duplicate'})`);
        } else if (result?.error) {
          log(`Crypto Row ${i + 1} failed (will retry next cycle): ${result.error}`, 'warn');
        }
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        log(`Crypto Row ${i + 1} error (will retry next cycle): ${e.message}`, 'error');
      }
    }
    log('=== Crypto process cycle END ===');
  } catch (e) {
    log(`Crypto process cycle error: ${e.message}`, 'error');
  }
}

async function runProcessCycle(tabId) {
  log(`[runProcessCycle] CALLED with tabId=${tabId}, isRunning=${isRunning}`);
  if (!isRunning) {
    log(`[runProcessCycle] NOT RUNNING - automation stopped, exiting`);
    return;
  }
  try {
  log('=== Process cycle START (read PENDING rows + send to backend) ===');
  await loadSettings();
  const slug = getPanelUsernameSlug(settings.panelUsername);
    // NOTE: Transfer Reference IDs are NOT in table rows - they're only in View Details modals
    // So we skip getTransferIdsFromTable and let extractAllRows get IDs from modals
    log('Reading pending: extracting rows via View Details modals (transfer IDs are in modals, not table)...');
    // Only process rows NOT already pending/in_process in DB (skip by transfer_ref prefix match)
    const existingTransferIds = await getExistingTransferIdsFromApi();
    log(`Reading pending: ${existingTransferIds.size} existing transfer_ref(s) from API (pending+in_process) — will skip those rows`);
    log('Reading pending: processing ALL rows (no date filtering, only skipping duplicates)...');
    log('Reading pending: Starting extractAllRows call (10 min timeout)...');
    const res = await sendToContent(tabId, 'extractAllRows', { existingIds: Array.from(existingTransferIds), lastProcessedAt: null }, false, 600000);
    const rows = Array.isArray(res) ? res : (res && Array.isArray(res.rows) ? res.rows : []);
    if (!Array.isArray(rows)) {
      log(`Extract returned invalid data: ${typeof res}`, 'warn');
      return;
    }
    log(`Reading pending: extracted ${rows.length} row(s) (new, not already in DB)`);
    logStep('EXTRACTED ROWS FROM PANEL (pending)', rows);
    if (rows.length === 0) {
      log(`No new pending rows to process (0 rows extracted).`);
      log(`Possible causes: (1) All visible rows already in API (${existingTransferIds.size} pending+in_process) or order already in DB (GET 200) — we do not create duplicates. (2) View Details button not found — search PAGE console for "SKIPPED: no data". (3) Table empty or Week filter not applied.`, 'info');
      logToPage('FLAT: 0 new flat rows. If you expect flat transactions: (1) Reader tab must be on flat /withdrawls/ not crypto, (2) Week filter applied, (3) Rows not already in DB.', 'info');
      return;
    }
    log(`Going through all ${rows.length} row(s) and sending to autoflow one by one...`);
    let flatSentCount = 0;
    let cryptoSkippedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isRunning) break;
      if (!row.transfer_reference_id) {
        log(`Row ${i + 1}: no transfer_reference_id, skip`);
        continue;
      }
      // SAFEGUARD: Skip crypto transactions in flat processing cycle
      if (row.is_crypto === true || row.wallet_address || row.currency) {
        cryptoSkippedCount++;
        log(`Row ${i + 1}/${rows.length}: SKIPPED - This is a crypto transaction (is_crypto=${row.is_crypto}), should be processed by runCryptoProcessCycle`, 'warn');
        continue;
      }
      const tid = row.transfer_reference_id;
      // Check if order already exists in DB (since transfer IDs are in modals, not table)
      const orderId = `${tid}_${slug}`;
      const exists = await checkOrderExistsByOrderId(orderId);
      if (exists) {
        log(`Row ${i + 1}/${rows.length}: transfer_id=${tid} ALREADY IN DB (order_id=${orderId}), skip`);
        continue;
      }
      try {
        log(`Row ${i + 1}/${rows.length}: Sending to autoflow: transfer_id=${tid}, amount=${row.amount}, bank=${row.bank_name}...`);
        const result = await processExtractedRow(row, tabId);
        if (result?.success || result?.skipped) {
          if (result?.success) flatSentCount++;
          log(`Row ${i + 1}: done (${result.success ? 'success' : 'duplicate'})`);
        } else if (result?.error) {
          log(`Row ${i + 1} failed (will retry next cycle): ${result.error}`, 'warn');
        }
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        log(`Row ${i + 1} error (will retry next cycle): ${e.message}`, 'error');
      }
    }
    if (flatSentCount > 0) {
      logToPage(`FLAT: Sent ${flatSentCount} flat order(s) to backend.`, 'info');
    } else if (rows.length > 0 && cryptoSkippedCount === rows.length) {
      logToPage(`FLAT: All ${rows.length} row(s) were crypto (skipped). Reader tab should be on flat /withdrawls/ not crypto.`, 'warn');
    } else if (rows.length > 0 && flatSentCount === 0) {
      logToPage(`FLAT: Some rows were not created (check page console for "modal did not open" or 401). If panel returned 401, refresh the reader tab or re-login.`, 'warn');
    }
    log('=== Process cycle END (pending read done; next in 20s) ===');
  } catch (e) {
    log(`Process cycle error: ${e.message}`, 'error');
    if (e.message && e.message.includes('timeout')) {
      log('Extraction has 10 min timeout. If it still times out, check PAGE console for "modal did not open" or 401. If 401 on withdrawlRequests, re-login to the panel.', 'info');
    }
  }
}

// Detect crypto mismatch orders so we search on /withdrawls/crypto not flat.
// API may return snake_case (bank_name) or camelCase (bankName); crypto can have wallet in acc_number.
function isCryptoMismatchOrder(order) {
  if (order.is_crypto === true) return true;
  const bank = String(order.bank_name || order.bankName || '').trim().toLowerCase();
  if (bank === 'crypto') return true;
  const cryptoBankNames = ['usdt', 'usdc', 'trx', 'trc20', 'trc-20', 'erc20', 'erc-20', 'btc', 'eth'];
  if (cryptoBankNames.some((c) => bank === c || bank.includes(c))) return true;
  const appName = String(order.application_name || order.applicationName || '').toUpperCase();
  if (appName.includes('CRYPTO')) return true;
  // Fallback: long hex acc_number (wallet) or wallet_address present
  const acc = String(order.acc_number || order.accNumber || '').trim();
  if (acc.length >= 40 && /^[0-9a-fA-Fx]+$/.test(acc)) return true;
  if (order.wallet_address || order.walletAddress) return true;
  return false;
}

/**
 * Process a single mismatch order on the given tab. Returns result object.
 */
async function processSingleMismatchOrder(tabId, order, pageType, index, total) {
  const orderId = order.order_id || order.transfer_reference_id;
  const transferRefId = orderId.includes('_') ? orderId.split('_').slice(0, -1).join('_') : orderId;
  const gw = (order.gateway_status || '').toLowerCase();
  const clickAction = gw === 'success' ? 'approve' : 'reject';
  const username = order.username || order.userName || order.user || '';
  const amount = order.amount || null;
  const utr = order.utr || order.txn_utr || '';

  log(`Mismatch ${pageType} ${index + 1}/${total}: order_id=${orderId} transfer_ref=${transferRefId} → ${clickAction}`);

  const mismatchActionTimeoutMs = 300000; // 5 minutes
  const maxRowSearchAttempts = 3;
  let res;
  let attempt = 0;
  let everSubmitted = false;

  for (;;) {
    attempt++;
    const actionPromise = sendToContent(tabId, 'searchAndClickAction', {
      orderId: transferRefId,
      clickAction,
      utr,
      username,
      amount
    }, false, mismatchActionTimeoutMs);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`searchAndClickAction timeout after ${mismatchActionTimeoutMs / 1000}s`)), mismatchActionTimeoutMs)
    );
    res = await Promise.race([actionPromise, timeoutPromise]).catch(e => {
      log(`Mismatch timeout/error for order_id=${orderId}: ${e.message}`, 'error');
      return { success: false, message: e.message };
    });
    if (res?.success && res?.submitted) everSubmitted = true;

    const msg = res?.message || res?.error || '';
    const rowNotFound = typeof msg === 'string' && msg.includes('No row with matching transfer_id found');
    const actionsBlocked = typeof msg === 'string' && (msg.toLowerCase().includes('block') || msg.toLowerCase().includes('actions blocked'));
    const confirmedCleared = res?.success && res?.submitted && (res?.cleared === true);

    if (confirmedCleared) break;

    // If panel says "actions blocked", wait and retry
    if (actionsBlocked && attempt < maxRowSearchAttempts) {
      const waitMatch = msg.match(/(\d+)\s*sec/i);
      const waitSec = waitMatch ? parseInt(waitMatch[1]) + 3 : 15;
      log(`Mismatch order_id=${orderId}: panel actions blocked — waiting ${waitSec}s then retrying...`, 'warn');
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (res?.success && res?.submitted && !res?.cleared) {
      log(`Mismatch order_id=${orderId}: modal submitted but row still on panel (cleared=false), retrying in 2s...`, 'info');
      if (attempt < maxRowSearchAttempts) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      break;
    }
    if (rowNotFound && everSubmitted) {
      log(`Mismatch order_id=${orderId}: row not found on retry but modal was previously submitted — treating as cleared`, 'info');
      break;
    }
    if (rowNotFound) {
      log(`Mismatch order_id=${orderId}: row not found (attempt ${attempt}) — NOT updating final_action; will retry next poll`, 'info');
      break;
    }
    break;
  }

  // Update DB based on result
  const confirmedCleared = res?.success && res?.submitted && (res?.cleared === true);
  if (confirmedCleared) {
    log(`Successfully clicked ${clickAction}, submitted modal, and confirmed cleared from panel for order_id=${orderId}`);
    await updateOrderFinalAction(orderId, clickAction, '').catch(e => {
      log(`Failed to update order final action for ${orderId}: ${e.message}`, 'warn');
    });
  } else if (everSubmitted) {
    log(`Clicked ${clickAction} and submitted modal for order_id=${orderId} (everSubmitted=true) — updating final_action`, 'info');
    await updateOrderFinalAction(orderId, clickAction, '').catch(e => {
      log(`Failed to update order final action for ${orderId}: ${e.message}`, 'warn');
    });
  } else if (res?.success && !res?.submitted) {
    log(`Clicked ${clickAction} but modal submission may have failed for order_id=${orderId} — NOT updating final_action`, 'warn');
  } else {
    const msg = res?.message || res?.error || 'unknown';
    log(`Failed to click ${clickAction} for order_id=${orderId}: ${msg}`, 'warn');
    const rowNotFoundMsg = typeof msg === 'string' && (
      msg.includes('No row with matching transfer_id found') ||
      msg.includes('Row not found') ||
      msg.includes('not found in pinned-right container')
    );
    const buttonClickFailedMsg = typeof msg === 'string' && (
      msg.includes('Failed to click approve/reject button') ||
      msg.includes('Actions container not found') ||
      (msg.includes('Only ') && msg.includes('buttons found'))
    );
    if (rowNotFoundMsg) {
      // Order not found on panel — it was already cleared (by this extension or manually).
      // GatewayHub already confirmed the status, so mark it done in our DB to stop retrying.
      log(`Mismatch order_id=${orderId}: not found on panel (already cleared) — marking as ${clickAction} in DB`, 'info');
      await updateOrderFinalAction(orderId, clickAction, 'cleared from panel (not found on search)').catch(e => {
        log(`Failed to update order final action for ${orderId}: ${e.message}`, 'warn');
      });
    } else if (buttonClickFailedMsg) {
      log(`Mismatch order_id=${orderId}: approve/reject button not clickable — will retry next poll`, 'info');
    } else if (typeof msg === 'string' && (msg.toLowerCase().includes('valid utr') || msg.toLowerCase().includes('enter a valid') || msg.toLowerCase().includes('validation'))) {
      log(`Mismatch order_id=${orderId}: ⚠️ UTR validation error: "${msg}" — NOT marking, will retry next poll`, 'warn');
    }
  }
  return res;
}

/**
 * Process multiple orders on a single fresh tab (open → login → process N orders sequentially → close).
 * @param {Array} orders - Orders to process on this tab (up to MISMATCH_ORDERS_PER_TAB)
 * @param {string} pageType - 'flat' or 'crypto'
 * @param {string} pageUrl - URL to open
 * @param {number} tabIndex - Which tab this is (for logging)
 * @param {number} totalOrders - Total orders across all tabs (for logging)
 */
async function processOrdersOnFreshTab(orders, pageType, pageUrl, tabIndex, totalOrders) {
  let tabId = null;
  try {
    // 1. Create fresh tab
    tabId = await createFreshMismatchTab(pageUrl);

    // 2. Login if needed
    const loginCheck = await sendToContent(tabId, 'isLoginPage').catch(() => ({ isLoginPage: false }));
    if (loginCheck?.isLoginPage) {
      log(`Mismatch ${pageType} tab${tabIndex + 1}: logging in...`);
      await sendToContent(tabId, 'performLogin', {
        username: settings.panelUsername,
        password: settings.panelPassword
      }).catch(e => {
        log(`Mismatch ${pageType} tab${tabIndex + 1}: login failed: ${e.message}`, 'error');
      });
      await new Promise(r => setTimeout(r, 3000));
      await waitForTabComplete(tabId, 15000);

      await chrome.tabs.update(tabId, { url: pageUrl });
      await waitForTabComplete(tabId, 20000);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => { window.addEventListener('unload', () => {}); },
        });
      } catch {}
      await ensureContentScriptInjected(tabId);
      await new Promise(r => setTimeout(r, 1500));
    }

    // 3. Verify on correct page
    const urlCheck = await sendToContent(tabId, 'getCurrentUrl').catch(() => null);
    if (urlCheck && !urlCheck.pathname?.includes('/withdrawls')) {
      await chrome.tabs.update(tabId, { url: pageUrl });
      await waitForTabComplete(tabId, 20000);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => { window.addEventListener('unload', () => {}); },
        });
      } catch {}
      await ensureContentScriptInjected(tabId);
      await new Promise(r => setTimeout(r, 1500));
    }

    // 4. Set filter and refresh (once per tab, shared by all orders)
    await sendToContent(tabId, 'setDateFilterToWeek').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    await sendToContent(tabId, 'clickRefresh').catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    // 5. Process each order sequentially on this tab
    for (let i = 0; i < orders.length; i++) {
      if (!isRunning) break;
      const order = orders[i];
      const globalIdx = tabIndex * MISMATCH_ORDERS_PER_TAB + i;

      // Verify tab still alive
      try {
        const tabInfo = await chrome.tabs.get(tabId);
        if (!tabInfo || tabInfo.discarded) break;
      } catch { tabId = null; break; }

      await processSingleMismatchOrder(tabId, order, pageType, globalIdx, totalOrders);

      // Delay between orders on same tab
      if (i < orders.length - 1 && isRunning) {
        await new Promise(r => setTimeout(r, MISMATCH_INTER_ORDER_DELAY_MS));
      }
    }

    log(`Mismatch ${pageType} tab${tabIndex + 1}: done (${orders.length} orders)`);
  } catch (e) {
    log(`Mismatch ${pageType} tab${tabIndex + 1} error: ${e.message}`, 'error');
  } finally {
    if (tabId) await closeMismatchTab(tabId);
  }
}

/**
 * Process mismatch orders: 5 parallel tabs × 3 orders each = 15 per batch.
 * Each tab opens → logs in once → processes 3 orders sequentially → closes.
 */
async function processMismatchBatch(orderList, pageType, pageUrl) {
  if (!orderList || orderList.length === 0) return;
  if (!isRunning) return;

  const ordersPerBatch = MISMATCH_PARALLEL_TABS * MISMATCH_ORDERS_PER_TAB; // 5 × 3 = 15
  log(`Mismatch ${pageType}: processing ${orderList.length} order(s) — ${MISMATCH_PARALLEL_TABS} tabs × ${MISMATCH_ORDERS_PER_TAB} orders = ${ordersPerBatch} per batch`);

  for (let batchStart = 0; batchStart < orderList.length; batchStart += ordersPerBatch) {
    if (!isRunning) break;
    const batchOrders = orderList.slice(batchStart, batchStart + ordersPerBatch);
    const batchNum = Math.floor(batchStart / ordersPerBatch) + 1;
    log(`Mismatch ${pageType}: batch ${batchNum} — ${batchOrders.length} orders across ${Math.min(MISMATCH_PARALLEL_TABS, Math.ceil(batchOrders.length / MISMATCH_ORDERS_PER_TAB))} tab(s)`);

    // Split batch into per-tab chunks of MISMATCH_ORDERS_PER_TAB
    const tabChunks = [];
    for (let i = 0; i < batchOrders.length; i += MISMATCH_ORDERS_PER_TAB) {
      tabChunks.push(batchOrders.slice(i, i + MISMATCH_ORDERS_PER_TAB));
    }

    // Launch all tabs in parallel
    await Promise.allSettled(
      tabChunks.map((chunk, tabIdx) => processOrdersOnFreshTab(chunk, pageType, pageUrl, tabIdx, orderList.length))
    );

    log(`Mismatch ${pageType}: batch ${batchNum} done (${batchOrders.length} orders)`);

    if (batchStart + ordersPerBatch < orderList.length && isRunning) {
      log(`Mismatch ${pageType}: waiting ${MISMATCH_INTER_BATCH_DELAY_MS / 1000}s before next batch...`);
      await new Promise(r => setTimeout(r, MISMATCH_INTER_BATCH_DELAY_MS));
    }
  }
}

/**
 * Main mismatch cycle: fetch orders → split into batches of MISMATCH_PARALLEL_TABS → process each batch on fresh tab.
 */
async function runMismatchCycle() {
  if (!isRunning) return;
  log('=== Mismatch cycle START ===');
  await loadSettings();
  try {
    const { orders } = await getMismatchOrders();
    if (!orders || orders.length === 0) {
      log('Mismatch cycle: no mismatch orders from API (nothing to clear)');
      return;
    }
    log(`Mismatch cycle: API returned ${orders.length} order(s) with mismatch`);
    const mySlug = getPanelUsernameSlug(settings.panelUsername);
    const mySuffix = `_${mySlug}`;
    const myOrders = orders.filter((o) => {
      const id = o.order_id || o.transfer_reference_id || '';
      return id.endsWith(mySuffix);
    });
    if (myOrders.length === 0) {
      const suffixes = [...new Set(orders.map((o) => {
        const id = o.order_id || o.transfer_reference_id || '';
        return id.includes('_') ? id.slice(id.lastIndexOf('_')) : '(no suffix)';
      }))];
      log(`Mismatch: ${orders.length} total, 0 belong to current user (${mySlug}), skipping. Other order_ids end with: ${suffixes.join(', ')}`);
      return;
    }
    const flatOrders = myOrders.filter((o) => !isCryptoMismatchOrder(o));
    const cryptoOrders = myOrders.filter((o) => isCryptoMismatchOrder(o));
    if (myOrders.length < orders.length) {
      log(`Mismatch: ${orders.length} total, ${myOrders.length} belong to current user (${mySlug})`);
    }
    log(`Mismatch: ${flatOrders.length} flat order(s), ${cryptoOrders.length} crypto order(s) to process (batch size: ${MISMATCH_PARALLEL_TABS})`);
    cryptoOrders.forEach((o, i) => {
      log(`Mismatch crypto ${i + 1}: order_id=${o.order_id || o.transfer_reference_id} bank_name=${o.bank_name || o.bankName || 'null'}`);
    });

    // Process flat orders — 5 parallel tabs at a time
    if (flatOrders.length > 0 && isRunning) {
      await processMismatchBatch(flatOrders, 'flat', 'https://agent.upi9.pro/withdrawls/');
    }

    // Process crypto orders — 5 parallel tabs at a time
    if (cryptoOrders.length > 0 && isRunning) {
      if (flatOrders.length > 0) {
        log(`Mismatch: waiting ${MISMATCH_INTER_BATCH_DELAY_MS / 1000}s before crypto...`);
        await new Promise(r => setTimeout(r, MISMATCH_INTER_BATCH_DELAY_MS));
      }
      await processMismatchBatch(cryptoOrders, 'crypto', 'https://agent.upi9.pro/withdrawls/crypto');
    }

    log('=== Mismatch cycle END ===');
  } catch (e) {
    log(`Mismatch cycle error: ${e.message}`, 'error');
  }
}

async function ensureLoggedInAndOnWithdrawals(tabId) {
  try {
    if (!settings) {
      await loadSettings();
    }
    if (!settings) {
      log('[ensureLoggedInAndOnWithdrawals] ERROR: settings still null after loadSettings', 'error');
      return false;
    }
    log(`[ensureLoggedInAndOnWithdrawals] Starting for tab ${tabId}...`);
    log(`[ensureLoggedInAndOnWithdrawals] Username configured: ${settings.panelUsername ? 'yes' : 'no'}, Password configured: ${settings.panelPassword ? 'yes' : 'no'}`);
    
    // First, verify the actual URL in the content script matches what we think
    log(`[ensureLoggedInAndOnWithdrawals] Step 0: Verifying actual page URL...`);
    const urlRes = await sendToContent(tabId, 'getCurrentUrl').catch(e => {
      log(`[ensureLoggedInAndOnWithdrawals] Failed to get current URL: ${e.message}`, 'error');
    });
    if (urlRes) {
      log(`[ensureLoggedInAndOnWithdrawals] Content script reports URL: ${urlRes.url}, pathname: ${urlRes.pathname}`);
    }
    
    // Get tab info to compare
    const tabInfo = await chrome.tabs.get(tabId);
    log(`[ensureLoggedInAndOnWithdrawals] Tab URL from chrome.tabs: ${tabInfo.url}`);
    if (urlRes && tabInfo.url !== urlRes.url) {
      log(`[ensureLoggedInAndOnWithdrawals] WARNING: Tab URL mismatch! Tab says: ${tabInfo.url}, Content script says: ${urlRes.url}`, 'warn');
    }
    
    // Step 1a: Ping to check if we're on a page with login form
    log(`[ensureLoggedInAndOnWithdrawals] Step 1a: Testing content script communication...`);
    let pingTest;
    try {
      pingTest = await sendToContent(tabId, 'ping').catch(e => {
        log(`[ensureLoggedInAndOnWithdrawals] Ping test failed: ${e.message}`, 'error');
        return null;
      });
      if (pingTest) {
        log(`[ensureLoggedInAndOnWithdrawals] Ping test SUCCESS: ${JSON.stringify(pingTest)}`);
        if (pingTest.loginElementsFound) {
          log(`[ensureLoggedInAndOnWithdrawals] Login form elements status: ${JSON.stringify(pingTest.loginElementsFound)}`);
        }
      } else {
        log(`[ensureLoggedInAndOnWithdrawals] Ping test FAILED - content script not responding!`, 'error');
        return false;
      }
    } catch (pingError) {
      log(`[ensureLoggedInAndOnWithdrawals] Ping test error: ${pingError.message}`, 'error');
    }
    
    // If we're on /withdrawls/ and ping confirmed no login form, we're already logged in — skip navigation.
    // Only navigate to root login page if session appears expired (hasLoginForm=true or ping failed).
    const pathname = (urlRes && urlRes.pathname) || '';
    const onWithdrawalsPath = pathname.includes('/withdrawls');
    const alreadyLoggedIn = pingTest && !pingTest.hasLoginForm;
    if (onWithdrawalsPath && alreadyLoggedIn) {
      log(`[ensureLoggedInAndOnWithdrawals] Already on withdrawals path and logged in (no login form detected) — skipping navigation to login page`);
    } else if (onWithdrawalsPath) {
      log(`[ensureLoggedInAndOnWithdrawals] On withdrawals path but session may be expired — navigating to root login page so form can load...`);
      try {
        await chrome.tabs.update(tabId, { url: 'https://agent.upi9.pro/' });
        await waitForTabComplete(tabId, 15000);
        await ensureContentScriptInjected(tabId);
        await new Promise(r => setTimeout(r, 1500));
        const afterNav = await sendToContent(tabId, 'getCurrentUrl').catch(() => null);
        if (afterNav) {
          log(`[ensureLoggedInAndOnWithdrawals] After nav to root: url=${afterNav.url}, pathname=${afterNav.pathname}`);
        }
        const pageResAfterNav = await sendToContent(tabId, 'isLoginPage').catch(() => ({ isLoginPage: false }));
        if (!pageResAfterNav?.isLoginPage) {
          log(`[ensureLoggedInAndOnWithdrawals] No login form on / → trying /login...`, 'warn');
          await chrome.tabs.update(tabId, { url: 'https://agent.upi9.pro/login' });
          await waitForTabComplete(tabId, 12000);
          await ensureContentScriptInjected(tabId);
          await new Promise(r => setTimeout(r, 1200));
        }
      } catch (navErr) {
        log(`[ensureLoggedInAndOnWithdrawals] Nav to login page failed: ${navErr.message}`, 'warn');
      }
    }

    log(`[ensureLoggedInAndOnWithdrawals] Step 1b: Checking if on login page...`);
    const pageRes = await sendToContent(tabId, 'isLoginPage').catch(e => {
      log(`[ensureLoggedInAndOnWithdrawals] Failed to check login page: ${e.message}`, 'error');
      throw e;
    });
    log(`[ensureLoggedInAndOnWithdrawals] isLoginPage response: ${JSON.stringify(pageRes)}`);
    
    if (pageRes?.isLoginPage) {
      log(`[ensureLoggedInAndOnWithdrawals] Step 2: On login page, performing login with username=${settings.panelUsername?.substring(0, 5)}***...`);
      const loginRes = await sendToContent(tabId, 'performLogin', {
        username: settings.panelUsername,
        password: settings.panelPassword
      }).catch(e => {
        log(`[ensureLoggedInAndOnWithdrawals] Failed to perform login: ${e.message}`, 'error');
        throw e;
      });
      log(`[ensureLoggedInAndOnWithdrawals] performLogin response: ${JSON.stringify(loginRes)}`);
      if (!loginRes?.success) {
        log(`[ensureLoggedInAndOnWithdrawals] Login failed: ${loginRes?.message || 'unknown'}`, 'error');
        return false;
      }
      log(`[ensureLoggedInAndOnWithdrawals] Step 3: Login submitted successfully, waiting for redirect...`);
      await new Promise(r => setTimeout(r, 4000));
      log(`[ensureLoggedInAndOnWithdrawals] Step 4: Wait complete, verifying redirect...`);
      
      // Verify we're no longer on login page
      const afterLoginCheck = await sendToContent(tabId, 'isLoginPage').catch(() => ({ isLoginPage: true }));
      const afterUrlCheck = await sendToContent(tabId, 'getCurrentUrl').catch(() => null);
      if (afterUrlCheck) {
        log(`[ensureLoggedInAndOnWithdrawals] After login - URL: ${afterUrlCheck.url}, pathname: ${afterUrlCheck.pathname}`);
      }
      if (afterLoginCheck?.isLoginPage) {
        log(`[ensureLoggedInAndOnWithdrawals] WARNING: Still on login page after login attempt!`, 'warn');
      } else {
        log(`[ensureLoggedInAndOnWithdrawals] Successfully redirected from login page`);
      }
    } else {
      log(`[ensureLoggedInAndOnWithdrawals] Step 2: Not on login page (already logged in or page check failed)`);
    }
    
    // Skip navigation if already on withdrawals and logged in
    if (onWithdrawalsPath && alreadyLoggedIn) {
      log(`[ensureLoggedInAndOnWithdrawals] Step 5: Already on withdrawals — skipping navigation`);
    } else {
      log(`[ensureLoggedInAndOnWithdrawals] Step 5: Navigating to withdrawals page...`);
      const navRes = await sendToContent(tabId, 'navigateToWithdrawals').catch(e => {
        log(`[ensureLoggedInAndOnWithdrawals] Failed to navigate to withdrawals: ${e.message}`, 'error');
        throw e;
      });
      log(`[ensureLoggedInAndOnWithdrawals] navigateToWithdrawals response: ${JSON.stringify(navRes)}`);
      if (!navRes?.success) {
        log(`[ensureLoggedInAndOnWithdrawals] Navigate to withdrawals failed`, 'error');
        return false;
      }

      log(`[ensureLoggedInAndOnWithdrawals] Step 6: Waiting for withdrawals page to load...`);
      await new Promise(r => setTimeout(r, 2500));
    }

    // Verify we're actually on withdrawals page
    log(`[ensureLoggedInAndOnWithdrawals] Step 7: Verifying we're on withdrawals page...`);
    const finalUrlCheck = await sendToContent(tabId, 'getCurrentUrl').catch(() => null);
    const finalLoginCheck = await sendToContent(tabId, 'isLoginPage').catch(() => ({ isLoginPage: false }));
    if (finalUrlCheck) {
      log(`[ensureLoggedInAndOnWithdrawals] Final URL check: ${finalUrlCheck.url}, pathname: ${finalUrlCheck.pathname}`);
    }
    if (finalLoginCheck?.isLoginPage) {
      log(`[ensureLoggedInAndOnWithdrawals] ERROR: Still on login page after navigation!`, 'error');
      return false;
    }
    if (finalUrlCheck && !finalUrlCheck.pathname.includes('/withdrawls')) {
      log(`[ensureLoggedInAndOnWithdrawals] WARNING: Not on withdrawals page! Pathname: ${finalUrlCheck.pathname}`, 'warn');
    }

    // Apply Week filter immediately after page load
    log(`[ensureLoggedInAndOnWithdrawals] Step 8: Applying Week filter...`);
    await ensureContentScriptInjected(tabId);
    await new Promise(r => setTimeout(r, 300));
    await sendToContent(tabId, 'setDateFilterToWeek').catch(e =>
      log(`[ensureLoggedInAndOnWithdrawals] setDateFilterToWeek error: ${e.message}`, 'warn')
    );

    log(`[ensureLoggedInAndOnWithdrawals] Complete: Successfully logged in and navigated to withdrawals`);
    return true;
  } catch (e) {
    log(`[ensureLoggedInAndOnWithdrawals] ERROR: ${e.message}`, 'error');
    log(`[ensureLoggedInAndOnWithdrawals] Stack: ${e.stack}`, 'error');
    return false;
  }
}

// Helper: schedule next readerLoop only if still running
function scheduleReaderLoop(delayMs) {
  if (!isRunning) {
    log('[readerLoop] Stopped — not scheduling next iteration');
    return;
  }
  if (readerLoopTimer) clearTimeout(readerLoopTimer);
  readerLoopTimer = setTimeout(readerLoop, delayMs);
}

/**
 * Tab 1 loop: login → clickRefresh → runProcessCycle (flat rows) → every 5min also crypto.
 * Uses readerTabId exclusively. No mutex — runs independently of mismatch tab.
 */
async function readerLoop() {
  console.log(`[readerLoop] ========== CALLED ========== isRunning=${isRunning}`);
  if (readerLoopBusy) {
    log('[readerLoop] Previous iteration still in progress — skipping this run, rescheduling in 20s', 'warn');
    scheduleReaderLoop(PROCESS_INTERVAL_MS);
    return;
  }
  readerLoopBusy = true;
  log('[readerLoop] ========== Reader loop iteration START ==========');
  if (!isRunning) {
    log('[readerLoop] Not running, exiting');
    readerLoopBusy = false;
    return;
  }
  try {
    await getOrCreateReaderTab();
    // Re-apply tab title every cycle (page navigations reset document.title)
    chrome.scripting.executeScript({
      target: { tabId: readerTabId },
      func: () => { document.title = '📖 BOT – Reader Tab'; }
    }).catch(() => {});
    log(`[readerLoop] Step 1 complete: readerTabId=${readerTabId}`);
  } catch (e) {
    log(`[readerLoop] Step 1 FAILED: ${e.message}`, 'error');
    scheduleReaderLoop(30000);
    return;
  }

  if (!isRunning) { scheduleReaderLoop(0); return; }

  try {
    await loadSettings();
  } catch (e) {
    log(`[readerLoop] Step 2 FAILED: loadSettings: ${e.message}`, 'error');
    scheduleReaderLoop(30000);
    return;
  }

  if (!isRunning) { scheduleReaderLoop(0); return; }

  if (!settings || !settings.panelUsername || !settings.panelPassword) {
    log('[readerLoop] Step 2 FAILED: Missing panel credentials, retrying in 60s', 'error');
    scheduleReaderLoop(60000);
    return;
  }

  try {
    await new Promise(r => setTimeout(r, 1500));
    if (!isRunning) { log('[readerLoop] Stopped during wait'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }

    log('[readerLoop] Step 4: Ensuring logged in and on withdrawals page...');
    const ok = await ensureLoggedInAndOnWithdrawals(readerTabId);
    if (!isRunning) { log('[readerLoop] Stopped after login check'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }
    if (!ok) {
      log('[readerLoop] Step 4 FAILED: login/navigation failed, retrying in 60s', 'error');
      scheduleReaderLoop(60000);
      return;
    }

    await new Promise(r => setTimeout(r, 2000));
    if (!isRunning) { log('[readerLoop] Stopped during settle wait'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }

    // Ensure content script is ready
    let contentReady = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (!isRunning) break;
      try {
        const ping = await sendToContent(readerTabId, 'ping');
        if (ping) { contentReady = true; break; }
      } catch (e) {
        log(`[readerLoop] Step 5a: ping attempt ${attempt}/5 failed: ${e.message}`, 'warn');
      }
      if (!contentReady) await new Promise(r => setTimeout(r, 1500));
    }
    if (!isRunning) { log('[readerLoop] Stopped during ping'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }
    if (!contentReady) {
      log('[readerLoop] Step 5a FAILED: content script not responding, retrying in 60s', 'error');
      scheduleReaderLoop(60000);
      return;
    }

    log(`[readerLoop] Step 5b: Content script ready, checking if crypto processing needed...`);
    
    // Process crypto page (USDT etc.) every 1 minute so crypto withdrawals are created more often
    const CRYPTO_PROCESS_INTERVAL_MS = 60000; // 1 minute (was 3 min — USDT was not being created frequently enough)
    const timeSinceLastCrypto = Date.now() - lastCryptoPageVisitAt;
    const shouldProcessCrypto = lastCryptoPageVisitAt === 0 || timeSinceLastCrypto >= CRYPTO_PROCESS_INTERVAL_MS;
    
    log(`[readerLoop] Crypto check: lastCryptoPageVisitAt=${lastCryptoPageVisitAt}, timeSinceLastCrypto=${timeSinceLastCrypto}ms, shouldProcessCrypto=${shouldProcessCrypto} (USDT/crypto runs every ${CRYPTO_PROCESS_INTERVAL_MS / 1000}s)`);
    
    if (false && shouldProcessCrypto) {
      log(`[readerLoop] ========== Processing CRYPTO page (USDT etc. — every 1 min) ==========`);
      log(`[readerLoop] CRYPTO: Starting crypto processing cycle...`);
      log(`[readerLoop] CRYPTO: About to navigate to crypto page, readerTabId=${readerTabId}`);
      try {
        log(`[readerLoop] CRYPTO Step 1: Navigating to crypto withdrawals page...`);
      const navRes = await sendToContent(readerTabId, 'navigateToCryptoWithdrawals').catch(e => {
        log(`[readerLoop] CRYPTO: navigateToCryptoWithdrawals failed: ${e.message}`, 'error');
        throw e;
      });
      log(`[readerLoop] CRYPTO: navigateToCryptoWithdrawals response: ${JSON.stringify(navRes)}`);
      await new Promise(r => setTimeout(r, 2500));
      if (!isRunning) { log('[readerLoop] CRYPTO: Stopped during crypto nav'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }
      
      log(`[readerLoop] CRYPTO Step 2: Ensuring content script injected...`);
      await ensureContentScriptInjected(readerTabId);
        await new Promise(r => setTimeout(r, 500));
      
      // Verify we're on crypto page
      const currentPage = await sendToContent(readerTabId, 'getCurrentPage').catch(() => null);
      log(`[readerLoop] CRYPTO: Current page check: ${JSON.stringify(currentPage)}`);
      if (currentPage && !currentPage.isCrypto) {
        log(`[readerLoop] CRYPTO: WARNING - Not on crypto page! isCrypto=${currentPage.isCrypto}, pathname=${currentPage.pathname}`, 'warn');
        // Try navigating again
        await sendToContent(readerTabId, 'navigateToCryptoWithdrawals');
        await new Promise(r => setTimeout(r, 3000));
      }
      
      log(`[readerLoop] CRYPTO Step 3: Applying Week filter on crypto page...`);
        // Apply Week filter on crypto page immediately after navigation
      const filterRes = await sendToContent(readerTabId, 'setDateFilterToWeek').catch(e => {
        log(`[readerLoop] CRYPTO: setDateFilterToWeek on crypto page error: ${e.message}`, 'warn');
        return { success: false };
      });
      log(`[readerLoop] CRYPTO: setDateFilterToWeek response: ${JSON.stringify(filterRes)}`);
        await new Promise(r => setTimeout(r, 1000));
      
      log(`[readerLoop] CRYPTO Step 4: Clicking Refresh on crypto page...`);
      const refreshRes = await sendToContent(readerTabId, 'clickRefresh').catch(e => {
        log(`[readerLoop] CRYPTO: clickRefresh failed: ${e.message}`, 'error');
        throw e;
      });
      log(`[readerLoop] CRYPTO: clickRefresh response: ${JSON.stringify(refreshRes)}`);
        await new Promise(r => setTimeout(r, 2500));
      
      if (!isRunning) { log('[readerLoop] CRYPTO: Stopped before crypto cycle'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }
      
      log(`[readerLoop] CRYPTO Step 5: Running crypto process cycle...`);
      log(`[readerLoop] CRYPTO: About to call runCryptoProcessCycle...`);
      // Add timeout to prevent crypto processing from blocking flat processing
      const cryptoPromise = runCryptoProcessCycle(readerTabId);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Crypto processing timeout after 120s')), 120000)
      );
      try {
        await Promise.race([cryptoPromise, timeoutPromise]);
        lastCryptoPageVisitAt = Date.now();
        log(`[readerLoop] CRYPTO: runCryptoProcessCycle completed successfully`);
      } catch (timeoutError) {
        log(`[readerLoop] CRYPTO: runCryptoProcessCycle timed out or errored: ${timeoutError.message}`, 'warn');
        // Continue to flat processing even if crypto times out
      }
      log(`[readerLoop] ========== Crypto processing complete ==========`);
      
      // Navigate back to flat page after crypto processing
      log(`[readerLoop] FLAT: Navigating back to flat withdrawals page after crypto...`);
      try {
        await sendToContent(readerTabId, 'navigateToWithdrawals');
        await new Promise(r => setTimeout(r, 2500));
        await ensureContentScriptInjected(readerTabId);
        await new Promise(r => setTimeout(r, 300));
        // Apply Week filter immediately after returning to flat page
        await sendToContent(readerTabId, 'setDateFilterToWeek').catch(e =>
          log(`[readerLoop] setDateFilterToWeek after crypto→flat error: ${e.message}`, 'warn')
        );
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        log(`[readerLoop] Error navigating back to flat page: ${e.message}`, 'error');
      }
    } catch (e) {
      log(`[readerLoop] CRYPTO CYCLE ERROR: ${e.message}`, 'error');
      log(`[readerLoop] CRYPTO CYCLE ERROR STACK: ${e.stack}`, 'error');
      // Navigate back to flat page even if crypto fails
      try {
        await sendToContent(readerTabId, 'navigateToWithdrawals');
        await new Promise(r => setTimeout(r, 2000));
      } catch (navError) {
        log(`[readerLoop] Error navigating to flat after crypto error: ${navError.message}`, 'error');
      }
    }
    } // Close if (shouldProcessCrypto) block
    
    if (!shouldProcessCrypto) {
      log(`[readerLoop] Skipping crypto (USDT) this cycle — runs every 1 min. Next crypto in ${Math.round((CRYPTO_PROCESS_INTERVAL_MS - timeSinceLastCrypto) / 1000)}s`);
    }
    
    if (!isRunning) { log('[readerLoop] Stopped after crypto check'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }
    
    // Ensure we're on flat page before processing (in case we skipped crypto or are already on flat)
    log(`[readerLoop] FLAT: Checking current page before flat processing...`);
    const currentPage = await sendToContent(readerTabId, 'getCurrentPage').catch(() => null);
    log(`[readerLoop] FLAT: Current page check result: ${JSON.stringify(currentPage)}`);
    if (currentPage && !currentPage.isFlat) {
      log(`[readerLoop] FLAT: Not on flat page (isFlat=${currentPage.isFlat}), navigating to flat withdrawals page...`);
      try {
        await sendToContent(readerTabId, 'navigateToWithdrawals');
        await new Promise(r => setTimeout(r, 2000));
        await ensureContentScriptInjected(readerTabId);
        await new Promise(r => setTimeout(r, 300));
        await sendToContent(readerTabId, 'setDateFilterToWeek').catch(e =>
          log(`[readerLoop] setDateFilterToWeek error: ${e.message}`, 'warn')
        );
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        log(`[readerLoop] Error navigating to flat page: ${e.message}`, 'error');
      }
    } else {
      log(`[readerLoop] FLAT: Already on flat page, proceeding with flat processing...`);
    }
    
    if (!isRunning) { log('[readerLoop] Stopped before flat processing'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }

    // Flat page: clickRefresh (Refresh button + Week filter) then process
    // clickRefresh can take 2s wait + setDateFilterToWeek (~2–5s) — use 25s timeout so we don't abort before runProcessCycle
    log(`[readerLoop] FLAT: ========== STARTING FLAT PROCESSING ==========`);
    logToPage('FLAT: Starting flat transaction extraction — reader tab should be on /withdrawls/ (not crypto).', 'info');
    log(`[readerLoop] FLAT: About to click refresh and process flat transactions...`);
    log(`[readerLoop] FLAT: readerTabId=${readerTabId}, isRunning=${isRunning}`);
    try {
      await sendToContent(readerTabId, 'clickRefresh', {}, false, 25000);
      log(`[readerLoop] FLAT: clickRefresh completed, waiting 2.5s...`);
    } catch (e) {
      log(`[readerLoop] FLAT: clickRefresh failed or timed out: ${e.message} — proceeding with extraction anyway`, 'warn');
    }
    await new Promise(r => setTimeout(r, 2500));
    if (!isRunning) { 
      log('[readerLoop] Stopped before flat process cycle'); 
      scheduleReaderLoop(PROCESS_INTERVAL_MS); 
      return; 
    }
    log(`[readerLoop] FLAT: ========== CALLING runProcessCycle NOW ==========`);
    log(`[readerLoop] FLAT: Calling runProcessCycle to extract and process transactions...`);
    log(`[readerLoop] FLAT: runProcessCycle will extract rows and send to backend...`);
    await runProcessCycle(readerTabId);
    log(`[readerLoop] FLAT: ========== runProcessCycle COMPLETED ==========`);
    if (!isRunning) { log('[readerLoop] Stopped after flat process cycle'); scheduleReaderLoop(PROCESS_INTERVAL_MS); return; }

  } catch (e) {
    log(`[readerLoop] ERROR: ${e.message}`, 'error');
    log(`[readerLoop] Stack trace: ${e.stack}`, 'error');
    scheduleReaderLoop(60000);
    return;
  } finally {
    readerLoopBusy = false;
  }

  // Next iteration starts PROCESS_INTERVAL_MS (20s) after this one *ended*. So total period = (this run duration + 20s).
  log(`[readerLoop] ========== Iteration END — next run in ${PROCESS_INTERVAL_MS / 1000}s (delay between end of this run and start of next) ==========`);
  scheduleReaderLoop(PROCESS_INTERVAL_MS);
}

/**
 * Mismatch poll loop: every 60s, fetch mismatch orders → open fresh tab(s) → process batches → close tabs.
 * No persistent mismatch tab — each batch gets its own tab (like depositflow-ce).
 * Starts 10s after automation start (reader tab logs in first via shared cookies).
 */
function startMismatchPolling() {
  log(`Mismatch polling will start in 10s, then every ${MISMATCH_POLL_INTERVAL_MS / 60000} min (batch size: ${MISMATCH_PARALLEL_TABS})`);
  const poll = async () => {
    if (!isRunning) return;
    if (mismatchPollBusy) {
      log('Mismatch poll: previous cycle still running, skipping this run', 'warn');
      if (isRunning) {
        mismatchPollTimer = setTimeout(poll, MISMATCH_POLL_INTERVAL_MS);
      }
      return;
    }
    mismatchPollBusy = true;
    log('Mismatch poll: RUNNING (fetch orders → open fresh tab per batch → process → close)...');
    try {
      await runMismatchCycle();
      log('Mismatch poll done');
    } catch (e) {
      log(`Mismatch poll error: ${e.message} - will retry next cycle`, 'error');
    } finally {
      mismatchPollBusy = false;
      if (isRunning) {
        log(`Next mismatch poll in ${MISMATCH_POLL_INTERVAL_MS / 60000} min`);
        mismatchPollTimer = setTimeout(poll, MISMATCH_POLL_INTERVAL_MS);
      }
    }
  };
  mismatchPollTimer = setTimeout(poll, 10000); // 10s delay so reader tab logs in first via shared cookies
}

// Cleanup function to close leftover mismatch tabs and extra reader tabs
async function cleanupExtraBotTabs() {
  try {
    const allTabs = await chrome.tabs.query({ url: 'https://agent.upi9.pro/*' });
    const botTabs = [];
    for (const tab of allTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title
        });
        if (results && results[0] && results[0].result) {
          const title = results[0].result;
          if (title.includes('Reader Tab')) {
            botTabs.push({ id: tab.id, type: 'reader', title });
          } else if (title.includes('Mismatch Tab')) {
            // Mismatch tabs are temporary — close any leftover ones
            botTabs.push({ id: tab.id, type: 'mismatch', title });
          }
        }
      } catch (e) {
        // Tab not accessible, skip
      }
    }

    // Close all leftover mismatch tabs (they should have been closed after batch)
    const mismatchTabs = botTabs.filter(t => t.type === 'mismatch');
    for (const t of mismatchTabs) {
      try {
        await chrome.tabs.remove(t.id);
        log(`[cleanupExtraBotTabs] Closed leftover mismatch tab id=${t.id}`);
      } catch (e) {
        log(`[cleanupExtraBotTabs] Failed to close tab ${t.id}: ${e.message}`, 'warn');
      }
    }

    // Keep only one reader tab
    const readerTabs = botTabs.filter(t => t.type === 'reader');
    if (readerTabs.length > 1) {
      for (const t of readerTabs.slice(1)) {
        try {
          await chrome.tabs.remove(t.id);
          log(`[cleanupExtraBotTabs] Closed duplicate reader tab id=${t.id}`);
        } catch (e) {
          log(`[cleanupExtraBotTabs] Failed to close tab ${t.id}: ${e.message}`, 'warn');
        }
      }
    }
  } catch (e) {
    log(`[cleanupExtraBotTabs] Error: ${e.message}`, 'warn');
  }
}

async function startAutomation() {
  try {
    console.log(`${LOG_PREFIX} [startAutomation] Called`);
  if (isRunning) {
      console.log(`${LOG_PREFIX} [startAutomation] Already running, returning error`);
    return { error: 'Already running' };
  }
    
    // Cleanup any extra bot tabs before starting
    await cleanupExtraBotTabs();
    
  await loadSettings();
    console.log(`${LOG_PREFIX} [startAutomation] Settings loaded: username=${settings.panelUsername ? 'SET' : 'NOT SET'}, password=${settings.panelPassword ? 'SET' : 'NOT SET'}`);
  if (!settings.panelUsername || !settings.panelPassword) {
      console.log(`${LOG_PREFIX} [startAutomation] Missing credentials, returning error`);
    return { error: 'Configure panel username and password' };
  }
  if (!GATEWAYHUB_PUBLIC_KEY || !GATEWAYHUB_PRIVATE_KEY) {
      console.log(`${LOG_PREFIX} [startAutomation] GatewayHub keys missing, returning error`);
    return { error: 'GatewayHub keys not configured in background.js' };
  }
  isRunning = true;
  statusLog = [];

    // Persist running state to storage so we can restore after service worker restart
    await chrome.storage.local.set({ automationRunning: true });
    console.log(`${LOG_PREFIX} [startAutomation] Running state persisted to storage`);

  console.log(`${LOG_PREFIX} ═══════════════════════════════════════════`);
    console.log(`${LOG_PREFIX} AUTOMATION STARTED`);
  console.log(`${LOG_PREFIX} DB: ${settings.dbApiUrl} | User: ${settings.panelUsername}`);
    console.log(`${LOG_PREFIX} Reader Tab: persistent — flat + crypto row reading → DB/GatewayHub`);
    console.log(`${LOG_PREFIX} Mismatch: ${MISMATCH_PARALLEL_TABS} parallel tabs — 1 order per tab, open → process → close`);
    console.log(`${LOG_PREFIX} View logs: F12 on reader tab OR chrome://extensions → service worker`);
  console.log(`${LOG_PREFIX} ═══════════════════════════════════════════`);

    log('Automation started');
    log(`[startAutomation] Starting readerLoop (persistent tab)...`);
    readerLoop();
    log(`[startAutomation] readerLoop() called`);
    log(`[startAutomation] Starting mismatch polling (${MISMATCH_PARALLEL_TABS} parallel tabs)...`);
  startMismatchPolling();
    log(`[startAutomation] Both loops started independently`);
    console.log(`${LOG_PREFIX} [startAutomation] Successfully started, returning success`);
  return { success: true };
  } catch (error) {
    console.error(`${LOG_PREFIX} [startAutomation] Error:`, error);
    isRunning = false;
    await chrome.storage.local.set({ automationRunning: false });
    return { error: error.message || String(error) };
  }
}

function stopAutomation() {
  isRunning = false;
  lastCryptoPageVisitAt = 0; // reset so crypto page is visited fresh on next start

  // Clear persisted state
  chrome.storage.local.set({ automationRunning: false });

  if (readerLoopTimer) {
    clearTimeout(readerLoopTimer);
    readerLoopTimer = null;
  }
  if (mismatchPollTimer) {
    clearTimeout(mismatchPollTimer);
    mismatchPollTimer = null;
  }
  mismatchPollBusy = false;
  // Reader tab left open for inspection. Mismatch tabs are temporary and auto-closed.
  log('⏹️ Automation STOPPED — both loops halted');
  return { success: true };
}

// Handle service worker wake-up: if we were running, restart both loops
// Chrome service workers can be terminated and restarted, losing timers (but NOT tabs)
chrome.runtime.onStartup.addListener(() => {
  log('[onStartup] Service worker started');
  // Restore tab IDs from storage (tabs persist across service worker restarts)
  chrome.storage.local.get(['automationRunning', 'readerTabId'], (result) => {
    if (result.readerTabId) readerTabId = result.readerTabId;
    log(`[onStartup] Restored readerTabId=${readerTabId}`);
    if (result.automationRunning && !isRunning) {
      log('[onStartup] Automation was running, restarting both loops...');
      isRunning = true;
      scheduleReaderLoop(5000);
      startMismatchPolling();
    }
  });
});

// Keep service worker alive and restore state
chrome.runtime.onInstalled.addListener(() => {
  log('[onInstalled] Extension installed/updated');
  chrome.storage.local.get(['automationRunning', 'readerTabId'], (result) => {
    if (result.readerTabId) readerTabId = result.readerTabId;
    if (result.automationRunning && !isRunning) {
      log('[onInstalled] Automation was running, restarting both loops...');
      isRunning = true;
      scheduleReaderLoop(5000);
      startMismatchPolling();
    }
  });
});

// Periodic wake-up check: if isRunning but no timer, restart
// This handles cases where timers are lost due to service worker termination
setInterval(() => {
  // Keep service worker active by performing a small operation
  chrome.storage.local.get(['automationRunning']).catch(() => {});
  
  if (isRunning && !readerLoopTimer) {
    log('[wake-up check] Reader loop stopped but isRunning=true, restarting...', 'warn');
    scheduleReaderLoop(5000);
  }
  if (isRunning && !mismatchPollTimer && !mismatchPollBusy) {
    log('[wake-up check] Mismatch poll stopped but isRunning=true, restarting...', 'warn');
    startMismatchPolling();
  }
}, 30000); // Check every 30 seconds

// Additional keep-alive: perform activity every 60 seconds to prevent service worker from going inactive
setInterval(() => {
  // Perform a small operation to keep service worker active
  chrome.storage.local.get(['automationRunning']).then(() => {
    console.log(`${LOG_PREFIX} Keep-alive activity at ${new Date().toLocaleTimeString()}`);
  }).catch(() => {});
}, 60000); // Every 60 seconds

// Handle connections (used to wake up service worker)
chrome.runtime.onConnect.addListener((port) => {
  console.log(`${LOG_PREFIX} [onConnect] Connection received: ${port.name}`);
  port.onDisconnect.addListener(() => {
    console.log(`${LOG_PREFIX} [onConnect] Connection closed: ${port.name}`);
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log(`${LOG_PREFIX} [onMessage] Received action: ${request.action}`, request);
  // Send each extracted row to autoflow immediately (content sends after each row)
  if (request.action === 'onExtractedRow') {
    const row = request.row;
    const tabId = sender?.tab?.id;
    if (!row || !tabId) {
      log('[onExtractedRow] Missing row or tabId', 'warn');
      sendResponse({ error: 'Missing row or tabId' });
      return false;
    }
    (async () => {
      try {
        await loadSettings();
        const slug = getPanelUsernameSlug(settings.panelUsername);
        // Same as upi9prev: process crypto rows via processCryptoExtractedRow so USDT withdrawals are created
        if (row.is_crypto === true) {
          const hasCryptoWallet = !!(row.wallet_address && String(row.wallet_address).trim() && row.wallet_address !== '-');
          if (hasCryptoWallet) {
            log('[onExtractedRow] Crypto row — calling processCryptoExtractedRow');
            const result = await processCryptoExtractedRow(row, tabId);
            sendResponse(result || { success: true });
            return;
          }
          log('[onExtractedRow] Skipping crypto row (no wallet_address)');
          sendResponse({ skipped: true, reason: 'crypto_no_wallet' });
          return;
        }
        const tid = (row.transfer_reference_id || '').trim();
        if (!tid) {
          sendResponse({ error: 'No transfer_reference_id' });
          return;
        }
        const username = String(row.username || row.userName || row.user || '').trim();
        if (!username || username === '-') {
          log('[onExtractedRow] Skipping: no username - do not create without username', 'warn');
          sendResponse({ skipped: true, reason: 'no_username' });
          return;
        }
        const accNumber = String(row.acc_number || '').trim();
        const accHolderName = String(row.acc_holder_name || '').trim();
        if (!accNumber) {
          log('[onExtractedRow] Skipping: missing required account number', 'warn');
          sendResponse({ skipped: true, reason: 'no_acc_number' });
          return;
        }
        if (!accHolderName) {
          log('[onExtractedRow] Skipping: missing required account name (acc_holder_name)', 'warn');
          sendResponse({ skipped: true, reason: 'no_acc_holder_name' });
          return;
        }
        const orderId = `${tid}_${slug}`;
        const exists = await checkOrderExistsByOrderId(orderId);
        if (exists) {
          log(`[onExtractedRow] ${orderId} already in DB (order exists), not creating duplicate`, 'info');
          sendResponse({ skipped: true, reason: 'exists' });
          return;
        }
        log(`[onExtractedRow] Sending row to autoflow: transfer_id=${tid}, username=${row.username || row.userName || ''}`);
        const result = await processExtractedRow(row, tabId);
        sendResponse(result || { success: true });
      } catch (e) {
        log(`[onExtractedRow] Error: ${e.message}`, 'error');
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true; // Keep channel open for async response
  }
  const handlers = {
    ping: () => {
      console.log(`${LOG_PREFIX} [onMessage] Ping received - service worker is alive`);
      return { pong: true, timestamp: Date.now() };
    },
    startAutomation: () => {
      console.log(`${LOG_PREFIX} [onMessage] Handling startAutomation`);
      return startAutomation();
    },
    stopAutomation: () => {
      console.log(`${LOG_PREFIX} [onMessage] Handling stopAutomation`);
      return stopAutomation();
    },
    getStatus: () => {
      console.log(`${LOG_PREFIX} [onMessage] Handling getStatus`);
      return {
      isRunning,
        readerTabId,
        mismatchMode: 'fresh-tab-per-batch',
      log: statusLog.slice(-80).join('\n')
      };
    }
  };
  const fn = handlers[request.action];
  if (fn) {
    Promise.resolve(fn())
      .then(result => {
        console.log(`${LOG_PREFIX} [onMessage] ${request.action} result:`, result);
        sendResponse(result || { success: true });
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} [onMessage] Error handling ${request.action}:`, error);
        sendResponse({ error: error.message || String(error) });
      });
    return true; // Keep channel open for async response
  }
  console.warn(`${LOG_PREFIX} [onMessage] Unknown action: ${request.action}`);
  sendResponse({ error: 'Unknown action' });
});

// Service worker initialization - wrap in try-catch to catch load errors
try {
  console.log(`${LOG_PREFIX} ═══════════════════════════════════════════`);
  console.log(`${LOG_PREFIX} Service worker loaded and ready`);
  console.log(`${LOG_PREFIX} Listening: startAutomation, stopAutomation, getStatus, ping`);
  console.log(`${LOG_PREFIX} Inactive in chrome://extensions is normal; worker wakes on message or alarm.`);
  console.log(`${LOG_PREFIX} ═══════════════════════════════════════════`);

  // Keep-alive alarm: wakes service worker when inactive; restore loops if automation was running
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'keepAlive') {
        console.log(`${LOG_PREFIX} Keep-alive at ${new Date().toLocaleTimeString()}`);
        chrome.storage.local.get(['automationRunning', 'readerTabId']).then((result) => {
          if (result.automationRunning && !isRunning) {
            console.log(`${LOG_PREFIX} Restoring automation after wake (alarm)`);
            if (result.readerTabId) readerTabId = result.readerTabId;
            isRunning = true;
            scheduleReaderLoop(5000);
            startMismatchPolling();
          }
        }).catch(() => {});
      }
    });

    chrome.alarms.create('keepAlive', { periodInMinutes: 2 }).catch(err => {
      console.warn(`${LOG_PREFIX} Failed to create keep-alive alarm:`, err);
    });
    chrome.alarms.create('keepAliveImmediate', { delayInMinutes: 0.1 }).catch(() => {});

    chrome.storage.onChanged.addListener(() => {
      console.log(`${LOG_PREFIX} Storage change - worker active`);
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} Alarm setup failed:`, error);
  }

  // On every SW load (including after wake): restore loops if automation was running
  chrome.storage.local.get(['automationRunning', 'readerTabId']).then((result) => {
    if (result.readerTabId) readerTabId = result.readerTabId;
    if (result.automationRunning && !isRunning) {
      console.log(`${LOG_PREFIX} Restoring automation on load`);
      isRunning = true;
      scheduleReaderLoop(5000);
      startMismatchPolling();
    }
  }).catch(err => {
    console.warn(`${LOG_PREFIX} Error restoring state:`, err);
  });

  console.log(`${LOG_PREFIX} Service worker initialization complete`);
} catch (error) {
  console.error(`${LOG_PREFIX} CRITICAL ERROR during service worker initialization:`, error);
  console.error(`${LOG_PREFIX} Error stack:`, error.stack);
}
