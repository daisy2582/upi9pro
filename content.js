// Content script - runs on agent.upi9.pro
// Wrapped in IIFE + run-once guard so re-injection (e.g. ensureContentScriptInjected) doesn't throw "LOG_PREFIX already declared"
(function() {
  if (window.__agentWithdrawalContentLoaded) return;
  window.__agentWithdrawalContentLoaded = true;

const LOG_PREFIX = '🟢 AGENT-WITHDRAWAL [PAGE]';

/** Guard: only one FLAT extractAllRows run at a time. */
let extractAllRowsInProgress = false;
/** Guard: only one CRYPTO extractAllRows run at a time (crypto runs on crypto page so separate from flat). */
let cryptoExtractInProgress = false;

function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const out = `${LOG_PREFIX} [${ts}] ${msg}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

// Log immediately when script loads
log('[INIT] Content script loaded');
log(`[INIT] Current URL: ${window.location.href}`);
log(`[INIT] Current pathname: ${window.location.pathname}`);
log(`[INIT] Document ready state: ${document.readyState}`);
log('[INIT] Note: "ProSidebarProvider/useProSidebar deprecated" and "false filterCrypto" are from the panel app (agent.upi9.pro), not this extension — you can ignore them.');

// Run login-page test only on login page (pathname /), and without delay when DOM is ready
function onDomReady() {
  log('[INIT] DOM ready');
  if (window.location.pathname === '/' || window.location.pathname === '') {
    testLoginPageDetection();
    return;
  }
  if (isOnWithdrawalsPage()) {
    // No longer applying Week filter on init — avoids resetting to page 1 during pagination
    log('[INIT] On withdrawals page (filter not applied automatically).');
  }
}

/**
 * Retry setDateFilterToWeek every 2s until it succeeds (React may still be rendering).
 * Gives up after maxAttempts tries.
 */
async function applyWeekFilterWithRetry(maxAttempts = 15) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 2000));
    if (!isOnWithdrawalsPage()) {
      log('[applyWeekFilterWithRetry] No longer on withdrawals page, stopping retry');
      return;
    }
    log(`[applyWeekFilterWithRetry] Attempt ${attempt}/${maxAttempts}...`);
    const r = await setDateFilterToWeek();
    if (r?.success) {
      log(`[applyWeekFilterWithRetry] ✅ Week filter applied on attempt ${attempt}`);
      return;
    }
    log(`[applyWeekFilterWithRetry] Attempt ${attempt} failed: ${r?.message || 'unknown'} — retrying...`, 'warn');
  }
  log(`[applyWeekFilterWithRetry] ❌ Could not apply Week filter after ${maxAttempts} attempts`, 'warn');
}
if (document.readyState === 'loading') {
  log('[INIT] DOM still loading, waiting for DOMContentLoaded...');
  document.addEventListener('DOMContentLoaded', onDomReady);
} else {
  log('[INIT] DOM already ready');
  onDomReady();
}

// Test function to verify login page detection works
function testLoginPageDetection() {
  log('[TEST] Testing login page detection...');
  const userNameInput = document.querySelector('input[name="userName"]');
  const passInput = document.querySelector('input[name="password"]');
  const submitBtn = document.querySelector('button[type="submit"]');
  log(`[TEST] Found elements - userName: ${!!userNameInput}, password: ${!!passInput}, submit: ${!!submitBtn}`);
  if (userNameInput && passInput && submitBtn) {
    log('[TEST] ✅ All login form elements found - login should work!');
  } else {
    log('[TEST] ❌ Missing form elements - login may fail');
  }
}

/** Shared login form detection (used by isLoginPage and ping). Excludes modal inputs. */
function getLoginFormElements() {
  const isInModal = (el) => {
    if (!el) return false;
    return el.closest('.modal') !== null ||
           el.closest('.modal-content') !== null ||
           el.closest('.modal-content-main') !== null ||
           el.closest('[role="dialog"]') !== null;
  };
  const userNameInput = Array.from(document.querySelectorAll('input[name="userName"], input[name="username"], input[name="email"], input[type="text"][placeholder*="Username"], input[type="text"][placeholder*="username"], input[type="email"], form input[type="text"]'))
    .find(el => !isInModal(el) && el.name !== 'utrNumber' && el.name !== 'remarks');
  const passInput = Array.from(document.querySelectorAll('input[name="password"], input[type="password"], form input[type="password"]'))
    .find(el => !isInModal(el));
  const submitBtn = Array.from(document.querySelectorAll('button[type="submit"], button.btn-primary[type="submit"], form button[type="submit"], input[type="submit"]'))
    .find(el => !isInModal(el) && !el.textContent?.trim().match(/^(Approve|Reject|Cancel|Search|Refresh)$/i));
  const form = Array.from(document.querySelectorAll('form')).find(f => !isInModal(f));
  return { userNameInput, passInput, submitBtn, form };
}

function isLoginPage() {
  const currentUrl = window.location.href;
  const currentPath = window.location.pathname;
  log(`[isLoginPage] Checking... current URL: ${currentUrl}, pathname: ${currentPath}`);

  const { userNameInput, passInput, submitBtn, form } = getLoginFormElements();

  const isLogin = !!(userNameInput || passInput);
  log(`[isLoginPage] Result: ${isLogin}`);
  log(`[isLoginPage] Found elements:`);
  log(`[isLoginPage]   - form: ${!!form} ${form ? `(action="${form.action || 'none'}")` : ''}`);
  log(`[isLoginPage]   - userNameInput: ${!!userNameInput} ${userNameInput ? `(name="${userNameInput.name}", type="${userNameInput.type}", placeholder="${userNameInput.placeholder || 'none'}")` : ''}`);
  log(`[isLoginPage]   - passInput: ${!!passInput} ${passInput ? `(name="${passInput.name}", type="${passInput.type}")` : ''}`);
  log(`[isLoginPage]   - submitBtn: ${!!submitBtn} ${submitBtn ? `(type="${submitBtn.type}", text="${(submitBtn.textContent || submitBtn.value || '').trim().substring(0, 20)}")` : ''}`);

  if (isLogin) {
    const hasAll = userNameInput && passInput && submitBtn;
    log(`[isLoginPage] All required elements present: ${hasAll}`);
    if (!hasAll) {
      log(`[isLoginPage] Missing elements: ${!userNameInput ? 'userNameInput ' : ''}${!passInput ? 'passInput ' : ''}${!submitBtn ? 'submitBtn' : ''}`, 'warn');
    }
  }

  return isLogin;
}

function isOnWithdrawalsPage() {
  const path = window.location.pathname;
  const includes = path.includes('/withdrawls');
  log(`[isOnWithdrawalsPage] pathname=${path}, includes('/withdrawls')=${includes}`);
  return includes;
}

function isOnCryptoWithdrawalsPage() {
  const path = window.location.pathname;
  return path.includes('/withdrawls/crypto');
}

function isOnFlatWithdrawalsPage() {
  const path = window.location.pathname;
  return path.includes('/withdrawls') && !path.includes('/withdrawls/crypto');
}

function getCurrentUrl() {
  const url = window.location.href;
  const pathname = window.location.pathname;
  log(`[getCurrentUrl] href=${url}, pathname=${pathname}`);
  return { url, pathname };
}

/**
 * Perform login
 */
async function performLogin(username, password) {
  const currentUrl = window.location.href;
  log(`[performLogin] Starting... current URL: ${currentUrl}`);
  log(`[performLogin] Username provided: ${username ? `${username.substring(0, 5)}***` : 'NO USERNAME'}`);
  
  // Log password info without exposing it
  if (password) {
    const pwdLength = password.length;
    const firstChar = password.substring(0, 1);
    const lastChar = password.substring(pwdLength - 1);
    log(`[performLogin] Password provided: length=${pwdLength}, firstChar="${firstChar}", lastChar="${lastChar}"`);
  } else {
    log(`[performLogin] Password provided: NO PASSWORD`, 'error');
  }
  
  if (!username || !password) {
    log(`[performLogin] FAILED: Missing credentials`, 'error');
    return { success: false, message: 'Username or password not provided' };
  }
  
  // Verify password is not empty or just whitespace
  const trimmedPassword = password.trim();
  if (!trimmedPassword || trimmedPassword.length === 0) {
    log(`[performLogin] FAILED: Password is empty or whitespace only`, 'error');
    return { success: false, message: 'Password is empty' };
  }
  
  // Use trimmed password
  password = trimmedPassword;
  
  log(`[performLogin] Step 1: Searching for form elements (same as isLoginPage)...`);
  const { userNameInput, passInput, submitBtn, form } = getLoginFormElements();

  log(`[performLogin] Step 2: Element detection results:`);
  log(`[performLogin]   - form: ${form ? `found (action="${form.action || 'none'}")` : 'NOT FOUND'}`);
  log(`[performLogin]   - userNameInput: ${userNameInput ? `found (name="${userNameInput.name}", type="${userNameInput.type}", placeholder="${userNameInput.placeholder || 'none'}")` : 'NOT FOUND'}`);
  log(`[performLogin]   - passInput: ${passInput ? `found (name="${passInput.name}", type="${passInput.type}")` : 'NOT FOUND'}`);
  const submitText = submitBtn ? ((submitBtn.textContent || submitBtn.value || '').trim().substring(0, 30)) : 'NOT FOUND';
  log(`[performLogin]   - submitBtn: ${submitBtn ? `found (type="${submitBtn.type}", text="${submitText}")` : 'NOT FOUND'}`);

  if (!userNameInput) log('[performLogin] ERROR: userName input not found', 'error');
  if (!passInput) log('[performLogin] ERROR: password input not found', 'error');
  if (!submitBtn) log('[performLogin] ERROR: submit button not found', 'error');
  if (!userNameInput || !passInput || !submitBtn) {
    const missing = [];
    if (!userNameInput) missing.push('userNameInput');
    if (!passInput) missing.push('passInput');
    if (!submitBtn) missing.push('submitBtn');
    log(`[performLogin] FAILED: Missing elements: ${missing.join(', ')}`, 'error');
    
    // Try to find any inputs on the page for debugging
    const allInputs = document.querySelectorAll('input');
    log(`[performLogin] Debug: Found ${allInputs.length} total input elements on page`);
    allInputs.forEach((input, idx) => {
      log(`[performLogin]   Input ${idx}: name="${input.name}", type="${input.type}", placeholder="${input.placeholder || 'none'}"`);
    });
    
    const allButtons = document.querySelectorAll('button');
    log(`[performLogin] Debug: Found ${allButtons.length} total button elements on page`);
    allButtons.forEach((btn, idx) => {
      log(`[performLogin]   Button ${idx}: type="${btn.type}", text="${btn.textContent?.trim().substring(0, 30)}"`);
    });
    
    return { success: false, message: `Login form elements not found: ${missing.join(', ')}` };
  }

  log(`[performLogin] Step 3: Filling username field...`);
  // Clear first, then set value - use multiple methods to ensure it sticks
  userNameInput.focus();
  await new Promise(r => setTimeout(r, 100)); // Small delay for focus
  
  // Clear existing value
  userNameInput.value = '';
  userNameInput.setAttribute('value', '');
  
  // Set new value using multiple methods
  userNameInput.value = username;
  userNameInput.setAttribute('value', username);
  
  // Trigger multiple events to ensure the form recognizes the change
  const inputEvent = new Event('input', { bubbles: true, cancelable: true });
  const changeEvent = new Event('change', { bubbles: true, cancelable: true });
  const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'a' });
  
  userNameInput.dispatchEvent(inputEvent);
  userNameInput.dispatchEvent(changeEvent);
  userNameInput.dispatchEvent(keyupEvent);
  
  // Also try native value setter
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(userNameInput, username);
  
  log(`[performLogin] Username filled, value length: ${userNameInput.value.length}, value preview: ${userNameInput.value.substring(0, 3)}***`);
  log(`[performLogin] Username field value verified: "${userNameInput.value.substring(0, 5)}***"`);
  
  await new Promise(r => setTimeout(r, 200)); // Small delay between fields
  
  log(`[performLogin] Step 4: Filling password field...`);
  
  // Remove disabled attribute if present (some password managers may add this)
  if (passInput.hasAttribute('disabled')) {
    log(`[performLogin] Removing disabled attribute from password field`);
    passInput.removeAttribute('disabled');
  }
  
  // Remove readonly attribute if present
  if (passInput.hasAttribute('readonly')) {
    log(`[performLogin] Removing readonly attribute from password field`);
    passInput.removeAttribute('readonly');
  }
  
  // Remove autocomplete="off" if present (some password managers ignore fields with autocomplete="off")
  if (passInput.getAttribute('autocomplete') === 'off') {
    log(`[performLogin] Removing autocomplete="off" attribute to allow password manager compatibility`);
    passInput.removeAttribute('autocomplete');
  }
  
  passInput.focus();
  await new Promise(r => setTimeout(r, 150)); // Small delay for focus

  // Clear existing value first
  passInput.value = '';
  passInput.setAttribute('value', '');
  passInput.dispatchEvent(new Event('input', { bubbles: true }));
  passInput.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  // Set password value so it is entered correctly (native setter + events so site sees it)
  log(`[performLogin] Setting password value (length=${password.length})...`);
  
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (valueDescriptor && valueDescriptor.set) {
    valueDescriptor.set.call(passInput, password);
    log(`[performLogin] Used native value setter`);
  } else {
    passInput.value = password;
    log(`[performLogin] Used direct value assignment`);
  }
  passInput.setAttribute('value', password);
  
  // Fire InputEvent with data so frameworks (React/Vue) that listen for input see the value
  try {
    passInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: password, inputType: 'insertText' }));
  } catch (_) {
    passInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }
  passInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  passInput.dispatchEvent(new Event('blur', { bubbles: true }));
  passInput.focus();
  await new Promise(r => setTimeout(r, 80));
  
  // Re-apply value after focus in case the site cleared it on blur
  if ((passInput.value || '').length !== password.length) {
    if (valueDescriptor && valueDescriptor.set) valueDescriptor.set.call(passInput, password);
    else passInput.value = password;
    passInput.setAttribute('value', password);
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    passInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  await new Promise(r => setTimeout(r, 80));

  // Verify the value was set correctly
  const actualLength = passInput.value ? passInput.value.length : 0;
  log(`[performLogin] Password filled - actual length: ${actualLength}, expected: ${password.length}`);
  
  if (actualLength !== password.length) {
    log(`[performLogin] ⚠️ Password length mismatch! Trying alternative method...`, 'warn');
    // Try setting again with different approach
    passInput.value = '';
    await new Promise(r => setTimeout(r, 50));
    passInput.value = password;
    passInput.setAttribute('value', password);
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    passInput.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Verify again
    const retryLength = passInput.value ? passInput.value.length : 0;
    if (retryLength !== password.length) {
      log(`[performLogin] ⚠️ Password still incorrect after retry (length=${retryLength}, expected=${password.length})`, 'warn');
    } else {
      log(`[performLogin] ✅ Password set correctly after retry`);
    }
  } else {
    log(`[performLogin] ✅ Password set correctly`);
  }
  
  log(`[performLogin] Step 5: Verifying form values before submit...`);
  log(`[performLogin]   - Username field value: ${userNameInput.value ? `"${userNameInput.value.substring(0, 5)}***"` : 'EMPTY'}`);
  
  // Verify password was set correctly
  const passwordSet = passInput.value || '';
  const passwordSetLength = passwordSet.length;
  const expectedLength = password.length;
  const passwordMatches = passwordSetLength === expectedLength;
  
  log(`[performLogin]   - Password field value: ${passwordSetLength > 0 ? `SET (length=${passwordSetLength})` : 'EMPTY'}`);
  log(`[performLogin]   - Password verification: expected length=${expectedLength}, actual length=${passwordSetLength}, match=${passwordMatches}`);
  
  if (!passwordMatches) {
    log(`[performLogin] ⚠️ Password length mismatch detected! Expected ${expectedLength} chars, got ${passwordSetLength}`, 'warn');
    log(`[performLogin]   - First char of expected: "${password.substring(0, 1)}"`);
    log(`[performLogin]   - Last char of expected: "${password.substring(expectedLength - 1)}"`);
    if (passwordSetLength > 0) {
      log(`[performLogin]   - First char of actual: "${passwordSet.substring(0, 1)}"`);
      log(`[performLogin]   - Last char of actual: "${passwordSet.substring(passwordSetLength - 1)}"`);
    }
  }
  
  if (!userNameInput.value || !passInput.value) {
    log(`[performLogin] ERROR: Form values not set properly!`, 'error');
    log(`[performLogin]   - Username empty: ${!userNameInput.value}`);
    log(`[performLogin]   - Password empty: ${!passInput.value}`);
    return { success: false, message: 'Failed to set form values' };
  }
  
  if (!passwordMatches) {
    log(`[performLogin] ⚠️ WARNING: Password length mismatch, but proceeding anyway...`, 'warn');
  }
  
  log(`[performLogin] Step 6: Waiting 500ms before clicking submit...`);
  await new Promise(r => setTimeout(r, 500));
  
  log(`[performLogin] Step 7: Clicking submit button...`);
  // Try multiple ways to submit
  submitBtn.focus();
  await new Promise(r => setTimeout(r, 100));
  
  // Method 1: Direct click
  submitBtn.click();
  log(`[performLogin] Submit button clicked (method 1: click)`);
  
  await new Promise(r => setTimeout(r, 200));
  
  // Method 2: MouseEvent click (more realistic)
  const mouseClickEvent = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window
  });
  submitBtn.dispatchEvent(mouseClickEvent);
  log(`[performLogin] Submit button clicked (method 2: MouseEvent)`);
  
  await new Promise(r => setTimeout(r, 200));
  
  // Method 3: Form submit as fallback
  if (form) {
    log(`[performLogin] Also triggering form submit event (method 3)...`);
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    
    // Also try form.requestSubmit() if available
    if (typeof form.requestSubmit === 'function') {
      log(`[performLogin] Calling form.requestSubmit()...`);
      form.requestSubmit(submitBtn);
    }
  }
  
  log(`[performLogin] All submit methods attempted`);
  
  log(`[performLogin] Step 7: Waiting 2s to observe form submission...`);
  await new Promise(r => setTimeout(r, 2000));
  
  const afterUrl = window.location.href;
  const afterPath = window.location.pathname;
  log(`[performLogin] After submit - URL changed: ${currentUrl !== afterUrl ? 'YES' : 'NO'}`);
  log(`[performLogin] After submit - URL: ${afterUrl}, pathname: ${afterPath}`);
  
  // Check if we're still on login page
  const stillOnLogin = isLoginPage();
  if (stillOnLogin) {
    log(`[performLogin] WARNING: Still on login page after submit attempt`, 'warn');
  } else {
    log(`[performLogin] SUCCESS: No longer on login page`);
  }
  
  log(`[performLogin] Complete: ${stillOnLogin ? 'May have failed' : 'Success'}`);
  return { success: !stillOnLogin };
}

/**
 * Navigate to flat withdrawals page
 */
function navigateToWithdrawals() {
  const currentUrl = window.location.href;
  const currentPath = window.location.pathname;
  log(`[navigateToWithdrawals] Starting... current URL: ${currentUrl}, pathname: ${currentPath}`);

  if (isOnFlatWithdrawalsPage()) {
    log(`[navigateToWithdrawals] Already on flat withdrawals page`);
    return { success: true };
  }

  const targetUrl = 'https://agent.upi9.pro/withdrawls/';
  log(`[navigateToWithdrawals] Redirecting to flat withdrawals: ${targetUrl}`);
  window.location.href = targetUrl;
  log(`[navigateToWithdrawals] Navigation initiated`);
  return { success: true };
}

/**
 * Navigate to crypto withdrawals page
 */
function navigateToCryptoWithdrawals() {
  const currentUrl = window.location.href;
  const currentPath = window.location.pathname;
  log(`[navigateToCryptoWithdrawals] Starting... current URL: ${currentUrl}, pathname: ${currentPath}`);

  if (isOnCryptoWithdrawalsPage()) {
    log(`[navigateToCryptoWithdrawals] Already on crypto withdrawals page`);
    return { success: true };
  }

  const targetUrl = 'https://agent.upi9.pro/withdrawls/crypto/';
  log(`[navigateToCryptoWithdrawals] Redirecting to: ${targetUrl}`);
  window.location.href = targetUrl;
  log(`[navigateToCryptoWithdrawals] Navigation initiated`);
  return { success: true };
}

/**
 * Get value from modal by list-key label. Tries exact match and partial match.
 * Uses .text-value when present (e.g. Bank Name, Account Holder Name); otherwise uses .list-value text
 * (e.g. Amount, Transfer Reference ID, Merchant Reference ID - plain text in list-value).
 */
function getModalValue(modal, key) {
  const wrappers = modal.querySelectorAll('.list-wrapper');
  // First pass: Try exact match (case-insensitive)
  for (const w of wrappers) {
    const k = w.querySelector('.list-key');
    if (!k) continue;
    const keyText = k.textContent.trim();
    if (keyText.toLowerCase() === key.toLowerCase()) {
      const listVal = w.querySelector('.list-value');
      if (!listVal) return '';
      const textVal = listVal.querySelector('.text-value');
      const raw = (textVal ? textVal.textContent : listVal.textContent).trim();
      return raw;
    }
  }
  // Second pass: Try partial match (only if exact match failed)
  // This is less reliable but needed for fields like "Amount (in Native Currency)"
  for (const w of wrappers) {
    const k = w.querySelector('.list-key');
    if (!k) continue;
    const keyText = k.textContent.trim();
    if (keyText.toLowerCase().includes(key.toLowerCase())) {
      const listVal = w.querySelector('.list-value');
      if (!listVal) return '';
      const textVal = listVal.querySelector('.text-value');
      const raw = (textVal ? textVal.textContent : listVal.textContent).trim();
      return raw;
    }
  }
  return '';
}

/** Try multiple keys for Transfer Reference ID in modal */
function getTransferRefFromModal(modal) {
  const keys = ['Transfer Reference ID', 'Transfer ID', 'Transfer Reference Id', 'Transfer Ref'];
  for (const k of keys) {
    const v = getModalValue(modal, k);
    if (v) return v;
  }
  return '';
}

/**
 * Find the open View Transaction Details modal.
 * The modal wrapper uses class "modal-content-main" (inner content) inside ".modal-content"
 * We search for whichever element contains the modal-head-title.
 */
function findOpenModal() {
  // Primary: .modal-content-main (the actual inner wrapper from panel HTML)
  const byMain = document.querySelector('.modal-content-main');
  if (byMain) {
    const title = byMain.querySelector('.modal-head-title')?.textContent || '';
    if (title.includes('View Transaction Details') || title.includes('View Crypto Details')) return byMain;
  }
  // Fallback: .modal-content (older structure)
  const byContent = document.querySelector('.modal-content');
  if (byContent) {
    const title = byContent.querySelector('.modal-head-title')?.textContent || '';
    if (title.includes('View Transaction Details') || title.includes('View Crypto Details')) return byContent;
  }
  // Last resort: any element with modal-head-title
  const byTitle = document.querySelector('.modal-head-title');
  if (byTitle) {
    const titleText = byTitle.textContent || '';
    if (titleText.includes('View Transaction Details') || titleText.includes('View Crypto Details')) {
      return byTitle.closest('.modal-content-main, .modal-content, .modal-body, .modal') || byTitle.parentElement;
    }
  }
  return null;
}

/**
 * Parse amount string from modal — handles "170000 INR", "1,70,000", "₹170000" etc.
 * Returns integer.
 */
function parseModalAmount(amountStr) {
  if (!amountStr) return 0;
  // Remove currency symbols, letters, spaces, commas — keep only digits and dots
  // Handle Indian number format: "1,84,300" or "184,300" -> remove all commas
  const cleaned = String(amountStr).replace(/[₹$,\s]/g, '').replace(/[^0-9.]/g, '');
  // Take integer part only (no decimals for INR amounts)
  const parsed = parseInt(cleaned.split('.')[0], 10);
  if (isNaN(parsed) || parsed <= 0) {
    log(`parseModalAmount: WARNING - Invalid amount parsed: "${amountStr}" -> ${parsed}`, 'warn');
    return 0;
  }
  return parsed;
}

/**
 * Get amount from FLAT modal using ONLY the list-key "Amount" (or "Original Amount").
 * NEVER use "Total Amount", "Fee", or any other key — table has col-id="originalAmount" (Amount) and col-id="1" (Total Amount); we use Amount only.
 * Modal structure: .list-key "Amount" → .list-value "11067 INR" (no .text-value; use listVal.textContent).
 */
function getAmountFromFlatModal(modal) {
  const wrappers = modal.querySelectorAll('.list-wrapper');
  for (const w of wrappers) {
    const k = w.querySelector('.list-key');
    if (!k) continue;
    const keyText = (k.textContent || '').trim();
    // Explicit skip: never use Total Amount or Fee
    if (keyText === 'Total Amount' || keyText === 'Fee') continue;
    // Only "Amount" or "Original Amount"
    if (keyText !== 'Amount' && keyText !== 'Original Amount') continue;
    const listVal = w.querySelector('.list-value');
    if (!listVal) continue;
    const textVal = listVal.querySelector('.text-value');
    const amountStr = (textVal ? textVal.textContent : listVal.textContent).trim();
    if (!amountStr) continue;
    const amount = parseModalAmount(amountStr);
    if (amount > 0) return { amountStr, amount };
    return { amountStr, amount: 0 };
  }
  return { amountStr: '', amount: 0 };
}

/**
 * Extract transaction data from "View Transaction Details" modal (FLAT/INR).
 * RULE: Username from table row (col-id="userName") only; transfer_reference_id from row or modal; all other fields from this modal.
 * Amount: use list-key "Amount" only (first in modal body, e.g. "2000 INR") — never "Total Amount" or "Fee".
 */
function extractModalData() {
  const modal = findOpenModal();
  if (!modal) {
    log('extractModalData: modal not found');
    return null;
  }
  const title = modal.querySelector('.modal-head-title')?.textContent || '';
  if (!title.includes('View Transaction Details')) {
    log(`extractModalData: modal title mismatch "${title}"`);
    return null;
  }

  // Amount: ONLY exact list-key "Amount" (first in modal — e.g. "2000 INR"). Never "Total Amount" or "Fee".
  const { amountStr, amount } = getAmountFromFlatModal(modal);
  if (!amountStr) {
    log(`extractModalData: "Amount" not found in View Details - not using Total Amount; amount will be 0`, 'warn');
  }
  log(`extractModalData: raw amountStr="${amountStr}" parsed amount=${amount} (from View Details list-key "Amount" only)`);
  
  const transferRef = getTransferRefFromModal(modal);
  
  // Extract bank details - try multiple field name variations
  const bank_name = getModalValue(modal, 'Bank Name') || getModalValue(modal, 'Bank') || '';
  const acc_number = getModalValue(modal, 'Account Number') || getModalValue(modal, 'Account No') || '';
  const ifsc = getModalValue(modal, 'IFSC') || getModalValue(modal, 'Ifsc') || '';
  const acc_holder_name = getModalValue(modal, 'Account Holder Name') || getModalValue(modal, 'Account Holder') || getModalValue(modal, 'Holder Name') || getModalValue(modal, 'Beneficiary Name') || '';
  
  log(`extractModalData: Bank details (from modal) - bank_name="${bank_name}", acc_number="${acc_number}", ifsc="${ifsc}", acc_holder_name="${acc_holder_name}"`);
  
  // All fields below from View Details modal (username is set later from table row)
  const data = {
    amount,
    bank_name,
    acc_number,
    ifsc,
    acc_holder_name,
    transfer_reference_id: transferRef,
    order_date_raw: getModalValue(modal, 'Created At') || getModalValue(modal, 'Transaction Date') || getModalValue(modal, 'Date') || '',
    application_name: getModalValue(modal, 'Application Name') || '',
    user: getModalValue(modal, 'User') || getModalValue(modal, 'User Name') || getModalValue(modal, 'Username') || '', // overwritten with table username in openViewDetailsAndExtractForRow
    merchant_reference_id: getModalValue(modal, 'Merchant Reference ID') || getModalValue(modal, 'Merchant Ref') || '',
    utr: getModalValue(modal, 'UTR') || getModalValue(modal, 'Transaction ID') || '',
    status: getModalValue(modal, 'Status') || '',
    is_crypto: false
  };
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`${LOG_PREFIX} ===== READ FROM MODAL =====`);
  console.log(`${LOG_PREFIX} Amount: ${data.amount} | Transfer ID: ${data.transfer_reference_id}`);
  console.log(`${LOG_PREFIX} Bank: ${data.bank_name} | Acc: ${data.acc_number} | IFSC: ${data.ifsc}`);
  console.log(`${LOG_PREFIX} Holder: ${data.acc_holder_name} | App: ${data.application_name}`);
  console.log(`${LOG_PREFIX} Full data:`, data);
  console.log(`${LOG_PREFIX} ============================`);
  return data;
}

/**
 * Extract crypto transaction data from "View Crypto Details" / "View Transaction Details" modal.
 * RULE: Username is NOT taken from here — it comes from the table row (User column).
 * All other details below are from the modal only.
 */
function extractCryptoModalData() {
  log('extractCryptoModalData: START');
  const modal = findOpenModal();
  if (!modal) {
    log('extractCryptoModalData: modal not found', 'error');
    return null;
  }
  const title = modal.querySelector('.modal-head-title')?.textContent || '';
  log(`extractCryptoModalData: modal title="${title}"`);
  // Accept both "View Crypto Details" and "View Transaction Details" (for backward compatibility)
  if (!title.includes('View Crypto Details') && !title.includes('View Transaction Details')) {
    log(`extractCryptoModalData: modal title mismatch "${title}" - expected "View Crypto Details" or "View Transaction Details"`, 'warn');
    return null;
  }
  log(`extractCryptoModalData: modal title OK, extracting data...`);

  // Amount (in Native Currency): "81040 INR" -> for reference only (we use USDT value for GatewayHub)
  const nativeAmountStr = getModalValue(modal, 'Amount (in Native Currency)') || getModalValue(modal, 'Amount') || '';
  const amount = parseModalAmount(nativeAmountStr);
  log(`extractCryptoModalData: raw nativeAmountStr="${nativeAmountStr}" parsed amount=${amount}`);
  
  // For USDT/crypto: use "User Received Amount" only (e.g. "614 USDT" or "835.463918 USDT") - not Converted Amount or Amount (in Cryptocurrency)
  const userReceivedStr = getModalValue(modal, 'User Received Amount') || '';
  const cryptoAmountStr = userReceivedStr || getModalValue(modal, 'Amount (in Cryptocurrency)') || getModalValue(modal, 'Converted Amount') || '';
  const convertedAmount = parseFloat(String(cryptoAmountStr).replace(/[^0-9.]/g, '')) || 0;
  if (userReceivedStr) {
    log(`extractCryptoModalData: Using User Received Amount (USDT value): "${userReceivedStr}" -> ${convertedAmount}`);
  } else {
    log(`extractCryptoModalData: User Received Amount not found, fallback to Amount (in Cryptocurrency): "${cryptoAmountStr}" -> ${convertedAmount}`);
  }
  
  // Extract currency from the amount string we used (e.g., "614 USDT" or "835.463918 USDT" -> "USDT")
  let currency = '';
  const amountStrForCurrency = userReceivedStr || cryptoAmountStr;
  if (amountStrForCurrency) {
    const parts = amountStrForCurrency.trim().split(/\s+/);
    if (parts.length > 1) {
      currency = parts[parts.length - 1].toUpperCase(); // "USDT", "BTC", etc.
    }
  }
  if (!currency) {
    currency = getModalValue(modal, 'Blockchain') || getModalValue(modal, 'Currency') || getModalValue(modal, 'Crypto Name') || '';
  }
  
  const transferRef = getTransferRefFromModal(modal);
  log(`extractCryptoModalData: transfer_reference_id="${transferRef}"`);
  
  // User Wallet Address — try all known panel labels so USDT/crypto rows are created
  const walletAddress = getModalValue(modal, 'User Wallet Address') ||
                        getModalValue(modal, 'Wallet Address') ||
                        getModalValue(modal, 'Public Key') ||
                        getModalValue(modal, 'Receiver Address') ||
                        getModalValue(modal, 'To Address') ||
                        getModalValue(modal, 'Destination Address') ||
                        getModalValue(modal, 'Address') ||
                        '';
  log(`extractCryptoModalData: wallet_address="${(walletAddress || '').substring(0, 30)}${walletAddress && walletAddress.length > 30 ? '...' : ''}" (length=${(walletAddress || '').length})`);

  // CRITICAL: Only mark as crypto if wallet address exists (same as upi9prev)
  const hasValidWalletAddress = walletAddress && walletAddress.trim() !== '' && walletAddress !== '-';

  const data = {
    amount,
    converted_amount: convertedAmount,
    wallet_address: walletAddress,
    currency: currency || 'USDT', // Default to USDT if not found (same as upi9prev)
    crypto_name: currency || getModalValue(modal, 'Crypto Name') || getModalValue(modal, 'Blockchain') || '',
    wallet_name: getModalValue(modal, 'Wallet Name') || '',
    blockchain: getModalValue(modal, 'Blockchain') || '',
    transfer_reference_id: transferRef,
    order_date_raw: getModalValue(modal, 'Created At') || '',
    application_name: getModalValue(modal, 'Application Name') || '',
    user: getModalValue(modal, 'User') || '',
    merchant_reference_id: getModalValue(modal, 'Merchant Reference ID') || '',
    utr: getModalValue(modal, 'UTR') || getModalValue(modal, 'Transaction Hash') || '',
    is_crypto: hasValidWalletAddress // Only true if wallet address exists
  };
  if (!hasValidWalletAddress) {
    log(`extractCryptoModalData: ⚠️ Wallet address is empty - NOT marking as crypto (is_crypto=false)`);
  }
  log(`extractCryptoModalData: extracted data - transfer_id="${data.transfer_reference_id}", User Received Amount (USDT)=${data.converted_amount} ${data.currency}, native=${data.amount}, wallet="${data.wallet_address}"`);
  console.log(`${LOG_PREFIX} ===== READ FROM CRYPTO MODAL =====`);
  console.log(`${LOG_PREFIX} User Received Amount (USDT value sent to GatewayHub): ${data.converted_amount} ${data.currency} | Native: ${data.amount}`);
  console.log(`${LOG_PREFIX} Transfer ID: ${data.transfer_reference_id}`);
  console.log(`${LOG_PREFIX} Wallet: ${data.wallet_address} | Blockchain: ${data.blockchain}`);
  console.log(`${LOG_PREFIX} App: ${data.application_name} | User: ${data.user}`);
  console.log(`${LOG_PREFIX} Full data:`, data);
  console.log(`${LOG_PREFIX} ============================`);
  if (!data.transfer_reference_id) {
    log(`extractCryptoModalData: WARNING - transfer_reference_id is empty!`, 'warn');
  }
  return data;
}

/**
 * Fire a "real" mouse click so React/synthetic handlers see it.
 * Programmatic element.click() is often ignored by React; dispatching events works.
 */
function dispatchMouseClick(el) {
  if (!el || !el.getBoundingClientRect) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

/**
 * Close the details modal.
 * Checks .modal-content-main first (actual panel HTML), then .modal-content fallback.
 */
function closeModal() {
  const btn = document.querySelector('.modal-content-main .btn-close') ||
    document.querySelector('.modal-content .btn-close') ||
    document.querySelector('.modal .btn-close') ||
    document.querySelector('[class*="modal"] button[class*="close"]');
  if (btn) btn.click();
}

/**
 * Get all "View Details" buttons in row order (only from View Details column so username/row match is correct).
 * Pinned-right: Approve/Reject in one column, View Details (with SVG) in another. We return only View Details, one per row.
 */
function getViewDetailsButtons() {
  const buttons = [];
  const pinnedRight = document.querySelector('.ag-pinned-right-cols-container');
  if (pinnedRight) {
    const rows = pinnedRight.querySelectorAll('.ag-row');
    for (const row of rows) {
      // View Details is the button that has an SVG (Approve/Reject typically have no SVG)
      const viewBtn = Array.from(row.querySelectorAll('button.btn-link-primary')).find(btn => btn.querySelector('svg'));
      if (viewBtn) buttons.push(viewBtn);
    }
    if (buttons.length > 0) return buttons;
  }
  // Fallback: all btn-link-primary with svg in document order
  document.querySelectorAll('button.btn-link-primary').forEach(btn => {
    if (btn.querySelector('svg') && btn.closest('.ag-cell')) buttons.push(btn);
  });
  if (buttons.length > 0) return buttons;
  const fallback = [];
  document.querySelectorAll('.ag-row').forEach(row => {
    const viewBtn = row.querySelector('button.btn-link-primary svg')?.closest('button');
    if (viewBtn) fallback.push(viewBtn);
  });
  return [...new Set(fallback)];
}

/**
 * Get username from table row (User column). AG Grid splits rows; we match by row-index.
 * ALWAYS use this to get username from the table - never use modal data for username.
 * Scrolls to show User column first to ensure it's visible.
 * Per actual panel HTML: User column has col-id="1"
 */
function getUsernameFromRow(btn) {
  log(`getUsernameFromRow: START - extracting username from row`);
  
  // Ensure User column is visible (scroll left to show it)
  scrollTableTo(0);
  // Small delay to ensure column renders
  // Note: This is synchronous, so we can't await, but the caller should wait after scrolling

  const btnRow = btn.closest('.ag-row');
  if (!btnRow) {
    log('getUsernameFromRow: No row found for button', 'warn');
    return '';
  }
  const rowIndex = btnRow.getAttribute('row-index');
  if (!rowIndex) {
    log('getUsernameFromRow: No row-index attribute found', 'warn');
    return '';
  }
  log(`getUsernameFromRow: Button row-index="${rowIndex}"`);

  // Try center row first (AG Grid splits rows into left/center/right)
  const centerRow = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`);
  const rowToSearch = centerRow || btnRow;
  log(`getUsernameFromRow: Using ${centerRow ? 'center' : 'button'} row for extraction`);

  // Method 1: Try all known User column col-ids (actual panel uses col-id="1")
  let cell = null;
  let foundMethod = '';
  for (const colId of USER_COLUMN_IDS) {
    cell = rowToSearch.querySelector(`[col-id="${colId}"]`);
    if (cell) {
      foundMethod = `col-id="${colId}"`;
      break;
    }
  }
  
  // Method 2: If col-id didn't work, try finding by column header text "User"
  if (!cell) {
    log('getUsernameFromRow: col-id method failed, trying header-based method...');
    const headers = document.querySelectorAll('.ag-header-cell-label, .ag-header-cell-text');
    let userColIndex = -1;
    for (const header of headers) {
      const headerText = (header.textContent || '').trim().toLowerCase();
      if (headerText === 'user' || headerText.includes('user')) {
        const headerCell = header.closest('.ag-header-cell');
        if (headerCell) {
          const colId = headerCell.getAttribute('col-id');
          if (colId) {
            cell = rowToSearch.querySelector(`[col-id="${colId}"]`);
            if (cell) {
              foundMethod = `header-based col-id="${colId}"`;
              break;
            }
          }
          // Try by column index
          const allHeaders = document.querySelectorAll('.ag-header-cell');
          const headerIndex = Array.from(allHeaders).indexOf(headerCell);
          if (headerIndex >= 0) {
            const allCells = rowToSearch.querySelectorAll('.ag-cell');
            if (allCells[headerIndex]) {
              cell = allCells[headerIndex];
              foundMethod = `header-index=${headerIndex}`;
              break;
            }
          }
        }
      }
    }
  }
  
  // Method 3: Fallback to second ag-cell in the row (index 1, which is User after Date at index 0)
  if (!cell) {
    log('getUsernameFromRow: Header method failed, trying cell index fallback...');
    const allCells = rowToSearch.querySelectorAll('.ag-cell');
    log(`getUsernameFromRow: Found ${allCells.length} cells in row`);
    if (allCells.length >= 2) {
      cell = allCells[1];
      foundMethod = 'cell-index=1 (fallback)';
    }
  }

  if (!cell) {
    log('getUsernameFromRow: ⚠️ Could not find User column cell', 'warn');
    return '';
  }

  // Unwrap inner div if present (panel renders <div col-id="1"><div>f10arpit22</div></div>)
  const innerDiv = cell?.querySelector('div');
  let username = (innerDiv?.textContent || cell?.textContent || '').trim();
  if (username && isAppOrBranchName(username)) {
    log(`getUsernameFromRow: ⚠️ Cell value looks like app/branch name, not username: "${username}"`, 'warn');
    username = '';
  }
  if (username) {
    log(`getUsernameFromRow: ✅ Found username="${username}" using method: ${foundMethod}`);
  } else {
    log(`getUsernameFromRow: ⚠️ Username cell found but empty or invalid (method: ${foundMethod})`, 'warn');
    if (cell && !username) log(`getUsernameFromRow: Cell HTML: ${cell.outerHTML.substring(0, 200)}`);
  }
  return username;
}

/**
 * Scroll AG Grid horizontally. scrollLeft=0 shows Date/User; 2150px shows Transfer Reference ID column (col-id="transferReferenceId").
 */
function scrollTableTo(col) {
  const viewport = document.querySelector('.ag-body-horizontal-scroll-viewport') ||
    document.querySelector('.ag-center-cols-viewport') ||
    document.querySelector('.ag-body-viewport');
  if (viewport) viewport.scrollLeft = col;
}

/** Scroll so Transfer Reference ID column (col-id="transferReferenceId", header "Transfer Reference ID") is visible. Per AG Grid HTML it is at left: 2150px. */
function scrollTableToShowTransferRefColumn() {
  scrollTableTo(2150);
  log('scrollTableToShowTransferRefColumn: scrolled to 2150px to show Transfer Reference ID');
}

/**
 * Get the Next pagination button (the one that is not disabled).
 * Panel: <div class="pagination-container"><button class="pagination-btn">Previous</button><button class="pagination-btn disabled" disabled>Next</button></div>
 */
function getNextPageButton() {
  const container = document.querySelector('.pagination-container');
  const buttons = container
    ? container.querySelectorAll('button.pagination-btn')
    : document.querySelectorAll('button.pagination-btn');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (text.toLowerCase() === 'next' && !btn.disabled) return btn;
  }
  return null;
}

function hasNextPage() {
  return getNextPageButton() !== null;
}

/**
 * Click Next page and wait for table to update.
 * Scrolls pagination into view first so the button is visible and clickable.
 */
async function clickNextPage() {
  const container = document.querySelector('.pagination-container');
  if (container) {
    container.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));
  }
  const btn = getNextPageButton();
  if (!btn) {
    log('clickNextPage: no enabled Next button');
    return false;
  }
  log('clickNextPage: clicking Next...');
  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 200));
  try {
    if (typeof btn.click === 'function') btn.click();
    else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e) {
    log(`clickNextPage: click failed: ${e.message}`, 'warn');
    return false;
  }
  await new Promise(r => setTimeout(r, 2000));
  log('clickNextPage: done');
  return true;
}

/**
 * Apply search by Transfer Reference ID: select type, enter value, click search.
 * After searching, scrolls the table so Transfer Reference ID column is visible for row matching.
 */
async function applySearchByTransferReferenceId(transferRefId) {
  log(`applySearchByTransferReferenceId: ${transferRefId}`);
  const select = document.querySelector('select[name="searchType"]');
  if (!select) {
    log('applySearchByTransferReferenceId: searchType select not found', 'error');
    return { success: false, message: 'Search type select not found' };
  }
  select.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 200));

  // Step 1: Select "Transfer Reference ID" type
  select.value = 'transferReferenceId';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500)); // wait for input to become enabled

  // Step 2: Get the now-enabled search input and scroll into view (for small windows)
  const searchInput = getSearchByTransferRefInput();
  if (searchInput) {
    searchInput.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 200));
  }
  if (!searchInput) {
    log('applySearchByTransferReferenceId: search input not found after type selection', 'error');
    return { success: false, message: 'Search input not found' };
  }
  if (searchInput.disabled) searchInput.removeAttribute('disabled');

  // Step 3: Fill the search value
  log(`applySearchByTransferReferenceId: Setting search input value to: ${transferRefId}`);
  searchInput.value = transferRefId;
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  // Also trigger focus/blur to ensure React/other frameworks detect the change
  searchInput.focus();
  await new Promise(r => setTimeout(r, 100));
  searchInput.blur();
  await new Promise(r => setTimeout(r, 200));
  
  // Verify the value was set
  if (searchInput.value !== transferRefId) {
    log(`applySearchByTransferReferenceId: WARNING - Input value mismatch! Expected: ${transferRefId}, Got: ${searchInput.value}`, 'warn');
    // Try setting it again using setAttribute
    searchInput.setAttribute('value', transferRefId);
    searchInput.value = transferRefId;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  }
  log(`applySearchByTransferReferenceId: Search input value verified: ${searchInput.value}`);

  // Step 4: Click the "Search" button in filter footer (.filter-footer)
  // The exact button is: <button class="btn btn-primary">Search</button>
  log('applySearchByTransferReferenceId: Looking for Search button in filter footer...');
  
  let searchBtn = null;
  let searchClicked = false;
  
  // Strategy 1: Look for button with text "Search" in .filter-footer (PRIMARY - this is the correct button)
  const filterFooter = document.querySelector('.filter-footer');
  if (filterFooter) {
    log(`applySearchByTransferReferenceId: Found .filter-footer, looking for Search button...`);
    const buttons = filterFooter.querySelectorAll('button');
    log(`applySearchByTransferReferenceId: Found ${buttons.length} button(s) in .filter-footer`);
    
    for (const btn of buttons) {
      const btnText = (btn.textContent || '').trim();
      const btnClasses = btn.className;
      log(`applySearchByTransferReferenceId: Button in footer - text="${btnText}", classes="${btnClasses}"`);
      
      // Look for button with text "Search" and class "btn-primary"
      if (btnText.toLowerCase() === 'search' && btnClasses.includes('btn-primary')) {
        searchBtn = btn;
        log(`applySearchByTransferReferenceId: Found Search button in filter footer!`);
        break;
      }
    }
    
    // Fallback: if no exact match, look for any button with "Search" text
    if (!searchBtn) {
      for (const btn of buttons) {
        const btnText = (btn.textContent || '').trim().toLowerCase();
        if (btnText === 'search' && !btn.disabled) {
          searchBtn = btn;
          log(`applySearchByTransferReferenceId: Found Search button (fallback match)`);
          break;
        }
      }
    }
  }
  
  // Strategy 2: Global search for button with text "Search" and class "btn-primary"
  if (!searchBtn) {
    const allButtons = document.querySelectorAll('button.btn-primary');
    log(`applySearchByTransferReferenceId: Found ${allButtons.length} button(s) with .btn-primary class`);
    for (const btn of allButtons) {
      const btnText = (btn.textContent || '').trim();
      log(`applySearchByTransferReferenceId: Checking button with text="${btnText}"`);
      if (btnText.toLowerCase() === 'search' && !btn.disabled) {
        searchBtn = btn;
        log(`applySearchByTransferReferenceId: Found Search button globally`);
        break;
      }
    }
  }
  
  // Click the button if found
  if (searchBtn) {
    log(`applySearchByTransferReferenceId: Found Search button - classes="${searchBtn.className}", text="${searchBtn.textContent.trim()}"`);
    searchBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 200));
    
    // Try multiple click methods
    try {
      searchBtn.click();
      log('applySearchByTransferReferenceId: Search button.click() called');
      searchClicked = true;
    } catch (e) {
      log(`applySearchByTransferReferenceId: Button.click() failed: ${e.message}`, 'warn');
    }
    
    // Also try dispatching click event
    if (!searchClicked) {
      try {
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        searchBtn.dispatchEvent(clickEvent);
        log('applySearchByTransferReferenceId: MouseEvent click dispatched');
        searchClicked = true;
      } catch (e) {
        log(`applySearchByTransferReferenceId: MouseEvent dispatch failed: ${e.message}`, 'warn');
      }
    }
  } else {
    log('applySearchByTransferReferenceId: Search button not found in filter footer', 'warn');
    return { success: false, message: 'Search button not found in filter footer' };
  }
  
  if (!searchClicked) {
    log('applySearchByTransferReferenceId: WARNING - Search button was not clicked successfully', 'warn');
    return { success: false, message: 'Failed to click Search button' };
  }
  
  // Verify button was clicked by checking if search was triggered
  log('applySearchByTransferReferenceId: Search button clicked, waiting for search to process...');

  // Step 5: Wait for table to filter, then scroll to show Transfer Reference ID column (col-id="transferReferenceId" at 2150px)
  await new Promise(r => setTimeout(r, 2000)); // wait for table to render after search (reduced for speed)
  scrollTableTo(2150);
  await new Promise(r => setTimeout(r, 500)); // column to render
  return { success: true };
}

/**
 * Get the Refresh button element
 */
function getRefreshButton() {
  return [...document.querySelectorAll('button.btn')].find(b => b.textContent.trim() === 'Refresh');
}

/**
 * Clear search by clicking the close/cancel button (X button)
 * Looks for X icon button or cancel button near the search form
 */
async function clearSearchByCloseButton() {
  log('clearSearchByCloseButton: Looking for close/cancel button to clear search...');
  
  // Strategy 1: Look for button with X/close icon (common pattern: SVG with path containing "M18 6L6 18" or similar)
  const allButtons = document.querySelectorAll('button');
  let closeBtn = null;
  
  for (const btn of allButtons) {
    const svg = btn.querySelector('svg');
    if (svg) {
      const svgContent = svg.innerHTML || svg.outerHTML || '';
      // Check for X/close icon patterns in SVG
      if (svgContent.includes('M18 6L6 18') || 
          svgContent.includes('M6 6L18 18') ||
          svgContent.includes('d="M18 6') ||
          svgContent.includes('close') ||
          svgContent.includes('M6 18L18 6')) {
        // Check if button is near search form
        const searchForm = document.querySelector('.search-form, .search-filter-wrapper');
        if (searchForm && (searchForm.contains(btn) || btn.closest('.filter-top-left'))) {
          closeBtn = btn;
          log(`clearSearchByCloseButton: Found X button near search form`);
          break;
        }
      }
    }
    
    // Also check for cancel button text
    const text = btn.textContent.trim();
    if (text === 'Cancel' || text === 'X') {
      const searchForm = document.querySelector('.search-form, .search-filter-wrapper');
      if (searchForm && searchForm.contains(btn)) {
        closeBtn = btn;
        log(`clearSearchByCloseButton: Found Cancel button in search form`);
        break;
      }
    }
  }
  
  // Strategy 2: Look for btn-close class
  if (!closeBtn) {
    closeBtn = document.querySelector('.search-form .btn-close') ||
                document.querySelector('.filter-top-left .btn-close') ||
                document.querySelector('.search-filter-wrapper .btn-close') ||
                document.querySelector('.filter-top-left button.btn-close');
  }

  // Strategy 3: Cancel button in .filter-footer (same footer as Search — panel uses this to dismiss/cancel filter)
  if (!closeBtn) {
    const filterFooter = document.querySelector('.filter-footer');
    if (filterFooter) {
      for (const btn of filterFooter.querySelectorAll('button')) {
        const t = (btn.textContent || '').trim();
        if (t === 'Cancel' && !btn.disabled) {
          closeBtn = btn;
          log('clearSearchByCloseButton: Found Cancel button in .filter-footer');
          break;
        }
      }
    }
  }
  
  if (closeBtn) {
    log('clearSearchByCloseButton: Found close button, clicking to clear search');
    closeBtn.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 100));
    closeBtn.click();
    await new Promise(r => setTimeout(r, 500));
    return true;
  }
  
  log('clearSearchByCloseButton: Close button not found', 'warn');
  return false;
}

/** Selector for the Transfer Reference ID search input (clear this after Accept so page loads correctly) */
function getSearchByTransferRefInput() {
  return document.querySelector(
    'input[name="search"][placeholder*="Transfer Reference ID"], ' +
    'input[name="search"].form-control, ' +
    '.search-form input[name="search"], .search-field input[type="search"], input[name="search"]'
  );
}

/** Return the same Search button used by applySearchByTransferReferenceId (.filter-footer button with text "Search"). */
function getFilterFooterSearchButton() {
  const filterFooter = document.querySelector('.filter-footer');
  if (filterFooter) {
    for (const btn of filterFooter.querySelectorAll('button')) {
      const t = (btn.textContent || '').trim().toLowerCase();
      if (t === 'search' && !btn.disabled) return btn;
    }
  }
  for (const btn of document.querySelectorAll('button.btn-primary')) {
    if ((btn.textContent || '').trim().toLowerCase() === 'search' && !btn.disabled) return btn;
  }
  return document.querySelector('.search-form .btn-search, .btn-search, .search-field-filter-wrapper button.btn-link');
}

/**
 * Clear search (empty search input and click Search so table shows all).
 * Opens filter panel first if closed so the search input and Search button are visible.
 */
async function clearSearch() {
  // Ensure filter panel is open so search input and footer Search are visible
  if (!isFilterPanelOpen()) {
    const openBtn = getFilterOpenButton();
    if (openBtn) {
      log('clearSearch: Opening filter panel to clear search...');
      openBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(r => setTimeout(r, 200));
      openBtn.click();
      await new Promise(r => setTimeout(r, 800));
    }
  }
  const searchInput = getSearchByTransferRefInput();
  if (searchInput) {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    searchInput.focus();
    searchInput.blur();
  }
  const searchBtn = getFilterFooterSearchButton();
  if (searchBtn) {
    searchBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 150));
    searchBtn.click();
    log('clearSearch: Clicked Search with empty value to show all rows');
  } else {
    log('clearSearch: Filter footer Search button not found (panel may be closed)', 'warn');
  }
  await new Promise(r => setTimeout(r, 800));
}

/**
 * Reload table with Week filter so the next row iteration sees the full list.
 * Use after each row when transfer-ID search may have left the table with 1 row.
 * Clicks Refresh then applies Week filter (same as clickRefresh flow).
 */
async function reloadTableWithWeekFilter() {
  const refreshBtn = getRefreshButton();
  if (refreshBtn) {
    log('reloadTableWithWeekFilter: clicking Refresh to reset table...');
    refreshBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 200));
    try {
      if (typeof refreshBtn.click === 'function') refreshBtn.click();
      else dispatchMouseClick(refreshBtn);
    } catch (_) {
      dispatchMouseClick(refreshBtn);
    }
    await new Promise(r => setTimeout(r, 2200));
  } else {
    log('reloadTableWithWeekFilter: Refresh button not found, applying Week filter only', 'warn');
  }
  const filterResult = await setDateFilterToWeek();
  if (filterResult?.success) {
    log('reloadTableWithWeekFilter: table reloaded with Week filter');
  } else {
    log(`reloadTableWithWeekFilter: setDateFilterToWeek failed: ${filterResult?.message || 'unknown'}`, 'warn');
  }
  await new Promise(r => setTimeout(r, 500));
}

/**
 * Find the filter panel open button — the funnel SVG icon button.
 * Panel HTML: <button class="btn btn-secondary"><svg>...funnel path...</svg></button>
 * Funnel path from panel: d="M7.49991 16.5C7.21657 16.5..."
 */
function getFilterOpenButton() {
  const isFunnelSvg = (btn) => {
    const path = btn.querySelector('svg path');
    const d = path?.getAttribute('d') || '';
    return d.startsWith('M7.49991') || d.includes('16.5C7.21657') || (d.includes('16.5') && d.includes('0.5H15.4999'));
  };
  // 1) Any button.btn-secondary with the exact funnel SVG (no wrapper required)
  for (const btn of document.querySelectorAll('button.btn-secondary')) {
    if (btn.querySelector('svg') && isFunnelSvg(btn)) return btn;
  }
  // 2) Same but button with classes "btn" and "btn-secondary" (extra spaces in class list)
  for (const btn of document.querySelectorAll('button[class*="btn-secondary"]')) {
    if (btn.querySelector('svg') && isFunnelSvg(btn)) return btn;
  }
  // 3) Inside known wrappers
  const wrappers = document.querySelectorAll('.filter-option-wrapper, .filter-top-wrapper, .filter-top');
  for (const w of wrappers) {
    const btn = w.querySelector('button.btn-secondary, button[class*="btn-secondary"]');
    if (btn?.querySelector('svg')) return btn;
  }
  // 4) Last resort: first btn-secondary with any SVG
  for (const btn of document.querySelectorAll('button.btn-secondary')) {
    if (btn.querySelector('svg')) return btn;
  }
  return null;
}

/**
 * Check if the filter panel is currently open and visible (Week radio in DOM and panel visible).
 */
function isFilterPanelOpen() {
  const root = document.querySelector('.filter-content, .filter-content-main');
  if (!root) return false;
  // Flat page uses name="filterOptions", crypto page uses name="filterCrypto" (same as upi9prev)
  const weekRadio = root.querySelector('input[name="filterOptions"][value="Week"]') ||
    root.querySelector('input[name="filterOptions"][value="week"]') ||
    root.querySelector('input[name="filterCrypto"][value="Week"]') ||
    root.querySelector('input[name="filterCrypto"][value="week"]') ||
    root.querySelector('input[type="radio"][value="Week"]');
  if (!weekRadio) return false;
  // Panel is "open" only if the container is visible (not display:none or off-screen)
  const rect = root.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Set date filter to "Week" (1 week) and click Search.
 * Sequence: open filter panel (only if closed) → click Week → click Search button in panel footer.
 */
async function setDateFilterToWeek() {
  if (!isOnWithdrawalsPage()) return { success: false, message: 'Not on withdrawals page' };
  log('setDateFilterToWeek: START');

  // Step 1: Open filter panel only if it is not already open.
  // Clicking the button when already open would CLOSE it — so we check first.
  if (isFilterPanelOpen()) {
    log('setDateFilterToWeek: Step 1 — filter panel already open, skipping button click');
  } else {
    log('setDateFilterToWeek: Step 1 — filter panel closed, clicking filter button to open...');
    const filterBtn = getFilterOpenButton();
    if (!filterBtn) {
      log('setDateFilterToWeek: ❌ Filter button not found', 'warn');
      return { success: false, message: 'Filter button not found' };
    }
    filterBtn.click();
    // Poll until .filter-content is visible and Week radio exists (panel animation), up to ~4s
    let opened = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const panel = document.querySelector('.filter-content, .filter-content-main');
      if (panel && isFilterPanelOpen()) { opened = true; break; }
    }
    if (!opened) {
      log('setDateFilterToWeek: ❌ Filter panel did not open after clicking button', 'warn');
      return { success: false, message: 'Filter panel did not open' };
    }
    log('setDateFilterToWeek: ✅ Filter panel opened');
    await new Promise(r => setTimeout(r, 300)); // let options settle
  }

  // Scope to filter panel: .filter-content or .filter-content-main (per actual HTML)
  const filterPanelRoot = document.querySelector('.filter-content') || document.querySelector('.filter-content-main') || document.body;

  // Step 2: Find the Week radio (flat: name="filterOptions", crypto: name="filterCrypto" — same as upi9prev)
  let weekInput = filterPanelRoot.querySelector('input[name="filterOptions"][value="Week"]') ||
    filterPanelRoot.querySelector('input[name="filterOptions"][value="week"]') ||
    filterPanelRoot.querySelector('input[name="filterCrypto"][value="Week"]') ||
    filterPanelRoot.querySelector('input[name="filterCrypto"][value="week"]') ||
    filterPanelRoot.querySelector('input[type="radio"][value="Week"]') ||
    filterPanelRoot.querySelector('input[type="radio"][value="week"]');
  if (!weekInput) {
    const allRadios = filterPanelRoot.querySelectorAll('input[type="radio"][name="filterOptions"], input[type="radio"][name="filterCrypto"]');
    for (const r of allRadios) {
      const card = r.closest('.radio-button-card');
      const text = (card?.textContent || '').trim().toLowerCase();
      if (text === 'week') { weekInput = r; break; }
    }
  }
  if (!weekInput) {
    log('setDateFilterToWeek: ❌ Week radio not found', 'warn');
    return { success: false, message: 'Week filter option not found' };
  }
  log('setDateFilterToWeek: Step 2 — clicking Week option...');

  // Prefer native .click() to avoid Chrome password-manager getComputedStyle error on synthetic events; fallback to dispatchMouseClick if needed
  const card = weekInput.closest('.radio-button-card') || weekInput.closest('label') || weekInput.parentElement;
  if (card) {
    try {
      if (typeof card.click === 'function') card.click();
      else dispatchMouseClick(card);
    } catch (_) {
      dispatchMouseClick(card);
    }
    log('setDateFilterToWeek: Clicked parent card for Week radio');
  } else {
    try {
      if (typeof weekInput.click === 'function') weekInput.click();
      else dispatchMouseClick(weekInput);
    } catch (_) {
      dispatchMouseClick(weekInput);
    }
    weekInput.dispatchEvent(new Event('change', { bubbles: true }));
    log('setDateFilterToWeek: Directly clicked Week radio input');
  }
  await new Promise(r => setTimeout(r, 350));

  // Verify; if not checked, click card again (crypto page uses name="filterCrypto")
  let weekAfter = filterPanelRoot.querySelector('input[name="filterOptions"][value="Week"]') || filterPanelRoot.querySelector('input[name="filterOptions"][value="week"]') ||
    filterPanelRoot.querySelector('input[name="filterCrypto"][value="Week"]') || filterPanelRoot.querySelector('input[name="filterCrypto"][value="week"]');
  if (weekAfter && !weekAfter.checked) {
    const cardAgain = weekAfter.closest('.radio-button-card') || weekAfter.closest('label');
    if (cardAgain) {
      try {
        if (typeof cardAgain.click === 'function') cardAgain.click();
        else dispatchMouseClick(cardAgain);
      } catch (_) {
        dispatchMouseClick(cardAgain);
      }
    }
    await new Promise(r => setTimeout(r, 200));
    weekAfter = filterPanelRoot.querySelector('input[name="filterOptions"][value="Week"]') || filterPanelRoot.querySelector('input[name="filterOptions"][value="week"]') ||
      filterPanelRoot.querySelector('input[name="filterCrypto"][value="Week"]') || filterPanelRoot.querySelector('input[name="filterCrypto"][value="week"]');
    if (weekAfter && !weekAfter.checked) {
      weekAfter.checked = true;
      weekAfter.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  log(`setDateFilterToWeek: Week radio checked=${weekAfter?.checked ?? 'unknown'}`);

  // Step 3: Click the "Filter" button in .filter-footer (text exactly "Filter") — use real mouse event so React applies filter
  const footer = filterPanelRoot.querySelector('.filter-footer');
  let searchBtn = null;
  if (footer) {
    searchBtn = [...footer.querySelectorAll('button')].find(b => !b.disabled && (b.textContent || '').trim() === 'Filter');
  }
  if (!searchBtn && filterPanelRoot) {
    searchBtn = [...filterPanelRoot.querySelectorAll('button')].find(b => !b.disabled && (b.textContent || '').trim() === 'Filter');
  }
  if (!searchBtn) {
    searchBtn = [...document.querySelectorAll('.filter-content button, .filter-content-main button')].find(b => !b.disabled && (b.textContent || '').trim() === 'Filter');
  }
  if (!searchBtn) {
    const applyButtonTexts = ['filter', 'search', 'apply'];
    const isApplyButton = (b) => {
      if (b.disabled) return false;
      const t = (b.textContent || '').trim().toLowerCase();
      if (t.includes('cancel') || t.includes('close') || t.includes('reset')) return false;
      return applyButtonTexts.some((txt) => t === txt);
    };
    if (footer) searchBtn = [...footer.querySelectorAll('button')].find(isApplyButton);
    if (!searchBtn) searchBtn = [...(filterPanelRoot?.querySelectorAll('button') || [])].find(isApplyButton);
  }

  if (!searchBtn) {
    log('setDateFilterToWeek: ❌ Filter button not found in .filter-footer', 'warn');
    return { success: false, message: 'Filter button not found' };
  }

  log(`setDateFilterToWeek: Step 3 — clicking Filter (text="${searchBtn.textContent?.trim()}")`);
  try {
    if (typeof searchBtn.click === 'function') searchBtn.click();
    else dispatchMouseClick(searchBtn);
  } catch (_) {
    dispatchMouseClick(searchBtn);
  }
  await new Promise(r => setTimeout(r, 1200));
  log('setDateFilterToWeek: ✅ Done — table shows last 1 week');
  return { success: true };
}

/**
 * Set date filter to "Month" or "All" (whichever exists) so more rows are visible.
 * Used in fallback when search by transfer_id returns 0 rows (row may be outside Week range).
 */
async function setDateFilterToMonthOrAll() {
  if (!isOnWithdrawalsPage()) return { success: false, message: 'Not on withdrawals page' };
  if (!isFilterPanelOpen()) {
    const filterBtn = getFilterOpenButton();
    if (filterBtn) {
      filterBtn.click();
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (isFilterPanelOpen()) break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  const filterPanelRoot = document.querySelector('.filter-content') || document.querySelector('.filter-content-main') || document.body;
  // Try Month first, then All (same name pattern as Week: filterOptions / filterCrypto)
  const candidates = [
    { value: 'Month', label: 'month' },
    { value: 'month', label: 'month' },
    { value: 'All', label: 'all' },
    { value: 'all', label: 'all' },
  ];
  let optionInput = null;
  let chosenLabel = '';
  for (const { value, label } of candidates) {
    optionInput = filterPanelRoot.querySelector(`input[name="filterOptions"][value="${value}"]`) ||
      filterPanelRoot.querySelector(`input[name="filterCrypto"][value="${value}"]`) ||
      filterPanelRoot.querySelector(`input[type="radio"][value="${value}"]`);
    if (optionInput) {
      chosenLabel = label;
      break;
    }
  }
  if (!optionInput) {
    const allRadios = filterPanelRoot.querySelectorAll('input[type="radio"][name="filterOptions"], input[type="radio"][name="filterCrypto"]');
    for (const r of allRadios) {
      const card = r.closest('.radio-button-card');
      const text = (card?.textContent || '').trim().toLowerCase();
      if (text === 'month' || text === 'all') {
        optionInput = r;
        chosenLabel = text;
        break;
      }
    }
  }
  if (!optionInput) {
    log('setDateFilterToMonthOrAll: Month/All option not found, skipping', 'warn');
    return { success: false, message: 'Month/All filter not found' };
  }
  if (optionInput.checked) {
    log(`setDateFilterToMonthOrAll: ${chosenLabel} already selected`);
    return { success: true };
  }
  const card = optionInput.closest('.radio-button-card') || optionInput.closest('label') || optionInput.parentElement;
  if (card) {
    try {
      if (typeof card.click === 'function') card.click();
      else dispatchMouseClick(card);
    } catch (_) {
      dispatchMouseClick(card);
    }
  } else {
    try {
      if (typeof optionInput.click === 'function') optionInput.click();
      else dispatchMouseClick(optionInput);
    } catch (_) {
      dispatchMouseClick(optionInput);
    }
    optionInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 400));
  const footer = filterPanelRoot.querySelector('.filter-footer');
  let searchBtn = footer ? [...footer.querySelectorAll('button')].find(b => !b.disabled && (b.textContent || '').trim() === 'Filter') : null;
  if (!searchBtn) searchBtn = [...(filterPanelRoot?.querySelectorAll('button') || [])].find(b => !b.disabled && (b.textContent || '').trim() === 'Filter');
  if (searchBtn) {
    try {
      if (typeof searchBtn.click === 'function') searchBtn.click();
      else dispatchMouseClick(searchBtn);
    } catch (_) {
      dispatchMouseClick(searchBtn);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  log(`setDateFilterToMonthOrAll: ✅ Set to ${chosenLabel}`);
  return { success: true };
}

/** Get cell value from center row by col-id */
function getCellValue(centerRow, colId) {
  const cell = centerRow.querySelector(`[col-id="${colId}"]`);
  return cell?.textContent?.trim() || '';
}

/** Parse table date string (e.g. "16th Feb 2026, 10:51 am") to timestamp for comparison. Returns NaN if unparseable. */
function parseTableDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return NaN;
  const normalized = dateStr.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1').trim();
  const ts = Date.parse(normalized);
  return isNaN(ts) ? NaN : ts;
}

/** Date column col-ids to try — col-id="0" is the Date column per actual panel HTML */
const DATE_COLUMN_IDS = ['0', 'order_date', 'createdAt', 'date', 'created_at', 'orderDate'];

/**
 * User column col-ids to try. In the panel, col-id="userName" is the second column and holds the login username (e.g. rohan983637).
 * col-id="applicationName" is the third column (app/branch name like "Winfix branch 3 OPTION 1") — never use for username.
 * Order: userName first (confirmed second column), then fallbacks.
 */
const USER_COLUMN_IDS = ['userName', '1', 'username', 'user', 'userId'];

/** Returns true if value looks like app/branch name (e.g. "Winfix branch 3 OPTION 1"), not a login username. */
function isAppOrBranchName(value) {
  if (!value || typeof value !== 'string') return true;
  const v = value.trim().toLowerCase();
  if (v.length === 0) return true;
  // Single word like "winfix7355" or "rohan983637" = username; "Winfix branch 3 OPTION 1" = app name
  if (!/\s/.test(v)) return false; // no spaces → treat as username (e.g. winfix7355)
  return /\bbranch\b|option\s*\d|winfix\s+branch|winfix\s+option/i.test(v);
}

/**
 * Read Date (or Created At) from table for each row, without opening View Details.
 * Scrolls to start so first columns are visible. Returns Map: rowIndex -> { dateStr, ts }.
 */
async function getRowDatesFromTable() {
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 450));
  const center = document.querySelector('.ag-center-cols-container');
  const map = new Map();
  if (!center) return map;
  const rows = center.querySelectorAll('.ag-row');
  for (const row of rows) {
    const idx = row.getAttribute('row-index');
    if (idx === null || idx === undefined) continue;
    let dateStr = '';
    for (const colId of DATE_COLUMN_IDS) {
      const cell = row.querySelector(`.ag-cell[col-id="${colId}"], [col-id="${colId}"]`);
      dateStr = (cell?.textContent?.trim() || '').trim();
      if (dateStr) break;
    }
    const ts = parseTableDate(dateStr);
    map.set(idx, { dateStr, ts });
  }
  return map;
}

/**
 * Get View Details button for a specific row index.
 * Table: Amount = col-id="originalAmount" only (never Total Amount col-id="1"). View Details = last column, .ag-cell[col-id="3"] with button.btn-link-primary > svg.
 * After transfer_id search, pinned-right may be off-screen or row-index may not match; we scroll before calling and use by-order fallback.
 */
function getViewDetailsButtonForRow(rowIndex) {
  const idx = Number(rowIndex);
  const pinnedRight = document.querySelector('.ag-pinned-right-cols-container');
  if (pinnedRight) {
    // Primary: row by row-index, then cell with col-id="3" (gridcell has col-id attribute)
    const row = pinnedRight.querySelector(`.ag-row[row-index="${rowIndex}"]`);
    if (row) {
      const viewCell = row.querySelector('.ag-cell[col-id="3"], [col-id="3"]');
      if (viewCell) {
        const btn = viewCell.querySelector('button.btn-link-primary');
        if (btn && btn.querySelector('svg')) return btn;
      }
    }
    // Fallback: all View Details cells in pinned right are in row order (col-id="3")
    const viewCells = pinnedRight.querySelectorAll('.ag-cell[col-id="3"]');
    if (viewCells.length > idx) {
      const cell = viewCells[idx];
      const btn = cell && cell.querySelector('button.btn-link-primary');
      if (btn && btn.querySelector('svg')) return btn;
    }
    // Fallback: iterate pinned-right rows by DOM order, find View Details (col-id="3") or icon-only button
    const allRows = pinnedRight.querySelectorAll('.ag-row');
    if (allRows.length > idx) {
      const row = allRows[idx];
      const viewCell = row.querySelector('.ag-cell[col-id="3"], [col-id="3"]');
      if (viewCell) {
        const btn = viewCell.querySelector('button.btn-link-primary');
        if (btn && btn.querySelector('svg')) return btn;
      }
      const btns = row.querySelectorAll('button.btn-link-primary');
      for (const btn of btns) {
        if (!btn.querySelector('svg')) continue;
        const text = (btn.textContent || '').trim();
        if (text !== 'Approve' && text !== 'Reject') return btn;
      }
    }
  }
  // When pinned-right has no rows (e.g. filter open) or row-index mismatch: use DOM-order list (includes center/any .ag-cell View Details).
  const byOrder = getViewDetailsButtons();
  if (byOrder.length > idx) return byOrder[idx];
  return null;
}

/**
 * Open View Details modal for row, read Account Holder Name, close modal.
 * Returns the holder name or empty string on failure.
 */
async function getAccountHolderNameFromModalForRow(rowIndex) {
  const btn = getViewDetailsButtonForRow(rowIndex);
  if (!btn) {
    log(`getAccountHolderNameFromModalForRow: no View Details button for row ${rowIndex}`, 'warn');
    return '';
  }
  await waitForModalClosed(500);
  btn.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 300));
  try {
    if (typeof btn.click === 'function') btn.click();
    else dispatchMouseClick(btn);
  } catch (_) {
    dispatchMouseClick(btn);
  }
  const modal = await waitForModal(5000);
  if (!modal) {
    log(`getAccountHolderNameFromModalForRow: modal did not open for row ${rowIndex}`, 'warn');
    return '';
  }
  await waitForModalTransferRef(modal, 3000);
  await waitForModalAccountHolderName(modal, 3000);
  await new Promise(r => setTimeout(r, 150));
  const name = getModalValue(modal, 'Account Holder Name') || '';
  closeModal();
  await waitForModalClosed(2500);
  return name.trim();
}

/**
 * Open View Details modal for a row by index, extract data, close modal.
 * RULE:
 *   - Username: FROM ROW (table User column) — passed as usernameFromTable. Fallback to modal only if row is empty.
 *   - All other details: FROM VIEW DETAILS MODAL (amount, transfer_reference_id, bank_name, acc_number, ifsc, acc_holder_name, order_date_raw, application_name, utr, etc.).
 * expectedTransferId: optional; when set, verifies this row's transfer_reference_id matches (prefix) before opening modal.
 * Returns extracted data object or null on failure.
 */
async function openViewDetailsAndExtractForRow(rowIndex, usernameFromTable = null, expectedTransferId = null) {
  log(`openViewDetailsAndExtractForRow: START - rowIndex=${rowIndex}, usernameFromTable="${usernameFromTable || 'null'}", expectedTransferId="${expectedTransferId || 'null'}"`);
  // After transfer_id search, the pinned-right column (View Details) may be off-screen or not yet rendered. Scroll right first.
  scrollTableTo(9999);
  const pinnedEl = document.querySelector('.ag-pinned-right-cols-container');
  if (pinnedEl) pinnedEl.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 400));
  let btn = getViewDetailsButtonForRow(rowIndex);
  // After search, pinned right can render late; retry with scroll and longer waits for row 0
  if (!btn && rowIndex === 0) {
    for (const w of [400, 700, 1100]) {
      await new Promise(r => setTimeout(r, w));
      scrollTableTo(9999);
      await new Promise(r => setTimeout(r, 200));
      btn = getViewDetailsButtonForRow(rowIndex);
      if (btn) break;
    }
  }
  if (!btn) {
    log(`openViewDetailsAndExtractForRow: no View Details button for row ${rowIndex}`, 'warn');
    return null;
  }
  log(`openViewDetailsAndExtractForRow: Found button for row ${rowIndex}, button row-index="${btn.closest('.ag-row')?.getAttribute('row-index') || 'missing'}"`);
  if (expectedTransferId && (expectedTransferId = expectedTransferId.trim())) {
    scrollTableTo(2150);
    await new Promise(r => setTimeout(r, 250));
    const rowTransferId = getTransferIdFromRow(btn);
    // Pinned-right row often has no transferReferenceId column, so rowTransferId can be "". After search we have one row → trust expectedTransferId.
    const match = (rowTransferId && (rowTransferId === expectedTransferId || transferRefIdPrefixMatch(expectedTransferId, rowTransferId)))
      || (rowIndex === 0 && !rowTransferId && expectedTransferId);
    if (!match) {
      log(`openViewDetailsAndExtractForRow: Row transfer_id "${rowTransferId || ''}" does not match expected "${expectedTransferId}" - skipping`, 'warn');
      return null;
    }
    log(`openViewDetailsAndExtractForRow: Row verified - transfer_id matches expected${!rowTransferId ? ' (single row after search, trusting expectedTransferId)' : ''}`);
  }
  log(`openViewDetailsAndExtractForRow: clicking View Details for row ${rowIndex}`);
  let modal = null;
  try {
    await waitForModalClosed(500);
    const rowContainingBtn = btn.closest('.ag-row');
    if (rowContainingBtn) {
      rowContainingBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(r => setTimeout(r, 250));
    }
    btn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));
    log(`openViewDetailsAndExtractForRow: About to click button...`);
    try {
      if (typeof btn.click === 'function') btn.click();
      else dispatchMouseClick(btn);
    } catch (_) {
      dispatchMouseClick(btn);
    }
    log(`openViewDetailsAndExtractForRow: Button clicked, waiting for modal...`);
    
    modal = await waitForModal(8000); // 8s timeout
    if (!modal) {
      log(`openViewDetailsAndExtractForRow: modal did not open after native click, retrying with dispatchMouseClick (panel may require synthetic event)...`, 'warn');
      await waitForModalClosed(500);
      btn.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 300));
      dispatchMouseClick(btn);
      modal = await waitForModal(8000);
    }
    if (!modal) {
      log(`openViewDetailsAndExtractForRow: modal did not open for row ${rowIndex} (usernameFromTable="${usernameFromTable || ''}") after 8s — transaction NOT created`, 'warn');
      log(`openViewDetailsAndExtractForRow: If you see 401 Unauthorized on api-pg.*/withdrawlRequests in Network tab, the panel session expired — refresh the reader tab or re-login to the panel, then try again.`, 'warn');
      return null;
    }
    // Scroll modal into view so content is readable when window is small
    modal.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 200));
    log(`openViewDetailsAndExtractForRow: Modal opened, waiting for transfer ref...`);
    
    const transferRefReady = await waitForModalTransferRef(modal, 5000); // Increased timeout
    if (!transferRefReady) {
      log(`openViewDetailsAndExtractForRow: Transfer ref not ready after 5s, continuing anyway...`, 'warn');
    }
    log(`openViewDetailsAndExtractForRow: Transfer ref ready (or timeout), proceeding to extract...`);
  } catch (e) {
    log(`openViewDetailsAndExtractForRow: Error opening modal: ${e.message}`, 'error');
    closeModal(); // Try to close any open modal
    await waitForModalClosed(1000);
    return null;
  }

  if (!modal) {
    log(`openViewDetailsAndExtractForRow: Modal is null, cannot extract data`, 'warn');
    return null;
  }

  let data;
  try {
    if (isOnCryptoWithdrawalsPage()) {
      // Same as upi9prev: on crypto page check for bank details first — if present, treat as FLAT not crypto
      log(`openViewDetailsAndExtractForRow: CRYPTO page - checking for bank details first...`);
      await waitForModalAccountHolderName(modal, 1000);
      await new Promise(r => setTimeout(r, 100));
      const flatData = extractModalData();
      const hasBankDetails = flatData && (flatData.bank_name || flatData.acc_number || flatData.ifsc || flatData.acc_holder_name);

      if (hasBankDetails) {
        log(`openViewDetailsAndExtractForRow: Bank details found on crypto page - treating as FLAT transaction, NOT crypto`);
        data = flatData;
      } else {
        log(`openViewDetailsAndExtractForRow: No bank details found on crypto page - checking for wallet address...`);
        await waitForModalWalletAddress(modal, 1500);
        await new Promise(r => setTimeout(r, 150));
        log(`openViewDetailsAndExtractForRow: extracting crypto modal data...`);
        data = extractCryptoModalData();
        if (data && !data.transfer_reference_id) {
          log(`openViewDetailsAndExtractForRow: transfer_reference_id missing, retrying extraction...`);
          await new Promise(r => setTimeout(r, 200));
          data = extractCryptoModalData();
        }
        // Only mark as crypto if wallet address exists (empty bank alone = not crypto)
        const hasWalletAddress = data && data.wallet_address && data.wallet_address.trim() !== '' && data.wallet_address !== '-';
        if (!hasWalletAddress) {
          log(`openViewDetailsAndExtractForRow: No wallet address found - treating as FLAT transaction (empty bank details, not crypto)`);
          data = flatData || data;
          if (data) data.is_crypto = false;
        } else {
          log(`openViewDetailsAndExtractForRow: Wallet address found - marking as crypto`);
          if (data) data.is_crypto = true;
        }
        if (!data) {
          log(`openViewDetailsAndExtractForRow: crypto modal extraction returned null`, 'warn');
        } else if (!data.transfer_reference_id) {
          log(`openViewDetailsAndExtractForRow: crypto modal extraction missing transfer_reference_id`, 'warn');
        } else {
          log(`openViewDetailsAndExtractForRow: crypto modal extraction SUCCESS - transfer_id=${data.transfer_reference_id}, is_crypto=${data.is_crypto}`);
        }
      }
    } else {
      await waitForModalAccountHolderName(modal, 2000);
      await new Promise(r => setTimeout(r, 200));
      data = extractModalData();
      if (data && !data.transfer_reference_id) {
        await new Promise(r => setTimeout(r, 400));
        data = extractModalData();
      }
    }
  } catch (e) {
    log(`openViewDetailsAndExtractForRow: error extracting modal data: ${e.message}`, 'error');
    data = null;
  }

  // RULE: Username FROM ROW (table User column). All other details FROM VIEW DETAILS MODAL (already in data).
  closeModal();
  await waitForModalClosed(2500);
  if (!data) {
    log(`openViewDetailsAndExtractForRow: returning null (no data extracted)`);
    return null;
  }

  const rawTable = (usernameFromTable !== null && usernameFromTable !== undefined) ? String(usernameFromTable).trim() : '';
  const tableUsername = (rawTable && rawTable !== 'null') ? rawTable : '';
  const modalUser = (data.user || '').trim();
  const appName = (data.application_name || '').trim();

  // Username: from table row, then modal "User"/"User Name"/"Username", then application_name only if it looks like a username (e.g. winfix7355)
  let userName = '';
  if (tableUsername && tableUsername !== '-' && !isAppOrBranchName(tableUsername)) {
    userName = tableUsername;
    log(`openViewDetailsAndExtractForRow: ✅ Username FROM ROW (table User column): "${userName}"`);
  } else if (modalUser && modalUser !== '-' && !isAppOrBranchName(modalUser)) {
    userName = modalUser;
    log(`openViewDetailsAndExtractForRow: ⚠️ Username FROM MODAL (User/User Name): "${userName}"`);
  } else if (appName && appName !== '-' && !isAppOrBranchName(appName)) {
    userName = appName;
    log(`openViewDetailsAndExtractForRow: ⚠️ Username FROM MODAL Application Name (looks like username): "${userName}"`);
  } else if (tableUsername && tableUsername !== '-') {
    log(`openViewDetailsAndExtractForRow: ⚠️ Table value looks like app/branch name, not using: "${tableUsername}"`, 'warn');
  }
  if (!userName) {
    userName = '';
    log(`openViewDetailsAndExtractForRow: ⚠️ No valid username from row or modal (not using Application Name)`);
  }

  data.userName = userName;
  data.username = userName;
  data.user = userName;
  if (!data.is_crypto) {
    data.ifsc = (data.ifsc || '').trim().toUpperCase();
  }
  return data;
}

/**
 * Read username (User column) from table for each row. Scroll to show User column first.
 * Per actual panel HTML: User column has col-id="1", with an inner <div> wrapping the text.
 */
async function getUsernamesFromTableForPage() {
  log('getUsernamesFromTableForPage: Scrolling to show User column and reading usernames...');
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 600)); // Increased wait time for column to render
  
  const center = document.querySelector('.ag-center-cols-container');
  const map = new Map();
  if (!center) {
    log('getUsernamesFromTableForPage: ⚠️ Center container not found', 'warn');
    return map;
  }
  
  // First, identify the User column by header text
  let userColId = null;
  let userColIndex = -1;
  const headers = document.querySelectorAll('.ag-header-cell-label, .ag-header-cell-text');
  for (const header of headers) {
    const headerText = (header.textContent || '').trim().toLowerCase();
    if (headerText === 'user' || headerText.includes('user')) {
      const headerCell = header.closest('.ag-header-cell');
      if (headerCell) {
        const colId = headerCell.getAttribute('col-id');
        if (colId) {
          userColId = colId;
          log(`getUsernamesFromTableForPage: Found User column by header: col-id="${colId}"`);
        }
        // Also get column index
        const allHeaders = document.querySelectorAll('.ag-header-cell');
        userColIndex = Array.from(allHeaders).indexOf(headerCell);
        if (userColIndex >= 0) {
          log(`getUsernamesFromTableForPage: User column index: ${userColIndex}`);
        }
        break;
      }
    }
  }
  
  const rows = center.querySelectorAll('.ag-row');
  log(`getUsernamesFromTableForPage: Found ${rows.length} row(s), extracting usernames...`);
  
  rows.forEach((row, rowArrayIndex) => {
    const idx = row.getAttribute('row-index');
    if (!idx) {
      log(`getUsernamesFromRow: Row at array index ${rowArrayIndex} has no row-index attribute`, 'warn');
      return;
    }
    
    let cell = null;
    let foundMethod = '';
    
    // Method 1: Use identified col-id from header
    if (userColId) {
      cell = row.querySelector(`[col-id="${userColId}"]`);
      if (cell) {
        foundMethod = `header-identified col-id="${userColId}"`;
      }
    }
    
    // Method 2: Try all known User column col-ids
    if (!cell) {
      for (const colId of USER_COLUMN_IDS) {
        cell = row.querySelector(`[col-id="${colId}"]`);
        if (cell) {
          foundMethod = `known col-id="${colId}"`;
          break;
        }
      }
    }
    
    // Method 3: Use column index from header
    if (!cell && userColIndex >= 0) {
      const allCells = row.querySelectorAll('.ag-cell');
      if (allCells[userColIndex]) {
        cell = allCells[userColIndex];
        foundMethod = `column-index=${userColIndex}`;
      }
    }
    
    // Method 4: Fallback to second ag-cell in the row (index 1, which is User after Date at index 0)
    if (!cell) {
      const allCells = row.querySelectorAll('.ag-cell');
      if (allCells.length >= 2) {
        cell = allCells[1];
        foundMethod = 'cell-index=1 (fallback)';
      }
    }
    
    if (!cell) {
      log(`getUsernamesFromTableForPage: ⚠️ Row ${idx}: Could not find User column cell`, 'warn');
      map.set(idx, '');
      return;
    }
    
    // Unwrap inner div if present (panel renders <div col-id="1"><div>f10arpit22</div></div>)
    const innerDiv = cell.querySelector('div');
    const name = (innerDiv?.textContent || cell?.textContent || '').trim();
    
    if (name) {
      log(`getUsernamesFromTableForPage: ✅ Row ${idx}: username="${name}" (method: ${foundMethod})`);
    } else {
      log(`getUsernamesFromTableForPage: ⚠️ Row ${idx}: username cell found but empty (method: ${foundMethod})`, 'warn');
    }
    map.set(idx, name);
  });
  
  log(`getUsernamesFromTableForPage: Completed - extracted ${map.size} username(s)`);
  return map;
}

/**
 * Extract row data for the current page only.
 * We read: (1) Transfer Reference ID from the table (col-id="transferReferenceId", header "Transfer Reference ID");
 *          (2) Transfer ID from the View Details modal — same value, used as transfer_reference_id everywhere.
 * RULE: Username from table row (User column col-id="userName") only.
 * Amount and other details from View Details modal (list-key "Amount" only — never "Total Amount").
 * Flow: set Week filter → for each row: get transfer_reference_id from table (scroll 2150px to show column) or from one View Details →
 *       search by it → verify first row → View Details → username from row. Clear search + reload table after each row.
 * Returns { results, maxProcessedAt } (maxProcessedAt = max date of rows we actually processed).
 *
 * REASONS A TRANSACTION IS NOT CREATED (search PAGE console for "SKIPPED" or "NOT created"):
 * 1. Row has no transfer_reference_id in table and modal didn't return it → "SKIPPED: could not get transfer_reference_id"
 * 2. transfer_id already in DB (pending/in_process) → "SKIPPED: already in DB"
 * 3. Search by transfer_id failed (panel API/UI) → "search failed" then continue (no result pushed)
 * 4. Row transfer_id doesn't match expected after search → "does not match expected ... skipping"
 * 5. View Details modal did not open within 8s (even after retry) → "modal did not open ... transaction NOT created"
 * 6. Modal opened but no data / missing transfer_reference_id → "SKIPPED: no data or missing transfer_reference_id — transaction NOT created"
 * 7. No username after retries (table/modal) → "SKIPPED: no username after N retries"
 * 8. Missing account number (acc_number) → "SKIPPED: missing required account number"
 * 9. Missing account holder name (acc_holder_name) → "SKIPPED: missing required account name"
 * (Background can also reject: invalid amount, empty bank details, duplicate order_id, or crypto row in flat cycle.)
 */
async function extractOnePageRows(skipSet, center, lastProcessedAt = null) {
  const rows = center.querySelectorAll('.ag-row');
  const rowCount = rows.length;
  log(`extractOnePageRows: ${rowCount} row(s); flow: per-row Transfer Reference ID (table/modal) → search → View Details → username from row (no date filter applied)`);
  if (isOnCryptoWithdrawalsPage()) {
    log(`extractOnePageRows: CRYPTO page — USDT/crypto rows created only when View Details modal has a wallet field (User Wallet Address / Wallet Address / Receiver Address, etc.). Search for "wallet_address" or "is_crypto" in logs.`);
  }
  log(`extractOnePageRows: If some rows are NOT created, search this console for "SKIPPED" or "NOT created" to see the reason per row.`);

  // Do not apply Week filter here — it resets table to page 1 and breaks pagination (we stay on current page)
  await new Promise(r => setTimeout(r, 300));

  const results = [];
  for (let i = 0; i < rowCount; i++) {
    let transferId = '';
    try {
      // Scroll row into view so virtualized table renders it (works when window is small)
      const rowEl = center.querySelectorAll('.ag-row')[i];
      if (rowEl) {
        rowEl.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise(r => setTimeout(r, 300));
      }
      // 1) Get transfer_reference_id and username from same table row (process in table order: row 0, 1, 2, ...). Table date is ignored.
      const rowData = await getUsernameAndTransferIdFromSameRow(i);
      transferId = (rowData.transfer_reference_id || '').trim();
      let dataFromFirstModal = null; // when we open modal to get transfer_id we may get full crypto data — use it to skip search on crypto (avoids 401)
      if (!transferId) {
        log(`extractOnePageRows: Row ${i} has no transfer_reference_id in table; opening View Details once to get it...`);
        const modalData = await openViewDetailsAndExtractForRow(i, rowData.username || null, null);
        if (modalData && modalData.transfer_reference_id) {
          transferId = (modalData.transfer_reference_id || '').trim();
          log(`extractOnePageRows: Got transfer_id from modal: ${transferId}`);
          dataFromFirstModal = modalData;
        }
        if (!transferId) {
          log(`extractOnePageRows: Row ${i} SKIPPED: could not get transfer_reference_id`, 'warn');
          continue;
        }
      }
      if (isTransferIdExisting(transferId, skipSet)) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${transferId}") SKIPPED: already in DB`, 'info');
        continue;
      }

      // On crypto page: if we already have full crypto data from first modal, skip search (crypto search API often returns 401). Create order from modal data directly.
      const isCryptoFromFirstModal = dataFromFirstModal && (dataFromFirstModal.is_crypto === true) && !!(dataFromFirstModal.wallet_address && String(dataFromFirstModal.wallet_address).trim() && dataFromFirstModal.wallet_address !== '-');
      if (isOnCryptoWithdrawalsPage() && isCryptoFromFirstModal) {
        const data = dataFromFirstModal;
        const usernameFromRow = (rowData.username || '').trim() || (data.username || data.userName || data.user || '').trim() || '';
        data.username = usernameFromRow || data.username || data.userName || data.user || '';
        data.userName = data.username;
        data.user = data.username;
        log(`extractOnePageRows: Row ${i} CRYPTO — using data from first modal (skip search to avoid 401), transfer_id=${data.transfer_reference_id}`);
        results.push(data);
        const rowCopy = {
          amount: data.amount,
          converted_amount: data.converted_amount,
          wallet_address: data.wallet_address,
          currency: data.currency || 'USDT',
          crypto_name: data.crypto_name,
          bank_name: data.bank_name,
          acc_number: data.acc_number,
          ifsc: data.ifsc,
          acc_holder_name: data.acc_holder_name,
          transfer_reference_id: data.transfer_reference_id,
          username: data.username,
          userName: data.userName,
          user: data.user,
          order_date_raw: data.order_date_raw,
          application_name: data.application_name,
          merchant_reference_id: data.merchant_reference_id,
          utr: data.utr,
          status: data.status,
          is_crypto: true
        };
        try {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'onExtractedRow', row: rowCopy }, (response) => {
              if (chrome.runtime.lastError) log(`extractOnePageRows: onExtractedRow send error: ${chrome.runtime.lastError.message}`, 'warn');
              resolve(response);
            });
          });
        } catch (e) {
          log(`extractOnePageRows: onExtractedRow error: ${e.message}`, 'warn');
        }
        closeModal();
        await waitForModalClosed(500);
        const cleared = await clearSearchByCloseButton();
        if (!cleared) await clearSearch();
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // 2) Search by transfer_reference_id (filter Week already applied)
      const searchRes = await applySearchByTransferReferenceId(transferId);
      if (!searchRes.success) {
        log(`extractOnePageRows: Row ${i} search failed: ${searchRes.message}`, 'warn');
        await clearSearchByCloseButton() || await clearSearch();
        continue;
      }
      await new Promise(r => setTimeout(r, 800));

      // 3) Wait until first row shows expected transfer ID
      const firstRowMatches = await waitForFirstRowTransferIdToMatch(transferId, 12000);
      if (!firstRowMatches) {
        log(`extractOnePageRows: Row ${i} first row did not match transfer_id after search`, 'warn');
        await clearSearchByCloseButton() || await clearSearch();
        continue;
      }

      // 4–5) Get username and open View Details; retry up to 3 times if username not found
      const maxUsernameRetries = 3;
      let data = null;
      let bestUsernameFromTable = null; // keep first non-empty username across retries (table may re-render)
      for (let attempt = 1; attempt <= maxUsernameRetries; attempt++) {
        const firstRowData = await getUsernameAndTransferIdFromSameRow(0);
        const usernameFromFirstRow = (firstRowData.username || '').trim() || null;
        if (usernameFromFirstRow) bestUsernameFromTable = usernameFromFirstRow;
        const usernameToUse = usernameFromFirstRow || bestUsernameFromTable;

        const extractPromise = openViewDetailsAndExtractForRow(0, usernameToUse, transferId);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('openViewDetailsAndExtractForRow timeout 30s')), 30000)
        );
        data = await Promise.race([extractPromise, timeoutPromise]);

        if (data) {
          data.username = usernameToUse || data.username || data.userName || data.user || '';
          data.userName = data.username;
          data.user = data.username;
          // order_date_raw: from modal only (Created At / Transaction Date). Table date is not used.
        }

        const hasUsername = !!(data && (data.username || '').trim() && data.username.trim() !== '-');
        if (hasUsername) {
          log(`extractOnePageRows: Row ${i} username found on attempt ${attempt}: "${data.username}"`);
          break;
        }
        log(`extractOnePageRows: Row ${i} (usernameFromTable="${usernameToUse || bestUsernameFromTable || ''}") attempt ${attempt}/${maxUsernameRetries}: no username (table/modal); retrying...`, 'warn');
        closeModal();
        await waitForModalClosed(800);
        if (attempt < maxUsernameRetries) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      // FLAT: require username, acc_number, acc_holder_name. CRYPTO (same as upi9prev): require wallet_address + is_crypto; no bank details needed.
      const hasUsername = !!(data && (data.username || '').trim() && data.username.trim() !== '-');
      const isCryptoRow = data && (data.is_crypto === true) && !!(data.wallet_address && String(data.wallet_address).trim() && data.wallet_address !== '-');
      const hasAccNumber = !!(data && (data.acc_number || '').trim());
      const hasAccHolderName = !!(data && (data.acc_holder_name || '').trim());
      if (!data || !data.transfer_reference_id) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${transferId}", usernameFromTable="${bestUsernameFromTable || ''}") SKIPPED: no data or missing transfer_reference_id — transaction NOT created`, 'warn');
        log(`extractOnePageRows: Often caused by View Details modal not opening (e.g. panel 401 / session expired). Refresh reader tab or re-login, then run again.`, 'warn');
      } else if (skipSet.has(data.transfer_reference_id)) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${data.transfer_reference_id}") SKIPPED: already in DB`, 'info');
      } else if (isCryptoRow) {
        // Crypto (USDT): require transfer_id + wallet; username optional (same as upi9prev)
        log(`extractOnePageRows: Row ${i} (transfer_id="${data.transfer_reference_id}", wallet present, is_crypto=true) PROCESSING: crypto row [sending to autoflow]`);
        results.push(data);
        const rowCopy = {
          amount: data.amount,
          converted_amount: data.converted_amount,
          wallet_address: data.wallet_address,
          currency: data.currency || 'USDT',
          crypto_name: data.crypto_name,
          bank_name: data.bank_name,
          acc_number: data.acc_number,
          ifsc: data.ifsc,
          acc_holder_name: data.acc_holder_name,
          transfer_reference_id: data.transfer_reference_id,
          username: data.username,
          userName: data.userName,
          user: data.user,
          order_date_raw: data.order_date_raw,
          application_name: data.application_name,
          merchant_reference_id: data.merchant_reference_id,
          utr: data.utr,
          status: data.status,
          is_crypto: true
        };
        try {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'onExtractedRow', row: rowCopy }, (response) => {
              if (chrome.runtime.lastError) log(`extractOnePageRows: onExtractedRow send error: ${chrome.runtime.lastError.message}`, 'warn');
              resolve(response);
            });
          });
        } catch (e) {
          log(`extractOnePageRows: onExtractedRow error: ${e.message}`, 'warn');
        }
      } else if (!hasUsername) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${data.transfer_reference_id}") SKIPPED: no username after ${maxUsernameRetries} retries - not creating/sending`, 'warn');
      } else if (!hasAccNumber) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${data.transfer_reference_id}", username="${data.username}") SKIPPED: missing required account number (flat row)`, 'warn');
      } else if (!hasAccHolderName) {
        log(`extractOnePageRows: Row ${i} (transfer_id="${data.transfer_reference_id}", username="${data.username}") SKIPPED: missing required account name (acc_holder_name) (flat row)`, 'warn');
      } else {
        log(`extractOnePageRows: Row ${i} (username="${data.username}", acc_number="${data.acc_number}", acc_holder_name="${data.acc_holder_name}", transfer_id="${data.transfer_reference_id}") PROCESSING: required details present [sending to autoflow]`);
        results.push(data);
        const rowCopy = {
          amount: data.amount,
          bank_name: data.bank_name,
          acc_number: data.acc_number,
          ifsc: data.ifsc,
          acc_holder_name: data.acc_holder_name,
          transfer_reference_id: data.transfer_reference_id,
          username: data.username,
          userName: data.userName,
          user: data.user,
          order_date_raw: data.order_date_raw,
          application_name: data.application_name,
          merchant_reference_id: data.merchant_reference_id,
          utr: data.utr,
          status: data.status,
          is_crypto: data.is_crypto === true
        };
        try {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'onExtractedRow', row: rowCopy }, (response) => {
              if (chrome.runtime.lastError) log(`extractOnePageRows: onExtractedRow send error: ${chrome.runtime.lastError.message}`, 'warn');
              resolve(response);
            });
          });
        } catch (e) {
          log(`extractOnePageRows: onExtractedRow error: ${e.message}`, 'warn');
        }
      }
    } catch (e) {
      log(`extractOnePageRows: Row ${i} error: ${e.message}`, 'error');
      closeModal();
      await waitForModalClosed(1000);
    } finally {
      // Clear search so next iteration sees full table (no full reload per row — was causing 3–4s delay each and timeout before all rows)
      const cleared = await clearSearchByCloseButton();
      if (!cleared) await clearSearch();
      await new Promise(r => setTimeout(r, 800)); // allow table to re-render with full list
    }
  }
  // Clear search so next iteration sees full table; do not reload/apply Week filter (that resets to page 1)
  const cleared = await clearSearchByCloseButton();
  if (!cleared) await clearSearch();
  await new Promise(r => setTimeout(r, 500)); // allow table to re-render with full list for next page
  const skippedCount = rowCount - results.length;
  log(`extractOnePageRows: Completed ${rowCount} row(s) → ${results.length} sent to autoflow, ${skippedCount} skipped. ${skippedCount > 0 ? 'Search above for "SKIPPED" or "NOT created" for each reason.' : ''}`);
  return { results, maxProcessedAt: null };
}

/**
 * Extract all row data from table, with pagination (Next button until disabled).
 * Processes ALL rows regardless of date - only skips duplicates (already in DB).
 * Returns { rows, maxProcessedAt } (maxProcessedAt is null since we don't track dates anymore).
 */
async function extractAllRowsDataFromTable(existingIds = new Set(), lastProcessedAt = null) {
  const existingCount = (existingIds === null || existingIds === undefined) ? 0 : (existingIds instanceof Set ? existingIds.size : (existingIds.length ?? 0));
  log(`extractAllRowsDataFromTable: START (BULK mode) - existingIds=${existingCount}`);
  // Scroll table into view so virtualized rows render when window is small
  const tableEl = document.querySelector('.ag-center-cols-container, .ag-body-viewport');
  if (tableEl) {
    tableEl.scrollIntoView({ block: 'start', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));
  }
  const skipSet = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const allResults = [];
  let pageNum = 1;
  while (true) {
    log(`extractAllRowsDataFromTable: Processing page ${pageNum} (bulk read)...`);
    let center = document.querySelector('.ag-center-cols-container');
    if (!center) {
      for (let retry = 0; retry < 5; retry++) {
        await new Promise(r => setTimeout(r, 400));
        center = document.querySelector('.ag-center-cols-container');
        if (center) break;
      }
    }
    if (!center) {
      log('extractAllRowsDataFromTable: no center container after retries (table not ready or page changed)', 'warn');
      break;
    }
    // Use BULK page read: read all transfer IDs + usernames + amounts at once, then only open modals for new rows
    const { results: pageResults } = await bulkExtractCurrentPage(skipSet, center);
    log(`extractAllRowsDataFromTable: page ${pageNum} found ${pageResults.length} NEW row(s)`);
    for (const r of pageResults) {
      if (r.transfer_reference_id) skipSet.add(r.transfer_reference_id);
    }
    allResults.push(...pageResults);
    // Scroll pagination into view so Next button is visible and enabled state is correct
    const paginationContainer = document.querySelector('.pagination-container');
    if (paginationContainer) {
      paginationContainer.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      await new Promise(r => setTimeout(r, 400));
    }
    if (!hasNextPage()) {
      log(`extractAllRowsDataFromTable: no more pages (Next disabled)`);
      break;
    }
    const ok = await clickNextPage();
    if (!ok) {
      log(`extractAllRowsDataFromTable: clickNextPage returned false, stopping pagination`);
      break;
    }
    pageNum++;
    // Small delay between pages to avoid overwhelming the panel
    await new Promise(r => setTimeout(r, 1000));
  }
  log(`extractAllRowsDataFromTable: COMPLETE - ${allResults.length} total NEW row(s) across ${pageNum} page(s) (bulk mode)`);
  return { rows: allResults, maxProcessedAt: null };
}

/** Collect username (User column) for each row. Scrolls left, waits for re-render, then reads. */
async function collectUsernamesByRow() {
  const map = new Map();
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 450));
  const center = document.querySelector('.ag-center-cols-container');
  if (!center) return map;
  center.querySelectorAll('.ag-row').forEach(row => {
    const idx = row.getAttribute('row-index');
    let cell = null;
    for (const colId of USER_COLUMN_IDS) {
      cell = row.querySelector(`[col-id="${colId}"]`);
      if (cell) break;
    }
    if (!cell) {
      const allCells = row.querySelectorAll('.ag-cell');
      if (allCells.length >= 2) cell = allCells[1];
    }
    const innerDiv = cell?.querySelector('div');
    const name = (innerDiv?.textContent || cell?.textContent || '').trim();
    if (idx !== null && idx !== undefined) map.set(idx, name);
  });
  return map;
}

/**
 * Get Transfer Reference ID from table row. Same value as "Transfer ID" in View Details modal.
 * Reads from col-id="transferReferenceId" (header "Transfer Reference ID"). Column is at ~2150px — scroll first.
 * Returns empty string if column not visible (e.g. scrolled off / not rendered by AG Grid).
 */
function getTransferIdFromRow(btn) {
  const btnRow = btn.closest('.ag-row');
  if (!btnRow) return '';
  const rowIndex = btnRow.getAttribute('row-index');
  if (!rowIndex) return '';
  
  // Try multiple containers (left, center, right) - AG Grid splits rows across containers
  const containers = [
    document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`),
    document.querySelector(`.ag-left-cols-container .ag-row[row-index="${rowIndex}"]`),
    document.querySelector(`.ag-right-cols-container .ag-row[row-index="${rowIndex}"]`),
    btnRow // Fallback to the button's row
  ].filter(Boolean);
  
  // Try to find the transferReferenceId cell in any container
  for (const container of containers) {
    const cell = container.querySelector('[col-id="transferReferenceId"]');
    if (cell) {
      const text = cell.textContent?.trim() || '';
      if (text) return text;
    }
  }
  
  // Fallback: try to find by looking at all cells and matching column headers
  // This is less reliable but might work if col-id is not set correctly
  for (const container of containers) {
    const cells = container.querySelectorAll('.ag-cell');
    const headers = document.querySelectorAll('.ag-header-cell');
    let transferRefColIndex = -1;
    
    // Find the column index for transferReferenceId
    headers.forEach((header, idx) => {
      const colId = header.getAttribute('col-id');
      if (colId === 'transferReferenceId') {
        transferRefColIndex = idx;
      }
    });
    
    if (transferRefColIndex >= 0 && cells[transferRefColIndex]) {
      const text = cells[transferRefColIndex].textContent?.trim() || '';
      if (text) return text;
    }
  }
  
  return '';
}

/** Compare transfer reference IDs by prefix (first 8 chars). Returns true if both non-empty and prefixes match. */
function transferRefIdPrefixMatch(rowId, modalId) {
  const r = (rowId || '').trim();
  const m = (modalId || '').trim();
  if (!r || !m) return false;
  const prefixLen = 8;
  const rPrefix = r.length >= prefixLen ? r.substring(0, prefixLen) : r;
  const mPrefix = m.length >= prefixLen ? m.substring(0, prefixLen) : m;
  return rPrefix === mPrefix || r.startsWith(mPrefix) || m.startsWith(rPrefix);
}

/** Returns true if tid matches any id in existingIds (exact or prefix). */
function isTransferIdExisting(tid, existingIds) {
  if (!tid || !existingIds || !existingIds.size) return false;
  const t = (tid || '').trim();
  if (!t) return false;
  if (existingIds.has(t)) return true;
  for (const id of existingIds) {
    const s = (id || '').trim();
    if (!s) continue;
    if (t === s || t.startsWith(s) || s.startsWith(t)) return true;
  }
  return false;
}

/** Get transfer_reference_id from table row by index. Scrolls to show transferReferenceId column. */
async function getTransferReferenceIdFromRowByIndex(rowIndex) {
  const idx = Number(rowIndex);
  scrollTableTo(2150);
  await new Promise(r => setTimeout(r, 300));
  const center = document.querySelector('.ag-center-cols-container');
  if (!center) return '';
  let row = center.querySelector(`.ag-row[row-index="${rowIndex}"]`);
  if (!row) {
    const allRows = center.querySelectorAll('.ag-row');
    if (allRows.length > idx) row = allRows[idx];
  }
  if (!row) return '';
  const cell = row.querySelector('[col-id="transferReferenceId"]');
  if (cell) {
    const text = (cell.textContent || '').trim();
    if (text) return text;
  }
  const headers = document.querySelectorAll('.ag-header-cell');
  let transferRefColIndex = -1;
  headers.forEach((header, i) => {
    if (header.getAttribute('col-id') === 'transferReferenceId') transferRefColIndex = i;
  });
  if (transferRefColIndex >= 0) {
    const cells = row.querySelectorAll('.ag-cell');
    if (cells[transferRefColIndex]) {
      const text = (cells[transferRefColIndex].textContent || '').trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * Get username and Transfer Reference ID from the same table row.
 * Table: User column (col-id="userName"), Date (col-id="0"), Transfer Reference ID (col-id="transferReferenceId" at 2150px).
 * Transfer Reference ID in table = Transfer ID in View Details modal (same value).
 */
async function getUsernameAndTransferIdFromSameRow(rowIndex) {
  const idx = Number(rowIndex);
  const center = document.querySelector('.ag-center-cols-container');
  if (!center) return { username: '', transfer_reference_id: '' };
  let row = center.querySelector(`.ag-row[row-index="${rowIndex}"]`);
  if (!row) {
    const allRows = center.querySelectorAll('.ag-row');
    if (allRows.length > idx) row = allRows[idx];
  }
  if (!row) return { username: '', transfer_reference_id: '' };

  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 150));
  row = center.querySelector(`.ag-row[row-index="${rowIndex}"]`) || center.querySelectorAll('.ag-row')[idx];
  let username = '';
  let dateStr = '';
  if (row) {
    for (const colId of USER_COLUMN_IDS) {
      const userNameCell = row.querySelector(`[col-id="${colId}"]`);
      if (userNameCell) {
        const innerDiv = userNameCell.querySelector('div');
        let raw = (innerDiv?.textContent || userNameCell?.textContent || '').trim();
        if (!raw) continue;
        if (/^\d+$/.test(raw) && raw.length >= 10) continue; // skip account numbers (10+ pure digits), allow short numeric usernames
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) continue; // skip UUID
        if (isAppOrBranchName(raw)) continue; // skip "Winfix branch 3 OPTION 1" etc.
        username = raw;
        break;
      }
    }
    for (const colId of DATE_COLUMN_IDS) {
      const dateCell = row.querySelector(`.ag-cell[col-id="${colId}"], [col-id="${colId}"]`);
      dateStr = (dateCell?.textContent?.trim() || '').trim();
      if (dateStr) break;
    }
  }

  // Scroll so Transfer Reference ID column (col-id="transferReferenceId", left: 2150px) is rendered, then read it
  scrollTableTo(2150);
  await new Promise(r => setTimeout(r, 150));
  row = center.querySelector(`.ag-row[row-index="${rowIndex}"]`) || center.querySelectorAll('.ag-row')[idx];
  let transfer_reference_id = '';
  if (row) {
    const transferIdCell = row.querySelector('[col-id="transferReferenceId"]');
    if (transferIdCell) transfer_reference_id = (transferIdCell.textContent || '').trim();
  }

  return { username, transfer_reference_id, dateStr };
}

/** Find row index whose transfer_reference_id matches (exact or prefix). Returns -1 if not found. */
async function findRowIndexByTransferId(transferId) {
  const tid = (transferId || '').trim();
  if (!tid) return -1;
  scrollTableTo(2150);
  await new Promise(r => setTimeout(r, 300));
  const center = document.querySelector('.ag-center-cols-container');
  if (!center) return -1;
  const rows = center.querySelectorAll('.ag-row');
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i].querySelector('[col-id="transferReferenceId"]');
    const text = (cell?.textContent || '').trim();
    if (text && (text === tid || transferRefIdPrefixMatch(tid, text))) return i;
  }
  return -1;
}

/** After search, wait until first row (row 0) shows expected transfer ID. Returns true when match, false on timeout. */
async function waitForFirstRowTransferIdToMatch(expectedTransferId, maxMs = 5000) {
  const expected = (expectedTransferId || '').trim();
  if (!expected) return true;
  const step = 300;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const firstRowTid = await getTransferReferenceIdFromRowByIndex(0);
    if (firstRowTid && (firstRowTid === expected || transferRefIdPrefixMatch(expected, firstRowTid))) {
      log(`waitForFirstRowTransferIdToMatch: first row shows expected id (${elapsed}ms)`);
      return true;
    }
    await new Promise(r => setTimeout(r, step));
  }
  log(`waitForFirstRowTransferIdToMatch: timeout - first row did not show "${expected.substring(0, 8)}..."`, 'warn');
  return false;
}

/**
 * Scroll table to show Amount column (typically around 400-600px offset)
 */
function scrollTableToShowAmountColumn() {
  scrollTableTo(600); // Amount column is typically after Date (0) and User (200-400)
  log('scrollTableToShowAmountColumn: scrolled to 600px to show Amount column');
}

/**
 * Get amount from a row by finding the Amount column cell.
 * RULE: Use ONLY col-id="originalAmount" (header "Amount") — never col-id="1" (Total Amount).
 * Total Amount may include fees; withdrawal amount is the "Amount" column (originalAmount).
 * Scrolls to show Amount column first if needed.
 */
function getAmountFromRow(btn, scrollFirst = false) {
  const btnRow = btn.closest('.ag-row');
  if (!btnRow) return null;
  const rowIndex = btnRow.getAttribute('row-index');
  const centerRow = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`);
  const searchIn = centerRow || btnRow;
  
  if (scrollFirst && centerRow) {
    scrollTableToShowAmountColumn();
  }
  
  // PRIMARY: col-id="originalAmount" is the "Amount" column (withdrawal amount). NEVER use col-id="1" (Total Amount).
  const amountOnlyColIds = ['originalAmount', 'amount', 'Amount'];
  for (const colId of amountOnlyColIds) {
    const cell = searchIn.querySelector(`[col-id="${colId}"]`);
    if (cell) {
      const amountText = cell.textContent?.trim() || '';
      const cleaned = amountText.replace(/[^0-9.]/g, '');
      const amount = parseFloat(cleaned);
      if (!isNaN(amount) && amount > 0) return amount;
    }
  }
  
  // Fallback: scan cells by col-id — avoid col-id="1" (Total Amount)
  const allCells = searchIn.querySelectorAll('.ag-cell[col-id]');
  for (const cell of allCells) {
    const colId = cell.getAttribute('col-id') || '';
    if (colId === '1') continue; // Skip Total Amount
    const text = cell.textContent?.trim() || '';
    if (/[\d,]+/.test(text) && (text.includes('INR') || text.includes(',') || text.includes('₹') || /^\d+$/.test(text))) {
      const cleaned = text.replace(/[^0-9.]/g, '');
      const amount = parseFloat(cleaned);
      if (!isNaN(amount) && amount > 0 && amount < 100000000) return amount;
    }
  }
  
  return null;
}

/**
 * Read all Transfer Reference IDs from the table by scrolling the AG Grid horizontal
 * scroll to make the transferReferenceId column visible, waiting for virtual DOM to render,
 * then reading from every center-container row.
 * Works for both flat and crypto pages.
 */
async function getAllTransferIdsFromVisibleRows() {
  const isCrypto = isOnCryptoWithdrawalsPage();
  log(`getAllTransferIdsFromVisibleRows: ${isCrypto ? 'CRYPTO' : 'FLAT'} page - reading transfer IDs`);
  
  // Transfer Reference ID column is at left: 2150px (col-id="transferReferenceId"). Scroll to show it.
  const scrollPositions = [2150, 2400, 0]; // Right to show column, then reset
  for (const scrollPos of scrollPositions) {
    scrollTableTo(scrollPos);
    await new Promise(r => setTimeout(r, 200));
  }
  scrollTableTo(2150);
  log(`getAllTransferIdsFromVisibleRows: Scrolled to 2150px (Transfer Reference ID column), waiting for AG Grid to render...`);
  
  // Wait longer for AG Grid to render columns after scrolling
  // Poll up to 5 seconds for the column to be rendered
  let columnRendered = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(r => setTimeout(r, 200));
    const center = document.querySelector('.ag-center-cols-container');
    if (center) {
      const testRow = center.querySelector('.ag-row');
      if (testRow) {
        // Try multiple ways to find the transfer reference ID column
        const testCell = testRow.querySelector('[col-id="transferReferenceId"]') ||
                        testRow.querySelector('[col-id="transfer_reference_id"]') ||
                        testRow.querySelector('[col-id="transferReference"]');
        if (testCell && testCell.textContent?.trim()) {
          columnRendered = true;
          log(`getAllTransferIdsFromVisibleRows: Transfer Reference ID column rendered after ${(attempt + 1) * 200}ms`);
          break;
        }
        // Also check if we have enough cells rendered (should be > 10 for transfer ref to be visible)
        const allCells = testRow.querySelectorAll('.ag-cell');
        if (allCells.length > 10) {
          // Check if any cell contains a UUID pattern
          for (const cell of allCells) {
            const val = cell.textContent?.trim() || '';
            if (/^[a-f0-9-]{36}$/i.test(val)) {
              columnRendered = true;
              log(`getAllTransferIdsFromVisibleRows: Found UUID in cells after ${(attempt + 1) * 200}ms (${allCells.length} cells rendered)`);
              break;
            }
          }
          if (columnRendered) break;
        }
      }
    }
  }
  
  if (!columnRendered) {
    log(`getAllTransferIdsFromVisibleRows: Transfer Reference ID column not rendered after 5s, proceeding with fallback search...`, 'warn');
  }
  
  const center = document.querySelector('.ag-center-cols-container');
  if (!center) {
    log('getAllTransferIdsFromVisibleRows: no center container found', 'warn');
    return [];
  }
  
  const rows = center.querySelectorAll('.ag-row');
  log(`getAllTransferIdsFromVisibleRows: found ${rows.length} row(s) in table`);
  
  const ids = [];
  rows.forEach((row, idx) => {
    // Try multiple ways to find transferReferenceId cell
    let cell = row.querySelector('[col-id="transferReferenceId"]') ||
               row.querySelector('[col-id="transfer_reference_id"]') ||
               row.querySelector('[col-id="transferReference"]');
    
    if (cell) {
      const val = cell.textContent?.trim() || '';
      if (val) {
        log(`getAllTransferIdsFromVisibleRows: Row ${idx}: found transfer_id="${val}"`);
        ids.push(val);
        return; // Continue to next row
      }
    }
    
    // Fallback: search all cells for UUID pattern
    log(`getAllTransferIdsFromVisibleRows: Row ${idx}: transferReferenceId cell NOT found, searching all cells for UUID...`, 'warn');
    const allCells = row.querySelectorAll('.ag-cell');
    log(`getAllTransferIdsFromVisibleRows: Row ${idx}: found ${allCells.length} cells total`);
    
    let found = false;
    // Search all cells for UUID pattern (36-char UUID with dashes)
    for (let i = 0; i < allCells.length; i++) {
      const cellVal = allCells[i]?.textContent?.trim() || '';
      // Match UUID pattern: 8-4-4-4-12 hex digits with dashes
      if (cellVal && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(cellVal)) {
        log(`getAllTransferIdsFromVisibleRows: Row ${idx}: found transfer_id in cell[${i}]="${cellVal}"`);
        ids.push(cellVal);
        found = true;
        break;
      }
    }
    
    if (!found) {
      log(`getAllTransferIdsFromVisibleRows: Row ${idx}: no UUID found in any cell`, 'warn');
      ids.push(null);
    }
  });
  
  const foundCount = ids.filter(Boolean).length;
  log(`getAllTransferIdsFromVisibleRows: read ${foundCount}/${rows.length} transfer IDs from table`);
  
  // Scroll back to left so User column is visible again
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 300));
  return ids;
}

/**
 * Wait for the View Transaction Details modal to appear (polls up to 5s)
 * Uses findOpenModal() which checks both .modal-content-main and .modal-content
 */
async function waitForModal(maxMs = 5000) {
  const step = 150;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const modal = findOpenModal();
    if (modal) return modal;
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}

/**
 * Wait for Account Holder Name to appear in modal (content may load async).
 * Polls until .list-wrapper with key "Account Holder Name" has non-empty .text-value.
 */
async function waitForModalAccountHolderName(modal, maxMs = 3000) {
  const step = 150;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const name = getModalValue(modal, 'Account Holder Name');
    if (name && name.trim()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

/**
 * Wait for Wallet Address to appear in crypto modal (content may load async)
 */
async function waitForModalWalletAddress(modal, maxMs = 3000) {
  const step = 150;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const addr = getModalValue(modal, 'User Wallet Address') ||
                 getModalValue(modal, 'Wallet Address') ||
                 getModalValue(modal, 'Public Key') ||
                 getModalValue(modal, 'Receiver Address') ||
                 getModalValue(modal, 'To Address') ||
                 getModalValue(modal, 'Destination Address') ||
                 getModalValue(modal, 'Address');
    if (addr && addr.trim()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

/**
 * Wait for Transfer Reference ID to appear in modal (content may load async)
 */
async function waitForModalTransferRef(modal, maxMs = 3000) {
  const step = 200;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const tid = getTransferRefFromModal(modal);
    if (tid) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return false;
}

/**
 * Wait for modal to be removed from DOM (up to 2.5s)
 * Checks both .modal-content-main and .modal-content
 */
async function waitForModalClosed(maxMs = 2500) {
  const step = 100;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const stillOpen = document.querySelector('.modal-content-main') || document.querySelector('.modal-content');
    if (!stillOpen) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return !(document.querySelector('.modal-content-main') || document.querySelector('.modal-content'));
}

/**
 * Click View Details for a row, wait for modal, extract data, close modal
 * usernameOverride: optional pre-fetched username (from User column when visible)
 * tidFromTable: optional pre-fetched transfer_id from table (use as fallback; scrollIntoView can scroll column off)
 */
async function clickViewDetailsAndExtract(btn, usernameOverride = null, tidFromTable = null) {
  const userNameFromTable = usernameOverride ?? getUsernameFromRow(btn);
  await waitForModalClosed(500);
  log('clickViewDetailsAndExtract: scroll into view');
  btn.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 300));
  log('clickViewDetailsAndExtract: clicking View Details button');
  try {
    if (typeof btn.click === 'function') btn.click();
    else dispatchMouseClick(btn);
  } catch (_) {
    dispatchMouseClick(btn);
  }
  const modal = await waitForModal(5000);
  if (modal) {
    await waitForModalTransferRef(modal, 3000);
    await new Promise(r => setTimeout(r, 300));
  }
  let data = modal ? extractModalData() : null;
  if (modal && data && !data.transfer_reference_id) {
    await new Promise(r => setTimeout(r, 600));
    data = extractModalData();
  }
  if (data) {
    // Username: ALWAYS use table value (User column) - never use modal data for username
    let user = userNameFromTable ? String(userNameFromTable).trim() : '';
    if (!user) {
      // Try to get username from table again (in case it wasn't fetched before)
      user = getUsernameFromRow(btn);
    }
    // Only use modal data as absolute last resort (should not happen)
    if (!user) {
      log(`clickViewDetailsAndExtract: ⚠️ Username not found in table, using modal fallback: ${data.user || ''}`, 'warn');
      user = data.user || '';
    }
    if (user) {
      data.userName = user;
      data.username = user;
      data.user = user;
    }
    if (!data.transfer_reference_id) {
      const tid = tidFromTable || getTransferIdFromRow(btn);
      if (tid) {
        data.transfer_reference_id = tid;
        log(`clickViewDetailsAndExtract: got transfer_id from table (pre-fetched=${!!tidFromTable}): ${tid}`);
      }
    }
  }
  log('clickViewDetailsAndExtract: closing modal');
  closeModal();
  await waitForModalClosed(2500);
  return data;
}

/**
 * Get transfer_ids from table (without opening modal).
 * Sets date filter to Week, scrolls to show the Transfer Reference ID column,
 * waits for AG Grid to render virtual cells, reads all visible rows.
 */
async function getTransferIdsFromTable() {
  await setDateFilterToWeek();
  // Use the direct row-reading approach (more reliable than button-based)
  const ids = await getAllTransferIdsFromVisibleRows();
  log(`getTransferIdsFromTable: read ${ids.filter(Boolean).length} transfer IDs from table`);
  return ids;
}

/**
 * BULK PAGE READ: Read all rows from current page at once (no per-row search/filter).
 * 1. Scroll to read usernames, then transfer IDs, then amounts — all in bulk.
 * 2. Filter out rows already in DB.
 * 3. For new rows only, open View Details modal to get bank details.
 * 4. Returns all extracted row data.
 *
 * This is faster than extractOnePageRows because it avoids the per-row search → clear cycle.
 */
async function bulkExtractCurrentPage(skipSet, center) {
  const rows = center.querySelectorAll('.ag-row');
  const rowCount = rows.length;
  if (rowCount === 0) return { results: [] };

  log(`bulkExtractCurrentPage: ${rowCount} row(s) — reading all data from table in bulk`);

  // Step 1: Scroll left to read usernames + dates
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 300));
  const usernames = new Map();
  const dates = new Map();
  const centerAfterScroll = document.querySelector('.ag-center-cols-container');
  if (centerAfterScroll) {
    centerAfterScroll.querySelectorAll('.ag-row').forEach(row => {
      const idx = row.getAttribute('row-index');
      if (idx === null) return;
      // Username
      let username = '';
      for (const colId of USER_COLUMN_IDS) {
        const cell = row.querySelector(`[col-id="${colId}"]`);
        if (cell) {
          const raw = (cell.querySelector('div')?.textContent || cell.textContent || '').trim();
          if (raw && !/^\d{10,}$/.test(raw) && !/^[0-9a-f]{8}-/.test(raw) && !isAppOrBranchName(raw)) {
            username = raw;
            break;
          }
        }
      }
      usernames.set(idx, username);
      // Date
      for (const colId of DATE_COLUMN_IDS) {
        const cell = row.querySelector(`[col-id="${colId}"]`);
        const d = (cell?.textContent || '').trim();
        if (d) { dates.set(idx, d); break; }
      }
    });
  }

  // Step 2: Scroll to show amounts
  scrollTableTo(400); // Amount column is typically around 400-600px
  await new Promise(r => setTimeout(r, 300));
  const amounts = new Map();
  const centerAmounts = document.querySelector('.ag-center-cols-container');
  if (centerAmounts) {
    centerAmounts.querySelectorAll('.ag-row').forEach(row => {
      const idx = row.getAttribute('row-index');
      if (idx === null) return;
      for (const colId of ['originalAmount', 'amount', 'Amount']) {
        const cell = row.querySelector(`[col-id="${colId}"]`);
        if (cell) {
          const text = (cell.textContent || '').trim();
          const cleaned = text.replace(/[^0-9.]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val) && val > 0) { amounts.set(idx, val); break; }
        }
      }
    });
  }

  // Step 3: Scroll right to read transfer_reference_ids
  scrollTableTo(2150);
  await new Promise(r => setTimeout(r, 300));
  const transferIds = new Map();
  const centerTids = document.querySelector('.ag-center-cols-container');
  if (centerTids) {
    centerTids.querySelectorAll('.ag-row').forEach(row => {
      const idx = row.getAttribute('row-index');
      if (idx === null) return;
      const cell = row.querySelector('[col-id="transferReferenceId"]');
      const tid = (cell?.textContent || '').trim();
      if (tid) transferIds.set(idx, tid);
    });
  }

  log(`bulkExtractCurrentPage: Read ${transferIds.size} transfer IDs, ${usernames.size} usernames, ${amounts.size} amounts from table`);

  // Step 4: Identify new rows (not in DB)
  const newRowIndices = [];
  for (const [idx, tid] of transferIds) {
    if (tid && !isTransferIdExisting(tid, skipSet)) {
      newRowIndices.push({ rowIndex: idx, transferId: tid, username: usernames.get(idx) || '', amount: amounts.get(idx) || null, date: dates.get(idx) || '' });
    } else if (tid) {
      log(`bulkExtractCurrentPage: Row ${idx} (tid=${tid}) SKIPPED: already in DB`);
    }
  }

  // Also check rows where transfer ID was not visible in table
  const allRowIndices = new Set();
  const centerCheck = document.querySelector('.ag-center-cols-container');
  if (centerCheck) {
    centerCheck.querySelectorAll('.ag-row').forEach(row => {
      const idx = row.getAttribute('row-index');
      if (idx !== null) allRowIndices.add(idx);
    });
  }
  for (const idx of allRowIndices) {
    if (!transferIds.has(idx)) {
      // Transfer ID not in table — need to open modal to get it
      newRowIndices.push({ rowIndex: idx, transferId: '', username: usernames.get(idx) || '', amount: amounts.get(idx) || null, date: dates.get(idx) || '', needsModal: true });
    }
  }

  log(`bulkExtractCurrentPage: ${newRowIndices.length} new row(s) need View Details modal`);

  // Step 5: For each new row, open View Details to get full data (bank details etc.)
  // Scroll back to left to see View Details buttons
  scrollTableTo(0);
  await new Promise(r => setTimeout(r, 300));

  const results = [];
  for (const { rowIndex, transferId, username, amount, needsModal } of newRowIndices) {
    try {
      const data = await openViewDetailsAndExtractForRow(Number(rowIndex), username || null, transferId || null);
      if (!data) {
        log(`bulkExtractCurrentPage: Row ${rowIndex} SKIPPED: modal did not return data`, 'warn');
        continue;
      }

      // If we didn't have transfer ID from table, get it from modal
      const tid = data.transfer_reference_id || transferId;
      if (!tid) {
        log(`bulkExtractCurrentPage: Row ${rowIndex} SKIPPED: no transfer_reference_id from table or modal`, 'warn');
        continue;
      }
      data.transfer_reference_id = tid;

      // Check again if it's in DB (for rows where we just got the ID from modal)
      if (isTransferIdExisting(tid, skipSet)) {
        log(`bulkExtractCurrentPage: Row ${rowIndex} (tid=${tid}) SKIPPED: already in DB (checked after modal)`, 'info');
        continue;
      }

      // Set username from table (more reliable than modal)
      if (username) {
        data.username = username;
        data.userName = username;
        data.user = username;
      }

      // Set amount from table if modal didn't have it
      if (amount && !data.amount) {
        data.amount = amount;
      }

      results.push(data);

      // Send to background immediately
      const isCrypto = data.is_crypto === true || !!(data.wallet_address && String(data.wallet_address).trim() && data.wallet_address !== '-');
      const rowCopy = {
        amount: data.amount,
        converted_amount: data.converted_amount,
        wallet_address: data.wallet_address,
        currency: data.currency,
        crypto_name: data.crypto_name,
        bank_name: data.bank_name,
        acc_number: data.acc_number,
        ifsc: data.ifsc,
        acc_holder_name: data.acc_holder_name,
        transfer_reference_id: data.transfer_reference_id,
        username: data.username,
        userName: data.userName,
        user: data.user,
        order_date_raw: data.order_date_raw,
        application_name: data.application_name,
        merchant_reference_id: data.merchant_reference_id,
        utr: data.utr,
        status: data.status,
        is_crypto: isCrypto
      };
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'onExtractedRow', row: rowCopy }, (response) => {
            if (chrome.runtime.lastError) log(`bulkExtractCurrentPage: onExtractedRow send error: ${chrome.runtime.lastError.message}`, 'warn');
            resolve(response);
          });
        });
      } catch (e) {
        log(`bulkExtractCurrentPage: onExtractedRow error: ${e.message}`, 'warn');
      }

      closeModal();
      await waitForModalClosed(500);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      log(`bulkExtractCurrentPage: Row ${rowIndex} error: ${e.message}`, 'warn');
      closeModal();
      await waitForModalClosed(500);
    }
  }

  log(`bulkExtractCurrentPage: DONE — ${results.length} new row(s) extracted and sent`);
  return { results };
}

/**
 * Get all rows' transaction data from table (opens View Details only for rows after lastProcessedAt).
 * existingIds: Set of transfer_reference_id that already exist in DB (from API check).
 * lastProcessedAt: optional timestamp; only rows with date > this are opened.
 * isCrypto: when true, use crypto guard so crypto extraction is not blocked by flat (same tab, different page).
 * Returns { rows, maxProcessedAt }.
 */
async function extractAllRowsData(existingIds = new Set(), lastProcessedAt = null, isCrypto = false) {
  const useCryptoGuard = isCrypto && isOnCryptoWithdrawalsPage();
  if (useCryptoGuard) {
    if (cryptoExtractInProgress) {
      log('extractAllRowsData: crypto extraction already in progress, skipping', 'warn');
      return { rows: [], maxProcessedAt: null };
    }
    cryptoExtractInProgress = true;
    try {
      log('extractAllRowsData: CRYPTO page — starting extraction (crypto guard)');
      return await extractAllRowsDataFromTable(existingIds, lastProcessedAt);
    } finally {
      cryptoExtractInProgress = false;
    }
  }
  if (extractAllRowsInProgress) {
    log('extractAllRowsData: flat extraction already in progress, skipping', 'warn');
    return { rows: [], maxProcessedAt: null };
  }
  extractAllRowsInProgress = true;
  try {
    return await extractAllRowsDataFromTable(existingIds, lastProcessedAt);
  } finally {
    extractAllRowsInProgress = false;
  }
}

/**
 * Find row index by transfer_reference_id - read from View Details modal (row may not show full details)
 */
async function findRowIndexByOrderId(orderId) {
  log(`findRowIndexByOrderId: searching for order_id=${orderId} (reading from View Details)`);
  const viewButtons = getViewDetailsButtons();
  const rowCount = viewButtons.length;
  if (rowCount === 0) {
    log('findRowIndexByOrderId: no View Details buttons found', 'warn');
    return -1;
  }
  for (let i = 0; i < rowCount; i++) {
    await waitForModalClosed(500);
    const btn = viewButtons[i];
    if (!btn) continue;
    btn.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 300));
    btn.click();
    const modal = await waitForModal(5000);
    if (modal) {
      await waitForModalTransferRef(modal, 3000);
      await new Promise(r => setTimeout(r, 200));
      const tid = getTransferRefFromModal(modal);
      closeModal();
      await waitForModalClosed(2500);
      if (tid && String(tid).trim() === String(orderId).trim()) {
        log(`findRowIndexByOrderId: found at row index ${i} (transfer_ref=${tid})`);
        return i;
      }
    } else {
      closeModal();
      await waitForModalClosed(500);
    }
  }
  log(`findRowIndexByOrderId: not found in ${rowCount} row(s)`, 'warn');
  return -1;
}

/**
 * Find any currently open modal by title keyword.
 * Checks .modal-content-main first, then .modal-content.
 */
/**
 * Capture toast notification from the panel (react-toastify).
 * Reads the .Toastify__toast element text and determines type (success/error/warning).
 * Returns { text, type } or null if no toast found.
 */
function captureToastNotification() {
  const toasts = document.querySelectorAll('.Toastify__toast');
  if (!toasts || toasts.length === 0) return null;
  // Get the most recent toast (last in DOM)
  const toast = toasts[toasts.length - 1];
  const text = (toast.querySelector('.Toastify__toast-body')?.textContent || toast.textContent || '').trim();
  if (!text) return null;
  let type = 'info';
  if (toast.classList.contains('Toastify__toast--error')) type = 'error';
  else if (toast.classList.contains('Toastify__toast--success')) type = 'success';
  else if (toast.classList.contains('Toastify__toast--warning')) type = 'warning';
  // Also check by background color (some themes use colored toasts)
  if (type === 'info') {
    const bg = getComputedStyle(toast).backgroundColor || '';
    if (bg.includes('220') || bg.includes('error') || text.toLowerCase().includes('error') || text.toLowerCase().includes('failed') || text.toLowerCase().includes('block')) type = 'error';
    else if (bg.includes('success') || text.toLowerCase().includes('success') || text.toLowerCase().includes('approved')) type = 'success';
  }
  return { text, type };
}

function findModalByTitle(titleKeyword) {
  for (const sel of ['.modal-content-main', '.modal-content']) {
    const el = document.querySelector(sel);
    if (el) {
      const title = el.querySelector('.modal-head-title');
      if (title && (title.textContent || '').toLowerCase().includes(titleKeyword.toLowerCase())) {
        return el;
      }
    }
  }
  return null;
}

/**
 * Wait for approval modal to appear
 */
async function waitForApprovalModal(maxMs = 4000) {
  const step = 100;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const modal = findModalByTitle('Approve transaction') || findModalByTitle('Approve Transaction');
    if (modal) return modal;
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}

/**
 * Wait for Reject Transaction modal to appear
 */
async function waitForRejectModal(maxMs = 4000) {
  const step = 100;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    const modal = findModalByTitle('Reject Transaction') || findModalByTitle('Reject transaction');
    if (modal) return modal;
    await new Promise(r => setTimeout(r, step));
  }
  return null;
}

/**
 * Fill Remarks with UTR in Reject modal and submit
 * Returns { success: boolean, submitted: boolean }
 */
async function fillRejectModalAndSubmit(remarksOrUtr) {
  const value = (remarksOrUtr !== null && remarksOrUtr !== undefined && String(remarksOrUtr).trim()) ? String(remarksOrUtr).trim() : 'Rejected';
  log(`fillRejectModalAndSubmit: filling Remarks=${value}`);
  const modal = await waitForRejectModal(5000);
  if (!modal) {
    log('fillRejectModalAndSubmit: Reject modal not found', 'error');
    return { success: false, submitted: false };
  }
  const remarksInput = modal.querySelector('input[name="remarks"]');
  if (!remarksInput) {
    log('fillRejectModalAndSubmit: Remarks input not found', 'error');
    return { success: false, submitted: false };
  }
  remarksInput.focus();
  await new Promise(r => setTimeout(r, 80));
  remarksInput.value = value;
  remarksInput.setAttribute('value', value);
  remarksInput.dispatchEvent(new Event('input', { bubbles: true }));
  remarksInput.dispatchEvent(new Event('change', { bubbles: true }));
  log(`fillRejectModalAndSubmit: Remarks filled: ${value}`);
  const submitBtn = modal.querySelector('button[type="submit"].btn-primary');
  if (!submitBtn) {
    log('fillRejectModalAndSubmit: Submit button not found', 'error');
    return { success: false, submitted: false };
  }
  await new Promise(r => setTimeout(r, 150));
  log('fillRejectModalAndSubmit: Clicking Submit');
  submitBtn.click();
  const modalClosed = await waitForModalClosed(3000);
  if (modalClosed) {
    log('fillRejectModalAndSubmit: Modal closed - form submitted');
    await new Promise(r => setTimeout(r, 800));
    // Capture toast/notification from panel (success or error)
    const toastMsg = captureToastNotification();
    if (toastMsg) {
      log(`fillRejectModalAndSubmit: Panel notification: "${toastMsg.text}" (${toastMsg.type})`, toastMsg.type === 'error' ? 'error' : 'info');
      if (toastMsg.type === 'error') {
        return { success: false, submitted: true, error: toastMsg.text };
      }
    }
    return { success: true, submitted: true };
  }
  log('fillRejectModalAndSubmit: Modal did not close', 'warn');
  return { success: false, submitted: false };
}

/**
 * Fill approval modal and submit.
 * Supports:
 * 1. Flat (bank): input[name="utrNumber"]
 * 2. Crypto Blockchain Transfer: transactionHash + confirmTransactionHash (UTR in both)
 * 3. Crypto Internal Exchange Transfer: select Internal Exchange tab, select Binance, transactionHash + confirmTransactionHash (UTR in both)
 * Returns { success: boolean, submitted: boolean }
 */
async function fillApprovalModalAndSubmit(utr) {
  const utrVal = (utr !== null && utr !== undefined && String(utr).trim()) ? String(utr).trim() : '';
  log(`fillApprovalModalAndSubmit: filling UTR (length=${utrVal.length})`);
  const modal = await waitForApprovalModal(5000);
  if (!modal) {
    log('fillApprovalModalAndSubmit: Approval modal not found', 'error');
    return { success: false, submitted: false };
  }

  const transactionHashInput = modal.querySelector('input[name="transactionHash"]');
  const confirmTransactionHashInput = modal.querySelector('input[name="confirmTransactionHash"]');
  const internalExchangeTab = modal.querySelector('button[value="INTERNAL_EXCHANGE_TRANSFER"]');
  const utrInput = modal.querySelector('input[name="utrNumber"]');

  const fillOneInput = (input, label) => {
    if (!input) return;
    input.focus();
    input.value = utrVal;
    input.setAttribute('value', utrVal);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log(`fillApprovalModalAndSubmit: Filled ${label}`);
  };

  // Prefer Internal Exchange Transfer when tab exists: click tab, select Binance, fill both fields with UTR
  if (internalExchangeTab) {
    log('fillApprovalModalAndSubmit: Internal Exchange Transfer tab found — using Internal Exchange flow');
    const tabLi = internalExchangeTab.closest('.secondarystep-nav-item');
    if (tabLi && !tabLi.classList.contains('active')) {
      log('fillApprovalModalAndSubmit: Clicking Internal Exchange Transfer tab');
      internalExchangeTab.click();
      await new Promise(r => setTimeout(r, 350));
    }
    const selectEl = modal.querySelector('select[name="exchangePlatform"]');
    if (selectEl) {
      const hasBinance = Array.from(selectEl.options).some(o => (o.value || '').toUpperCase() === 'BINANCE');
      if (hasBinance) {
        selectEl.value = 'BINANCE';
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        log('fillApprovalModalAndSubmit: Selected Binance in Exchange Platform');
      } else {
        log('fillApprovalModalAndSubmit: BINANCE option not found', 'warn');
      }
      await new Promise(r => setTimeout(r, 120));
    }
    const txInput = modal.querySelector('input[name="transactionHash"]');
    const confirmInput = modal.querySelector('input[name="confirmTransactionHash"]');
    if (txInput && confirmInput) {
      fillOneInput(txInput, 'Transaction Reference');
      await new Promise(r => setTimeout(r, 80));
      fillOneInput(confirmInput, 'Confirm Transaction Reference');
    }
  } else if (transactionHashInput && confirmTransactionHashInput) {
    // Blockchain Transfer: fill both transaction hash fields with UTR
    log('fillApprovalModalAndSubmit: Blockchain Transfer modal detected (transactionHash + confirmTransactionHash)');
    fillOneInput(transactionHashInput, 'Transaction Hash');
    await new Promise(r => setTimeout(r, 80));
    fillOneInput(confirmTransactionHashInput, 'Confirm Transaction Hash');
  } else if (utrInput) {
    // Flat (bank) approval: single UTR field
    log('fillApprovalModalAndSubmit: Flat approval modal detected (utrNumber)');
    utrInput.focus();
    await new Promise(r => setTimeout(r, 50));
    utrInput.value = '';
    utrInput.setAttribute('value', '');
    utrInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    utrInput.value = utrVal;
    utrInput.setAttribute('value', utrVal);
    utrInput.dispatchEvent(new Event('input', { bubbles: true }));
    utrInput.dispatchEvent(new Event('change', { bubbles: true }));
    utrInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  } else {
    log('fillApprovalModalAndSubmit: No known input fields (utrNumber or transactionHash/confirmTransactionHash)', 'error');
    return { success: false, submitted: false };
  }

  await new Promise(r => setTimeout(r, 200));

  // Check for validation errors BEFORE submitting (e.g. "Please enter a valid UTR")
  await new Promise(r => setTimeout(r, 300));
  const errorMsg = modal.querySelector('.text-danger, .error-message, .alert-danger, [role="alert"]');
  if (errorMsg && errorMsg.textContent.trim()) {
    const errText = errorMsg.textContent.trim();
    log(`fillApprovalModalAndSubmit: ❌ Validation error before submit: "${errText}"`, 'error');
    // Close modal and return error — don't submit with invalid data
    closeModal();
    await waitForModalClosed(2000);
    return { success: false, submitted: false, error: errText };
  }

  const submitBtn = modal.querySelector('button[type="submit"].btn-primary');
  if (!submitBtn) {
    log('fillApprovalModalAndSubmit: Submit button not found', 'error');
    return { success: false, submitted: false };
  }
  if (submitBtn.disabled) {
    log('fillApprovalModalAndSubmit: Submit button is disabled', 'warn');
    return { success: false, submitted: false };
  }

  log('fillApprovalModalAndSubmit: Clicking Approve submit button');
  submitBtn.focus();
  await new Promise(r => setTimeout(r, 50));
  submitBtn.click();
  submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  const modalClosed = await waitForModalClosed(5000);
  if (modalClosed) {
    log('fillApprovalModalAndSubmit: Modal closed - form submitted');
    await new Promise(r => setTimeout(r, 800));
    // Capture toast/notification from panel (success or error)
    const toastMsg = captureToastNotification();
    if (toastMsg) {
      log(`fillApprovalModalAndSubmit: Panel notification: "${toastMsg.text}" (${toastMsg.type})`, toastMsg.type === 'error' ? 'error' : 'info');
      if (toastMsg.type === 'error') {
        return { success: false, submitted: true, error: toastMsg.text };
      }
    }
    return { success: true, submitted: true };
  }
  const stillOpenModal = document.querySelector('.modal-content-main') || document.querySelector('.modal-content');
  if (stillOpenModal) {
    const err = stillOpenModal.querySelector('.text-danger, .error-message, .alert-danger, [role="alert"]');
    if (err && err.textContent.trim()) {
      log(`fillApprovalModalAndSubmit: Modal still open with error: ${err.textContent.trim()}`, 'error');
      return { success: false, submitted: false, error: err.textContent.trim() };
    }
  }
  log('fillApprovalModalAndSubmit: Modal did not close after submit', 'warn');
  return { success: false, submitted: false };
}

/**
 * Click Approve or Reject for a row
 * Approve is first button, Reject is second button in .actions
 * Uses pinned-right container (actions column is pinned right)
 * If action is 'approve' and utr is provided, will handle the approval modal
 */
async function clickApproveOrReject(rowIndex, action, utr = null) {
  // AG Grid row-index is always a string ("0", "1", ...); normalize so selector matches
  const rowIndexStr = String(rowIndex);
  log(`clickApproveOrReject: rowIndex=${rowIndexStr} action=${action} utr=${utr || 'not provided'}`);
  
  // First, find the row in the center container and scroll it into view
  const centerRow = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndexStr}"]`);
  if (centerRow) {
    log(`clickApproveOrReject: Found center row, scrolling into view...`);
    centerRow.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300)); // Wait for scroll and render (reduced for speed)
  }
  
  // Now look for the row in pinned-right container (where action buttons are)
  const pinnedRight = document.querySelector('.ag-pinned-right-cols-container');
  if (!pinnedRight) {
    log('clickApproveOrReject: .ag-pinned-right-cols-container not found', 'error');
    return { success: false, submitted: false, message: 'Pinned right container not found' };
  }
  
  // Poll for the row to appear in pinned-right (may need time to render)
  let row = null;
  let attempts = 0;
  const maxAttempts = 12;
  while (!row && attempts < maxAttempts) {
    row = pinnedRight.querySelector(`.ag-row[row-index="${rowIndexStr}"]`);
    if (!row) {
      // After search-by-transfer-ref the table often shows 1 row with row-index="0"; use it if we're targeting row 0
      const allPinnedRows = pinnedRight.querySelectorAll('.ag-row');
      if (allPinnedRows.length === 1 && (rowIndexStr === '0' || rowIndex === 0)) {
        row = allPinnedRows[0];
        log('clickApproveOrReject: Using single pinned-right row (search result)');
      }
    }
    if (!row) {
      attempts++;
      await new Promise(r => setTimeout(r, 150));
      // Try scrolling the pinned-right container into view
      pinnedRight.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }
  
  if (!row) {
    log(`clickApproveOrReject: row not found in pinned-right after ${maxAttempts} attempts`, 'error');
    return { success: false, submitted: false, message: `Row ${rowIndexStr} not found in pinned-right container` };
  }
  
  log(`clickApproveOrReject: Found row in pinned-right, looking for action buttons...`);
  
  // Scroll the row into view in pinned-right container to ensure buttons are visible
  row.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 200));
  
  // Actions container: panel may use .actions, or AG-Grid col-id="actions"
  let actions = row.querySelector('.actions') || row.querySelector('.ag-cell[col-id="actions"]') || row.querySelector('[col-id="actions"]');
  if (!actions) actions = row; // fallback: search whole row for Approve/Reject buttons
  
  // Poll for buttons (panel may use button.btn-link-primary or other classes)
  let btns = actions.querySelectorAll('button.btn-link-primary');
  let btnAttempts = 0;
  const maxBtnAttempts = 6;
  while (btns.length < 2 && btnAttempts < maxBtnAttempts) {
    btnAttempts++;
    await new Promise(r => setTimeout(r, 120));
    btns = actions.querySelectorAll('button.btn-link-primary');
  }
  
  // Fallback: find buttons by text Approve / Reject (exclude View Details which has SVG)
  if (btns.length < 2) {
    const allBtns = Array.from(row.querySelectorAll('button')).filter(btn => {
      const t = (btn.textContent || '').trim();
      const isViewDetails = btn.querySelector('svg') || (btn.title || '').toLowerCase().includes('view');
      return (t === 'Approve' || t === 'Reject') && !isViewDetails;
    });
    if (allBtns.length >= 2) {
      const approveBtn = allBtns.find(b => (b.textContent || '').trim() === 'Approve');
      const rejectBtn = allBtns.find(b => (b.textContent || '').trim() === 'Reject');
      if (approveBtn && rejectBtn) btns = [approveBtn, rejectBtn];
    }
  }
  
  // Also try: scan ALL buttons in the row (not just btn-link-primary) for Approve/Reject text
  if (btns.length < 2) {
    const rowBtns = Array.from(row.querySelectorAll('button'));
    const approveCandidate = rowBtns.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'approve' || t.includes('approve');
    });
    const rejectCandidate = rowBtns.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'reject' || t.includes('reject');
    });
    if (approveCandidate || rejectCandidate) {
      btns = [approveCandidate, rejectCandidate].filter(Boolean);
      log(`clickApproveOrReject: Found ${btns.length} button(s) by text scan (Approve: ${!!approveCandidate}, Reject: ${!!rejectCandidate})`);
    }
  }

  // If we still only have 1 button, use it if it matches the requested action
  if (btns.length === 1) {
    const btnText = (btns[0].textContent || '').trim().toLowerCase();
    if (btnText.includes(action)) {
      log(`clickApproveOrReject: Only 1 button found but it matches action "${action}" — using it`);
    } else {
      log(`clickApproveOrReject: Only 1 button found ("${btnText}") but need "${action}"`, 'error');
      return { success: false, submitted: false, message: `Only 1 button found ("${btnText}"), need "${action}"` };
    }
  }

  if (btns.length === 0) {
    log(`clickApproveOrReject: no buttons found after ${maxBtnAttempts} attempts`, 'error');
    return { success: false, submitted: false, message: `No approve/reject buttons found` };
  }

  // Resolve which button is Approve and which is Reject
  const btnsArr = Array.from(btns);
  const approveBtn = btnsArr.find(b => (b.textContent || '').trim().toLowerCase().includes('approve')) || btnsArr[0];
  const rejectBtn = btnsArr.find(b => (b.textContent || '').trim().toLowerCase().includes('reject')) || btnsArr[btnsArr.length > 1 ? 1 : 0];
  log(`clickApproveOrReject: Found buttons — Approve: "${approveBtn.textContent?.trim()}", Reject: "${rejectBtn.textContent?.trim()}"`);
  
  if (action === 'approve') {
    log('clickApproveOrReject: clicking Approve button');
    approveBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 100));
    approveBtn.click();
    
    // Wait for modal to appear
    await new Promise(r => setTimeout(r, 300));
    
    // If UTR is provided, fill it in the modal
    if (utr) {
      const modalResult = await fillApprovalModalAndSubmit(utr);
      if (!modalResult.success) {
        log('clickApproveOrReject: Failed to fill approval modal', 'warn');
        return { success: false, submitted: false };
      }
      // Return success status based on whether form was actually submitted
      return { success: true, submitted: modalResult.submitted };
    } else {
      // No UTR provided - wait for modal and check if it appeared
      const modal = await waitForApprovalModal(3000);
      if (modal) {
        log('clickApproveOrReject: Approval modal appeared but no UTR provided - closing modal', 'warn');
        closeModal();
        await waitForModalClosed(2000);
        return { success: false, submitted: false, message: 'UTR required for approval' };
      } else {
        log('clickApproveOrReject: Approval modal did not appear', 'warn');
        return { success: false, submitted: false, message: 'Approval modal did not appear' };
      }
    }
  }
  if (action === 'reject') {
    log('clickApproveOrReject: clicking Reject button');
    rejectBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 100));
    rejectBtn.click();
    await new Promise(r => setTimeout(r, 300));
    const modalResult = await fillRejectModalAndSubmit(utr);
    if (!modalResult.success) {
      log('clickApproveOrReject: Failed to fill reject modal', 'warn');
      return { success: false, submitted: false };
    }
    return { success: true, submitted: modalResult.submitted };
  }
  return { success: false, submitted: false };
}

/**
 * Parse "7th Feb 2026, 9:29 am" -> "07/02/2026 09:29:00"
 */
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

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // Log immediately when ANY message is received
  console.log(`🟢🟢🟢 MESSAGE RECEIVED: action=${request.action}`, request);
  log(`[MESSAGE] ========== MESSAGE RECEIVED ==========`);
  log(`[MESSAGE] Action: ${request.action}`);
  
  if (request.action === 'logFromBackground') {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const prefix = '🔵 AGENT-WITHDRAWAL';
    if (request.stepName) {
      console.log(`${prefix} ========== ${request.stepName} ==========`);
      if (request.details) {
        try {
          const parsed = JSON.parse(request.details);
          console.log(prefix, parsed);
        } catch {
          console.log(prefix, request.details);
        }
      }
      console.log(`${prefix} ========================================`);
    } else {
      const out = `${prefix} [${ts}] ${request.msg}`;
      if (request.level === 'error') console.error(out);
      else if (request.level === 'warn') console.warn(out);
      else console.log(out);
    }
    sendResponse({ ok: true });
    return true;
  }
  log(`Message received: action=${request.action}`);
  const run = async () => {
    switch (request.action) {
      case 'isLoginPage':
        const onLogin = isLoginPage();
        log(`isLoginPage: ${onLogin}`);
        return { isLoginPage: onLogin };
      case 'performLogin':
        return await performLogin(request.username, request.password);
      case 'navigateToWithdrawals':
        return navigateToWithdrawals();
      case 'navigateToCryptoWithdrawals':
        return navigateToCryptoWithdrawals();
      case 'getCurrentPage':
        return {
          isCrypto: isOnCryptoWithdrawalsPage(),
          isFlat: isOnFlatWithdrawalsPage(),
          isWithdrawals: isOnWithdrawalsPage(),
          pathname: window.location.pathname
        };
      case 'getCurrentUrl':
        return getCurrentUrl();
      case 'ping': {
        log('[MESSAGE] Ping received, responding...');
        const loginEls = getLoginFormElements();
        return {
          pong: true,
          url: window.location.href,
          readyState: document.readyState,
          hasLoginForm: !!(loginEls.userNameInput && loginEls.passInput && loginEls.submitBtn),
          loginElementsFound: {
            userName: !!loginEls.userNameInput,
            password: !!loginEls.passInput,
            submit: !!loginEls.submitBtn
          }
        };
      }
      case 'getTransferIdsFromTable':
        return await getTransferIdsFromTable();
      case 'extractAllRows':
        return await extractAllRowsData(request.existingIds, request.lastProcessedAt ?? null, request.isCrypto === true);
      case 'findRowAndClickAction':
        const clickAction = request.clickAction || request.action;
        log(`findRowAndClickAction: orderId=${request.orderId} clickAction=${clickAction}`);
        const idx = await findRowIndexByOrderId(request.orderId);
        if (idx < 0) return { success: false, submitted: false, message: 'Row not found' };
        const result = await clickApproveOrReject(idx, clickAction, request.utr || null);
        return { success: result.success, submitted: result.submitted };
      case 'searchAndClickAction': {
        // For mismatches: search by Transfer Reference ID, verify FIRST row matches username/amount/transfer_id prefix, click Accept/Reject
        const searchOrderId = request.orderId;
        const searchClickAction = request.clickAction || 'approve';
        const searchUtr = request.utr || null; // UTR from webhook for approval modal
        const expectedUsername = request.username || null; // Username to match
        const expectedAmount = request.amount || null; // Amount to match
        log(`searchAndClickAction: orderId=${searchOrderId} clickAction=${searchClickAction} utr=${searchUtr || 'not provided'} username=${expectedUsername || 'not provided'} amount=${expectedAmount || 'not provided'}`);
        
        // Step 0: Verify we're on withdrawals page — flat (/withdrawls/) or crypto (/withdrawls/crypto) for clearing mismatches
        const onFlat = isOnFlatWithdrawalsPage();
        const onCrypto = isOnCryptoWithdrawalsPage();
        if (!onFlat && !onCrypto) {
          log(`searchAndClickAction: Not on withdrawals page! Current path: ${window.location.pathname}`, 'error');
          return { success: false, message: 'Must be on flat (/withdrawls/) or crypto (/withdrawls/crypto) withdrawals page' };
        }
        log(`searchAndClickAction: Page type: ${onCrypto ? 'crypto' : 'flat'}`);
        
        // Helper function to clear search and return error
        const clearSearchAndReturn = async (message) => {
          await clearSearchByCloseButton() || getRefreshButton()?.click() || await clearSearch();
          return { success: false, message };
        };
        
        // Step 0.25: Check for "actions blocked" toast and wait it out
        const blockedToast = captureToastNotification();
        if (blockedToast && (blockedToast.text.toLowerCase().includes('block') || blockedToast.text.toLowerCase().includes('retry'))) {
          const waitMatch = blockedToast.text.match(/(\d+)\s*sec/i);
          const waitSec = waitMatch ? parseInt(waitMatch[1]) + 2 : 15; // add 2s buffer
          log(`searchAndClickAction: Panel says "${blockedToast.text}" — waiting ${waitSec}s before proceeding...`, 'warn');
          await new Promise(r => setTimeout(r, waitSec * 1000));
        }

        // Step 0.5: Set date filter to Week before searching (enter field, Week selected, then search)
        log('searchAndClickAction: Setting date filter to Week before search...');
        const filterRes = await setDateFilterToWeek();
        if (!filterRes?.success) {
          log(`searchAndClickAction: Week filter failed: ${filterRes?.message}`, 'warn');
          // Continue anyway — search may still work with current filter
        }
        
        // Brief pause after filter to let panel settle (avoids "actions blocked")
        await new Promise(r => setTimeout(r, 1500));

        // Step 1: Enter search field and click search
        const searchRes = await applySearchByTransferReferenceId(searchOrderId);
        if (!searchRes?.success) {
          return { success: false, message: searchRes?.message || 'Search failed' };
        }
        
        // Step 2: Wait for search results to load - iterate through rows to find matching transfer ID
        log(`searchAndClickAction: Waiting for table to filter - will check rows to find matching transfer_id...`);
        
        // Poll for rows to appear (up to ~8 seconds, faster polling)
        let matchingRowButton = null;
        let attempts = 0;
        const maxAttempts = 25; // 25 * 300ms = 7.5s max wait
        
        while (!matchingRowButton && attempts < maxAttempts) {
          attempts++;
          await new Promise(r => setTimeout(r, 300));
          
          const viewButtons = getViewDetailsButtons();
          if (viewButtons.length === 0) {
            log(`searchAndClickAction: No rows found yet (attempt ${attempts}/${maxAttempts})`);
            continue;
          }
          
          log(`searchAndClickAction: Found ${viewButtons.length} row(s) after search, checking each row for matching transfer_id...`);
          
          // Scroll to show Transfer Reference ID column first (do this once before iterating)
          scrollTableToShowTransferRefColumn();
          await new Promise(r => setTimeout(r, 300));
          
          // Iterate through rows to find the one matching the transfer ID
          // If search returned exactly 1 row, it's likely the matching row, but we'll still verify
          for (let i = 0; i < viewButtons.length; i++) {
            const btn = viewButtons[i];
            const btnRow = btn.closest('.ag-row');
            const rowIndex = btnRow?.getAttribute('row-index');
            
            // Scroll row into view vertically (AG Grid virtual scrolling)
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(r => setTimeout(r, 200));
            
            // Get transfer ID from table for this row
            let rowTransferId = getTransferIdFromRow(btn);
            let rowAmount = null;
            let rowUsername = '';
            
            // Try to get amount from table first (scroll to show Amount column)
            scrollTableToShowAmountColumn();
            await new Promise(r => setTimeout(r, 200));
            rowAmount = getAmountFromRow(btn, false);
            if (rowAmount) {
              log(`searchAndClickAction: Row ${i} amount from table: ${rowAmount}`);
            }
            
            // If transfer ID is empty from table (column not rendered), try reading from modal
            // Also read amount and username while modal is open (if amount wasn't found in table)
            if (!rowTransferId || rowTransferId.trim() === '') {
              log(`searchAndClickAction: Row ${i} transfer_id empty from table, opening modal to read it...`);
              try {
                btn.click();
                await new Promise(r => setTimeout(r, 500));
                const modal = await waitForModal(5000);
                if (modal) {
                  await waitForModalTransferRef(modal, 3000);
                  await new Promise(r => setTimeout(r, 300));
                  const modalData = extractModalData() || extractCryptoModalData();
                  if (modalData) {
                    if (modalData.transfer_reference_id) {
                      rowTransferId = modalData.transfer_reference_id;
                      log(`searchAndClickAction: Row ${i} transfer_id from modal: "${rowTransferId}"`);
                    }
                    // Always update amount from modal if available (more reliable than table)
                    if (modalData.amount) {
                      rowAmount = modalData.amount;
                      log(`searchAndClickAction: Row ${i} amount from modal: ${rowAmount}`);
                    } else if (!rowAmount) {
                      // If amount wasn't found in table and modal doesn't have it, log warning
                      log(`searchAndClickAction: Row ${i} amount not found in table or modal`, 'warn');
                    }
                    // Store modal data for later verification (but username will come from table)
                    btn._modalData = modalData;
                  }
                  closeModal();
                  await waitForModalClosed(2000);
                }
              } catch (e) {
                log(`searchAndClickAction: Error reading transfer_id from modal for row ${i}: ${e.message}`, 'warn');
                closeModal();
                await waitForModalClosed(1000);
              }
            }
            
            const rowTransferIdClean = String(rowTransferId || '').trim().toLowerCase();
            const searchOrderIdClean = String(searchOrderId || '').trim().toLowerCase();

            // Check if this row's transfer ID matches (prefix match)
            let matches = false;
            if (rowTransferIdClean && searchOrderIdClean) {
              matches = (
                searchOrderIdClean.startsWith(rowTransferIdClean) ||
                rowTransferIdClean.startsWith(searchOrderIdClean)
              );
            } else if (!rowTransferIdClean && viewButtons.length === 1) {
              // transfer_id is unreadable (table virtualised + modal failed/empty) but search
              // returned exactly 1 row — the Transfer Reference ID search already uniquely
              // identified this row, so treat it as a match.
              log(`searchAndClickAction: Row ${i} transfer_id unreadable but search returned only 1 row — trusting search result`, 'warn');
              matches = true;
            }

            if (matches) {
              matchingRowButton = btn;
              // IMPORTANT: Store row-index immediately as string (don't parse yet) - button reference might become stale
              const savedRowIndex = rowIndex || btnRow?.getAttribute('row-index') || '';
              log(`searchAndClickAction: ✅ Found matching row at index ${i} (row-index=${savedRowIndex}) with transfer_id="${rowTransferId || '(from search filter)'}"`);
              // Store row-index and modal data for later use
              matchingRowButton._savedRowIndex = savedRowIndex;
              matchingRowButton._savedTransferId = rowTransferId;
              matchingRowButton._savedAmount = rowAmount;
              break;
            } else {
              log(`searchAndClickAction: Row ${i} (row-index=${rowIndex}) transfer_id="${rowTransferId || '(empty)'}" does not match "${searchOrderId}"`);
            }
          }
          
          if (matchingRowButton) break;
        }
        
        if (!matchingRowButton) {
          log(`searchAndClickAction: No matching row found after search`, 'warn');
          // Quick fallback: clear search, scroll to Transfer Reference ID column, scan table rows directly (no modal opening)
          log(`searchAndClickAction: Fallback — clearing search, scanning table for transfer_id...`);
          await clearSearchByCloseButton() || await clearSearch();
          await new Promise(r => setTimeout(r, 1500));
          // Try finding row by scrolling to Transfer Reference ID column and reading cells
          const fallbackIdx = await findRowIndexByTransferId(searchOrderId);
          if (fallbackIdx >= 0) {
            log(`searchAndClickAction: Fallback found row at index ${fallbackIdx}, clicking ${searchClickAction}...`);
            const result = await clickApproveOrReject(fallbackIdx, searchClickAction, searchUtr);
            return { success: result.success, submitted: result.submitted, message: result.message || (result.success ? 'Completed via fallback' : 'Failed via fallback') };
          }
          return await clearSearchAndReturn(`No row with matching transfer_id found after searching for ${searchOrderId}`);
        }
        
        // Step 3: Verify matching row matches username, amount, and transfer reference ID prefix
        log(`searchAndClickAction: Verifying matching row matches username/amount/transfer_id...`);
        
        // IMPORTANT: Use saved row-index from when we found the match (button reference might become stale after modal)
        let actualRowIndex = matchingRowButton._savedRowIndex || matchingRowButton.closest('.ag-row')?.getAttribute('row-index') || '';
        if (!actualRowIndex || actualRowIndex === '') {
          return await clearSearchAndReturn(`Could not get row-index attribute from matching row`);
        }
        const matchingRowIndex = parseInt(actualRowIndex, 10);
        if (isNaN(matchingRowIndex)) {
          return await clearSearchAndReturn(`Invalid row-index: "${actualRowIndex}"`);
        }
        log(`searchAndClickAction: Got row-index=${matchingRowIndex} from saved value`);
        
        // Use saved transfer_id and amount from when we found the match (avoid opening modal again)
        let firstRowTransferId = matchingRowButton._savedTransferId || '';
        let firstRowAmount = matchingRowButton._savedAmount || null;
        
        // Get username from table (modal shows "-" as placeholder)
        log(`searchAndClickAction: Getting username from table...`);
        scrollTableTo(0); // Scroll to User column
        await new Promise(r => setTimeout(r, 300));
        // Re-find the button using row-index since matchingRowButton might be stale
        const viewButtonsForUsername = getViewDetailsButtons();
        const btnForRow = viewButtonsForUsername.find(btn => {
          const row = btn.closest('.ag-row');
          return row?.getAttribute('row-index') === actualRowIndex;
        });
        let firstRowUsername = '';
        if (btnForRow) {
          firstRowUsername = getUsernameFromRow(btnForRow);
          log(`searchAndClickAction: Got username from table: "${firstRowUsername}"`);
        } else {
          log(`searchAndClickAction: ⚠️ Could not re-find button for row-index=${actualRowIndex}, trying to get username from saved button...`, 'warn');
          firstRowUsername = getUsernameFromRow(matchingRowButton);
        }
        
        // Fallback: If amount not found in saved data, try to get from table (scroll to show Amount column first)
        if (firstRowAmount === null) {
          log(`searchAndClickAction: Amount not found in saved data, trying table...`);
          scrollTableToShowAmountColumn();
          await new Promise(r => setTimeout(r, 300));
          if (btnForRow) {
            firstRowAmount = getAmountFromRow(btnForRow, false);
            log(`searchAndClickAction: Got amount from table: ${firstRowAmount}`);
          } else {
            firstRowAmount = getAmountFromRow(matchingRowButton, false);
          }
          // If still null, try reading from modal as last resort
          if (firstRowAmount === null && matchingRowButton) {
            log(`searchAndClickAction: Amount still null from table, trying modal...`);
            try {
              matchingRowButton.click();
              await new Promise(r => setTimeout(r, 500));
              const modal = await waitForModal(3000);
              if (modal) {
                await waitForModalTransferRef(modal, 2000);
                await new Promise(r => setTimeout(r, 200));
                const modalData = extractModalData() || extractCryptoModalData();
                if (modalData?.amount) {
                  firstRowAmount = modalData.amount;
                  log(`searchAndClickAction: Got amount from modal: ${firstRowAmount}`);
                }
                closeModal();
                await waitForModalClosed(1500);
              }
            } catch (e) {
              log(`searchAndClickAction: Error reading amount from modal: ${e.message}`, 'warn');
              closeModal();
              await waitForModalClosed(1000);
            }
          }
        }
        
        // Fallback: If transfer_id not found in saved data, try to get from table
        if (!firstRowTransferId) {
          log(`searchAndClickAction: Transfer ID not found in saved data, trying table...`);
          scrollTableToShowTransferRefColumn();
          await new Promise(r => setTimeout(r, 300));
          if (btnForRow) {
            firstRowTransferId = getTransferIdFromRow(btnForRow);
          } else {
            firstRowTransferId = getTransferIdFromRow(matchingRowButton);
          }
        }
        
        log(`searchAndClickAction: FIRST row values - transfer_id="${firstRowTransferId}", username="${firstRowUsername}", amount=${firstRowAmount}`);
        log(`searchAndClickAction: Expected values - transfer_id="${searchOrderId}", username="${expectedUsername}", amount=${expectedAmount}`);
        
        // NOTE: Username check is SKIPPED intentionally.
        // The panel's "User" column (col-id="userName") actually shows ACCOUNT NUMBERS (e.g. "7113574015"),
        // not login usernames (e.g. "surya"). Matching by username from table would always fail.
        // Transfer Reference ID match (from modal) is the reliable identifier — use that alone.

        // Check transfer reference ID prefix match FIRST (amountMatch depends on it)
        // Note: Table may only show HALF of the transfer reference ID, so we check if:
        // - The full searchOrderId starts with what we see in the table (firstRowTransferId), OR
        // - What we see in the table starts with the beginning of searchOrderId
        // ALSO: If transfer_id is empty (AG Grid virtualisation) but we found the row via search, we trust the search result
        const firstRowTransferIdClean = String(firstRowTransferId || '').trim().toLowerCase();
        const searchOrderIdClean = String(searchOrderId || '').trim().toLowerCase();

        let transferIdMatch = false;
        if (firstRowTransferIdClean && searchOrderIdClean) {
          transferIdMatch = (
            searchOrderIdClean.startsWith(firstRowTransferIdClean) || // Full ID starts with table value (table shows prefix)
            firstRowTransferIdClean.startsWith(searchOrderIdClean)    // Table value starts with search ID (table shows more)
          );
        } else if (!firstRowTransferIdClean) {
          // If transfer_id is still empty after modal fallback, but we found the row via Transfer Reference ID search,
          // trust the search result — the search engine already filtered to the matching row
          log(`searchAndClickAction: Transfer ID empty even after modal read - trusting search filter result`, 'warn');
          transferIdMatch = true;
        }

        // Check amount match (allow small rounding differences) - if expectedAmount is provided, firstRowAmount must match
        // If search returned exactly 1 row and transfer_id matches, trust the search result even if amount is null/0 (table/modal can be unreadable)
        const viewButtonsForAmountCheck = getViewDetailsButtons();
        const isSingleSearchResult = viewButtonsForAmountCheck.length === 1;
        const amountUnreadable = firstRowAmount === null || firstRowAmount === 0;
        const amountMatch = !expectedAmount || 
          (firstRowAmount !== null && firstRowAmount !== undefined && firstRowAmount > 0 && Math.abs(firstRowAmount - parseFloat(expectedAmount)) < 0.01) ||
          (isSingleSearchResult && transferIdMatch && amountUnreadable);

        log(`searchAndClickAction: Match results - transfer_id_prefix: ${transferIdMatch} (row="${firstRowTransferIdClean}", search="${searchOrderIdClean}"), amount: ${amountMatch}, username check: SKIPPED (table shows account numbers not usernames)`);

        if (!transferIdMatch) {
          return await clearSearchAndReturn(`Transfer ID mismatch: first row has "${firstRowTransferId}", expected starts with "${searchOrderId}"`);
        }

        if (!amountMatch) {
          return await clearSearchAndReturn(`Amount mismatch: first row has ${firstRowAmount}, expected ${expectedAmount}`);
        }
        
        // Step 4: All matches passed! Click approve/reject using the row-index we saved earlier
        log(`searchAndClickAction: ✅ All matches passed! Row-index=${matchingRowIndex}, clicking ${searchClickAction}`);
        
        // Scroll to show the pinned-right container (where action buttons are)
        scrollTableTo(9999); // Scroll far right to show action buttons
        await new Promise(r => setTimeout(r, 300));
        
        // Re-find the row using row-index (button reference might be stale after modal)
        const viewButtonsForClick = getViewDetailsButtons();
        const rowButton = viewButtonsForClick.find(btn => {
          const row = btn.closest('.ag-row');
          return row?.getAttribute('row-index') === actualRowIndex;
        });
        
        if (rowButton) {
          // Ensure the row is fully visible before clicking
          rowButton.scrollIntoView({ block: 'center', behavior: 'instant' });
          await new Promise(r => setTimeout(r, 300));
        }
        
        log(`searchAndClickAction: Calling clickApproveOrReject for row-index=${matchingRowIndex}...`);
        const clickResult = await clickApproveOrReject(matchingRowIndex, searchClickAction, searchUtr);
        
        if (!clickResult.success) {
          // Click failed, clear search and return error
          await clearSearchByCloseButton() || getRefreshButton()?.click() || await clearSearch();
          return { success: false, submitted: false, message: 'Failed to click approve/reject button' };
        }
        
        // Step 5: After submit – clear search, then verify cleared by searching again; if row not found = cleared
        await new Promise(r => setTimeout(r, 500)); // Brief wait for modal to close
        
        let cleared = false;
        if (clickResult.submitted) {
          log('searchAndClickAction: Modal submitted successfully, clearing search (X or empty) so page loads correctly');
          const closed = await clearSearchByCloseButton();
          if (!closed) {
            const refreshBtn = getRefreshButton();
            if (refreshBtn) {
              log('searchAndClickAction: Using Refresh button to clear search');
              refreshBtn.click();
              await new Promise(r => setTimeout(r, 300));
            }
          }
          await clearSearch();
          await new Promise(r => setTimeout(r, 1500)); // Allow panel to process submit before re-search

          // Verify cleared: search again for same transfer_id; if no row found → cleared
          log(`searchAndClickAction: Verifying cleared — searching again for transfer_id=${searchOrderId}`);
          const verifySearchRes = await applySearchByTransferReferenceId(searchOrderId);
          if (verifySearchRes?.success) {
            let verifyAttempts = 0;
            const verifyMaxAttempts = 20; // ~6s
            while (verifyAttempts < verifyMaxAttempts) {
              await new Promise(r => setTimeout(r, 300));
              const rowsAfter = getViewDetailsButtons();
              if (rowsAfter.length === 0) {
                cleared = true;
                log('searchAndClickAction: ✅ Cleared — re-search returned 0 rows (row no longer on panel)');
                break;
              }
              verifyAttempts++;
            }
            if (!cleared) {
              const rowsAfterFinal = getViewDetailsButtons();
              if (rowsAfterFinal.length === 0) {
                cleared = true;
                log('searchAndClickAction: ✅ Cleared — no rows after verify wait');
              } else {
                log(`searchAndClickAction: Row still found after submit (${rowsAfterFinal.length} row(s)) — will retry approve/reject once`, 'warn');
              }
            }
          } else {
            log('searchAndClickAction: Verify re-search failed, assuming not cleared', 'warn');
          }
          // Clear search again after verify so page state is clean
          await clearSearchByCloseButton() || (getRefreshButton()?.click() && await new Promise(r => setTimeout(r, 300)));
          await clearSearch();
        } else {
          log('searchAndClickAction: Modal not submitted, skipping search clear and verify');
        }

        // If not cleared and we had submitted: retry click approve/reject + fill + submit once, then re-verify
        if (clickResult.submitted && !cleared && clickResult.success) {
          log('searchAndClickAction: Retrying approve/reject once (row still on panel)...');
          await new Promise(r => setTimeout(r, 500));
          const searchRetry = await applySearchByTransferReferenceId(searchOrderId);
          if (searchRetry?.success) {
            const matchResult = await waitForFirstRowTransferIdToMatch(searchOrderId, 6000);
            if (matchResult) {
              const viewButtonsRetry = getViewDetailsButtons();
              if (viewButtonsRetry.length > 0) {
                scrollTableToShowTransferRefColumn();
                await new Promise(r => setTimeout(r, 300));
                const retryClickResult = await clickApproveOrReject(0, searchClickAction, searchUtr);
                if (retryClickResult.success && retryClickResult.submitted) {
                  await new Promise(r => setTimeout(r, 500));
                  await clearSearchByCloseButton() || getRefreshButton()?.click();
                  await clearSearch();
                  await new Promise(r => setTimeout(r, 1500));
                  const verify2Res = await applySearchByTransferReferenceId(searchOrderId);
                  if (verify2Res?.success) {
                    let v2 = 0;
                    for (; v2 < 20; v2++) {
                      await new Promise(r => setTimeout(r, 300));
                      if (getViewDetailsButtons().length === 0) {
                        cleared = true;
                        log('searchAndClickAction: ✅ Cleared after retry — re-search returned 0 rows');
                        break;
                      }
                    }
                  }
                  await clearSearchByCloseButton() || getRefreshButton()?.click();
                  await clearSearch();
                }
              }
            }
          }
        }

        // Return success + submitted + cleared (cleared = row no longer found on panel after submit)
        return { success: clickResult.success, submitted: clickResult.submitted, cleared };
      }
      case 'applySearchByTransferReferenceId':
        return await applySearchByTransferReferenceId(request.transferRefId || request.orderId);
      case 'clearSearch':
        await clearSearch();
        return { success: true };
      case 'getViewDetailsButtonsCount':
        return { count: getViewDetailsButtons().length };
      case 'setDateFilterToWeek':
        return await setDateFilterToWeek();
      case 'clickRefresh': {
        const CLICK_REFRESH_TIMEOUT_MS = 20000; // 20s max so background doesn't time out
        const doRefresh = async () => {
          const refreshBtn = getRefreshButton();
          if (refreshBtn) {
            log('clickRefresh: clicking Refresh button first...');
            refreshBtn.click();
            await new Promise(r => setTimeout(r, 2000)); // wait for table to reload
          } else {
            log('clickRefresh: Refresh button not found, proceeding to filter anyway', 'warn');
          }
          log('clickRefresh: applying Week filter after refresh...');
          const filterResult = await setDateFilterToWeek();
          if (filterResult?.success) {
            log('clickRefresh: ✅ Refresh + Week filter applied');
          } else {
            log(`clickRefresh: ⚠️ Week filter failed after refresh: ${filterResult?.message}`, 'warn');
          }
          return { success: true };
        };
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`clickRefresh timeout after ${CLICK_REFRESH_TIMEOUT_MS / 1000}s`)), CLICK_REFRESH_TIMEOUT_MS)
        );
        const result = await Promise.race([doRefresh(), timeoutPromise]).catch((e) => {
          log(`clickRefresh: ${e.message}`, 'warn');
          return { success: false, message: e.message };
        });
        return result;
      }
      default:
        log(`Unknown action: ${request.action}`, 'warn');
        return { error: 'Unknown action' };
    }
  };
  run().then(result => {
    log(`[MESSAGE] Action ${request.action} completed, sending response: ${JSON.stringify(result).substring(0, 150)}`);
    sendResponse(result);
  }).catch(error => {
    log(`[MESSAGE] Action ${request.action} failed: ${error.message}`, 'error');
    sendResponse({ error: error.message });
  });
  return true; // Keep channel open for async response
});
log('[INIT] Message listener set up successfully');
log('[INIT] To send rows to autobot: click **Start** in the extension popup. Within ~30s you should see getTransferIdsFromTable / extractAllRows here.');
log('[INIT] If the page has more transactions than created: (1) Search this console for "SKIPPED" or "NOT created". (2) Check service worker console for "already in DB" or API errors. (3) "Previous iteration still in progress" means that run was skipped — next run will process.');
log('[INIT] If the window is small, keep the reader tab visible — the extension scrolls elements into view before reading.');

})(); // end IIFE
