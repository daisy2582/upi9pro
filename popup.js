// Wake up service worker by sending a ping first
// Use connect() which is more reliable for waking inactive service workers
async function wakeServiceWorker(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      // Try using connect() first - this wakes up the service worker
      try {
        const port = chrome.runtime.connect({ name: 'wakeup' });
        // Keep connection open briefly to ensure service worker wakes up
        await new Promise(resolve => setTimeout(resolve, 200));
        port.disconnect();
      } catch (connectError) {
        console.warn(`Connect attempt ${i + 1} failed:`, connectError);
      }
      
      // Wait a bit for service worker to wake up
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Now try sending a message
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            // Check if it's an inactive service worker error
            if (errorMsg.includes('message port closed') || 
                errorMsg.includes('Receiving end does not exist') ||
                errorMsg.includes('Extension context invalidated')) {
              reject(new Error('Service worker is inactive'));
            } else {
              reject(new Error(errorMsg));
            }
            return;
          }
          resolve(response);
        });
        setTimeout(() => reject(new Error('Service worker not responding')), 5000);
      });
      
      // Verify we got a valid response
      if (response && (response.pong || response.timestamp)) {
        console.log(`Service worker woke up successfully on attempt ${i + 1}`);
        return response;
      }
      throw new Error('Invalid response from service worker');
    } catch (error) {
      console.warn(`Wake-up attempt ${i + 1}/${retries} failed:`, error.message);
      if (i === retries - 1) {
        throw error;
      }
      // Exponential backoff: wait longer between retries
      const waitTime = Math.min(1000 * Math.pow(2, i), 5000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup loaded, initializing...');
  
  try {
    await loadSettings();
    console.log('Settings loaded');
  } catch (error) {
    console.error('Error loading settings:', error);
    showStatus('Error loading settings: ' + error.message, 'error');
  }
  
  // Try to wake up service worker when popup opens (non-blocking)
  wakeServiceWorker()
    .then(() => {
      console.log('Service worker is active');
      showStatus('Service worker is active', 'success');
      setTimeout(() => {
        const statusEl = document.getElementById('status');
        if (statusEl && statusEl.textContent === 'Service worker is active') {
          statusEl.className = 'status'; // Hide after 2 seconds
        }
      }, 2000);
    })
    .catch((error) => {
      console.warn('Service worker wake-up failed (will try when you click Start):', error);
      // Don't show error on popup open - just try when user clicks Start
    });
  
  try {
    loadStatus();
  } catch (error) {
    console.error('Error loading status:', error);
  }

  const settingsForm = document.getElementById('settingsForm');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await saveSettings();
      } catch (error) {
        console.error('Error saving settings:', error);
        showStatus('Error saving settings: ' + error.message, 'error');
      }
    });
  } else {
    console.error('Settings form not found!');
  }

  const startBtn = document.getElementById('startBtn');
  if (!startBtn) {
    console.error('Start button not found!');
    showStatus('Error: Start button not found. Please reload the extension.', 'error');
    return;
  }
  
  // Ensure button is enabled initially and clickable
  startBtn.disabled = false;
  startBtn.style.cursor = 'pointer';
  startBtn.style.opacity = '1';
  startBtn.style.pointerEvents = 'auto';
  startBtn.style.userSelect = 'none';
  
  // Test if button is clickable
  console.log('Start button element:', startBtn);
  console.log('Start button disabled:', startBtn.disabled);
  console.log('Start button type:', startBtn.type);
  console.log('Start button computed style:', window.getComputedStyle(startBtn));
  
  // Add a test click handler to verify the button works
  startBtn.addEventListener('mousedown', () => {
    console.log('Start button mousedown event fired');
  });
  
  startBtn.addEventListener('mouseenter', () => {
    console.log('Start button mouseenter event fired');
  });
  
  console.log('Attaching start button click handler');
  
  // Use both onclick and addEventListener to ensure it works
  const startHandler = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Start button clicked');
    
    // Prevent double-clicks
    if (startBtn.disabled) {
      console.log('Start button already disabled, ignoring click');
      return;
    }
    
    const settings = collectSettings();
    if (!settings.panelUsername || !settings.panelPassword) {
      showStatus('Please enter panel username and password', 'error');
      return;
    }
    await saveSettings();
    showStatus('Starting automation...', 'info');
    
    // Try to wake up service worker (non-blocking)
    wakeServiceWorker().catch(err => {
      console.warn('Service worker wake-up failed (non-critical):', err);
    });
    
    // Small delay to let service worker wake up
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Use promise-based sendMessage for better error handling
      const response = await new Promise((resolve, reject) => {
        // Try to wake service worker with connect first
        try {
          const port = chrome.runtime.connect({ name: 'startAutomation' });
          port.disconnect();
        } catch (e) {
          console.warn('Connect failed:', e);
        }
        
        chrome.runtime.sendMessage({ action: 'startAutomation' }, (r) => {
          if (chrome.runtime.lastError) {
            const errorMsg = chrome.runtime.lastError.message;
            // If service worker is inactive, provide helpful message
            if (errorMsg.includes('message port closed') || errorMsg.includes('Receiving end does not exist')) {
              reject(new Error('Service worker is inactive. Please: 1) Go to chrome://extensions 2) Find this extension 3) Click "service worker" link to activate it 4) Then try again'));
            } else {
              reject(new Error(errorMsg));
            }
            return;
          }
          resolve(r);
        });
        // Timeout after 15 seconds
        setTimeout(() => {
          reject(new Error('No response from service worker after 15s. The service worker may be inactive. Please: 1) Go to chrome://extensions 2) Click "service worker" link 3) Try again'));
        }, 15000);
      });
      
      if (response?.error) {
        console.error('Automation start error:', response.error);
        showStatus('Error: ' + response.error, 'error');
      } else {
        console.log('Automation started successfully');
        showStatus('Automation started successfully!', 'success');
      }
      loadStatus();
    } catch (error) {
      console.error('Exception starting automation:', error);
      const errorMsg = error.message || String(error);
      
      // Provide helpful instructions for service worker issues
      if (errorMsg.includes('inactive') || errorMsg.includes('service worker') || errorMsg.includes('No response')) {
        showStatus('⚠️ SERVICE WORKER INACTIVE\n\nTo fix:\n1. Open chrome://extensions\n2. Find "Agent Withdrawal Automation"\n3. Click "service worker" link (next to "Inspect views")\n4. Come back and click Start again', 'error');
      } else {
        showStatus('Error: ' + errorMsg, 'error');
      }
      
      // Try to reload status anyway
      setTimeout(() => loadStatus(), 1000);
    }
  };
  
  // Attach handler using both methods to ensure it works
  startBtn.addEventListener('click', startHandler);
  startBtn.onclick = startHandler;
  
  console.log('Start button handler attached successfully');

  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Stop button clicked');
      try {
        chrome.runtime.sendMessage({ action: 'stopAutomation' }, (r) => {
          if (chrome.runtime.lastError) {
            console.error('Error stopping automation:', chrome.runtime.lastError);
            showStatus('Error: ' + chrome.runtime.lastError.message, 'error');
            return;
          }
          showStatus(r?.error || 'Automation stopped', r?.error ? 'error' : 'success');
          loadStatus();
        });
      } catch (error) {
        console.error('Exception stopping automation:', error);
        showStatus('Error: ' + error.message, 'error');
      }
    });
  } else {
    console.error('Stop button not found!');
  }
  
  // Test connection button
  const testConnectionBtn = document.getElementById('testConnectionBtn');
  if (testConnectionBtn) {
    testConnectionBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Test connection button clicked');
      showStatus('Testing service worker connection...', 'info');
      
      try {
        // Try to wake service worker
        try {
          const port = chrome.runtime.connect({ name: 'test' });
          port.disconnect();
        } catch (e) {
          console.warn('Connect failed:', e);
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: 'ping' }, (r) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(r);
          });
          setTimeout(() => reject(new Error('No response after 5 seconds')), 5000);
        });
        
        if (response?.pong) {
          showStatus('✅ Service worker is ACTIVE and responding!', 'success');
        } else {
          showStatus('⚠️ Service worker responded but with unexpected format', 'error');
        }
      } catch (error) {
        console.error('Test connection failed:', error);
        showStatus('❌ Service worker is INACTIVE\n\nTo activate:\n1. Go to chrome://extensions\n2. Find this extension\n3. Click "service worker" link\n4. Click this test button again', 'error');
      }
    });
  }
  
  console.log('Popup initialization complete');
});

function collectSettings() {
  return {
    panelUsername: document.getElementById('panelUsername').value.trim(),
    panelPassword: document.getElementById('panelPassword').value,
    dbApiUrl: (document.getElementById('dbApiUrl').value || '').replace(/\/$/, ''),
    loginGroupKey: document.getElementById('loginGroupKey').value.trim() || null,
    gatewayhubUserId: parseInt(document.getElementById('gatewayhubUserId').value || '1', 10)
  };
}

async function saveSettings() {
  const s = collectSettings();
  await chrome.storage.local.set(s);
  showStatus('Settings saved', 'success');
}

async function loadSettings() {
  const keys = ['panelUsername', 'panelPassword', 'dbApiUrl', 'loginGroupKey', 'gatewayhubUserId'];
  const r = await chrome.storage.local.get(keys);
  document.getElementById('panelUsername').value = r.panelUsername || 'surya.k@nexora.tech';
  document.getElementById('panelPassword').value = r.panelPassword || '';
  document.getElementById('dbApiUrl').value = r.dbApiUrl || 'https://autoflow-ce-api.botauto.online';
  document.getElementById('loginGroupKey').value = r.loginGroupKey || '';
  document.getElementById('gatewayhubUserId').value = String(r.gatewayhubUserId || 1);
}

function loadStatus() {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const tabStatusDiv = document.getElementById('tabStatus');
  const log = document.getElementById('log');
  
  // Default to allowing start if service worker doesn't respond
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.style.cursor = 'pointer';
    startBtn.style.opacity = '1';
  }
  if (stopBtn) {
    stopBtn.disabled = true;
  }
  if (tabStatusDiv) {
    tabStatusDiv.style.display = 'none';
  }
  
  chrome.runtime.sendMessage({ action: 'getStatus' }, (r) => {
    if (chrome.runtime.lastError) {
      console.warn('Failed to get status:', chrome.runtime.lastError);
      // Keep buttons in default state if service worker doesn't respond
      return;
    }
    
    if (log) {
      log.textContent = r?.log || '';
      log.scrollTop = log.scrollHeight;
    }
    
    if (r?.isRunning) {
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.cursor = 'not-allowed';
        startBtn.style.opacity = '0.5';
      }
      if (stopBtn) {
        stopBtn.disabled = false;
        stopBtn.style.cursor = 'pointer';
        stopBtn.style.opacity = '1';
      }
      // Show two-tab status indicators
      if (tabStatusDiv) {
        tabStatusDiv.style.display = 'block';
        const readerInd = document.getElementById('readerTabIndicator');
        if (readerInd) {
          readerInd.textContent = r.readerTabId ? ` ✅ Active (Tab ${r.readerTabId})` : ' ⏳ Starting...';
          readerInd.style.color = r.readerTabId ? '#4ade80' : '#fbbf24';
        }
        const mismatchInd = document.getElementById('mismatchTabIndicator');
        if (mismatchInd) {
          mismatchInd.textContent = r.mismatchTabId ? ` ✅ Active (Tab ${r.mismatchTabId})` : ' ⏳ Starting...';
          mismatchInd.style.color = r.mismatchTabId ? '#4ade80' : '#fbbf24';
        }
      }
    } else {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.cursor = 'pointer';
        startBtn.style.opacity = '1';
      }
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.style.cursor = 'not-allowed';
        stopBtn.style.opacity = '0.5';
      }
      if (tabStatusDiv) {
        tabStatusDiv.style.display = 'none';
      }
    }
  });
}

function showStatus(msg, type = 'info') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status visible ' + type;
}
