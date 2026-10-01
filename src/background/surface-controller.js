/**
 * Secure-surface lifecycle. This module is passive: service-worker.js owns every listener,
 * authorization map, and action route, then injects the narrow capabilities used here.
 */
export function createSurfaceController({
  chromeApi,
  cryptoImpl,
  sessionStore,
  allowedPages,
  defaultPresentations,
  hostRequests,
  claimTtlMs,
  activeTtlMs,
  cancelRequestsForFrame,
  logger = console,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer)
}) {
  if (!chromeApi?.runtime || !cryptoImpl || !sessionStore || !(allowedPages instanceof Set)
      || !(defaultPresentations instanceof Map) || !(hostRequests instanceof Map)
      || typeof sessionStore.withSourceLock !== 'function'
      || typeof sessionStore.loadBySource !== 'function'
      || typeof sessionStore.detachSource !== 'function') {
    throw new TypeError('surface controller dependencies are required');
  }

  function createToken() {
    if (cryptoImpl.randomUUID) return cryptoImpl.randomUUID();
    const bytes = new Uint8Array(24);
    cryptoImpl.getRandomValues(bytes);
    return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function windowSize(page) {
    if (page === 'history') return { width: 920, height: 780 };
    if (page === 'prompt') return { width: 760, height: 820 };
    if (page === 'batch') return { width: 640, height: 820 };
    if (page === 'video') return { width: 760, height: 860 };
    if (page === 'reverse') return { width: 720, height: 640 };
    if (page === 'translation') return { width: 520, height: 440 };
    return { width: 840, height: 780 };
  }

  function openResponse(record, token = '', reused = false) {
    return {
      success: true,
      data: {
        clientNonce: record.clientNonce,
        token,
        presentation: record.presentation,
        fallbackReason: record.fallbackReason,
        reused
      }
    };
  }

  async function closeSurfaceRecordUnlocked(record, closeWindow = false) {
    if (!record) return false;
    if (record.claimTimer !== null) clearTimer(record.claimTimer);
    cancelRequestsForFrame(record.surfaceTabId, record.surfaceFrameId);
    let storageError = null;
    try { await sessionStore.remove(record); } catch (error) { storageError = error; }
    if (closeWindow && Number.isInteger(record.windowId)) {
      try { chromeApi.windows.remove(record.windowId, () => void chromeApi.runtime.lastError); } catch (_e) { /* already closed */ }
    }
    try {
      chromeApi.tabs.sendMessage(record.sourceTabId, {
        __hpSurfaceHost: true,
        type: 'closed',
        clientNonce: record.clientNonce
      }, { frameId: record.sourceFrameId }, () => void chromeApi.runtime.lastError);
    } catch (_e) { /* source tab already gone */ }
    if (storageError) throw storageError;
    return true;
  }

  async function closeSurfaceRecord(record, closeWindow = false, shouldClose = () => true) {
    if (!record) return false;
    return sessionStore.withSourceLock(record.sourceTabId, record.page, async () => {
      const latest = await sessionStore.loadByKey(record.storageKey);
      if (!latest || !shouldClose(latest)) return false;
      return closeSurfaceRecordUnlocked(latest, closeWindow);
    });
  }

  async function prune(expiryTime = now()) {
    for (const record of await sessionStore.list()) {
      if (record.expiresAt <= expiryTime) {
        await closeSurfaceRecord(record, true, (latest) => latest.expiresAt <= expiryTime);
      }
    }
  }

  function focusSourceHost(record) {
    return new Promise((resolve) => {
      try {
        chromeApi.tabs.sendMessage(record.sourceTabId, {
          __hpSurfaceHost: true,
          type: 'focus',
          clientNonce: record.clientNonce
        }, { frameId: record.sourceFrameId }, (response) => {
          const failed = !!chromeApi.runtime.lastError;
          resolve(!failed && response?.success === true && response.open === true);
        });
      } catch (_error) {
        resolve(false);
      }
    });
  }

  function focusExistingSurface(record) {
    if (record.presentation !== 'native-window' || !Number.isInteger(record.windowId)) {
      return focusSourceHost(record);
    }
    if (typeof chromeApi.windows?.update !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        chromeApi.windows.update(record.windowId, { focused: true }, (updatedWindow) => {
          const failed = !!chromeApi.runtime.lastError;
          resolve(!failed && !!updatedWindow);
        });
      } catch (_error) {
        resolve(false);
      }
    });
  }

  function scheduleClaimExpiry(record) {
    if (record.surfaceTabId !== null || record.claimTimer !== null) return;
    record.claimTimer = setTimer(() => {
      void (async () => {
        const latest = await sessionStore.loadByKey(record.storageKey);
        if (latest && latest.surfaceTabId === null) {
          await closeSurfaceRecord(latest, true, (current) => (
            current.surfaceTabId === null && current.expiresAt <= now()
          ));
        }
      })().catch(() => {});
    }, claimTtlMs + 1000);
  }

  function openNative(record, token) {
    const size = windowSize(record.page);
    return new Promise((resolve) => {
      chromeApi.windows.create({
        url: chromeApi.runtime.getURL(`src/embed/${record.page}.html#${encodeURIComponent(token)}`),
        type: 'popup', focused: true, width: size.width, height: size.height
      }, (createdWindow) => {
        const createError = chromeApi.runtime.lastError?.message || '';
        if (createError || !createdWindow) {
          void (async () => {
            try { await closeSurfaceRecordUnlocked(record, false); } catch (_closeError) { /* best effort */ }
            resolve({ success: false, error: createError || 'failed to open secure surface' });
          })();
          return;
        }
        record.windowId = createdWindow.id;
        const bindCreatedTab = async (tabs) => {
          const surfaceTabId = tabs?.find?.((tab) => Number.isInteger(tab?.id))?.id;
          if (!Number.isInteger(surfaceTabId)) {
            await closeSurfaceRecordUnlocked(record, true);
            resolve({ success: false, error: 'failed to bind secure surface tab' });
            return;
          }
          const current = await sessionStore.loadByKey(record.storageKey);
          if (!current || current !== record) {
            try { chromeApi.windows.remove(createdWindow.id, () => void chromeApi.runtime.lastError); } catch (_e) { /* already closed */ }
            resolve({ success: false, error: 'secure surface session disappeared' });
            return;
          }
          if ((record.expectedSurfaceTabId !== null && record.expectedSurfaceTabId !== surfaceTabId)
              || (record.surfaceTabId !== null && record.surfaceTabId !== surfaceTabId)) {
            await closeSurfaceRecordUnlocked(record, true);
            resolve({ success: false, error: 'secure surface tab mismatch' });
            return;
          }
          record.expectedSurfaceTabId = surfaceTabId;
          record.expectedSurfaceFrameId = 0;
          await sessionStore.save(record);
          scheduleClaimExpiry(record);
          resolve(openResponse(record, token));
        };
        const safelyBindCreatedTab = (tabs) => {
          void bindCreatedTab(tabs).catch(async (error) => {
            try { await closeSurfaceRecordUnlocked(record, true); } catch (_closeError) { /* best effort below */ }
            try { chromeApi.windows.remove(createdWindow.id, () => void chromeApi.runtime.lastError); } catch (_e) { /* already closed */ }
            resolve({ success: false, error: error?.message || 'failed to persist secure surface' });
          });
        };
        const createdTabs = Array.isArray(createdWindow.tabs) ? createdWindow.tabs : [];
        if (createdTabs.some((tab) => Number.isInteger(tab?.id))) {
          safelyBindCreatedTab(createdTabs);
          return;
        }
        chromeApi.tabs.query({ windowId: createdWindow.id }, (tabs) => {
          const queryError = chromeApi.runtime.lastError?.message || '';
          if (queryError) {
            void (async () => {
              try { await closeSurfaceRecordUnlocked(record, true); } catch (_closeError) { /* best effort */ }
              resolve({ success: false, error: queryError || 'failed to bind secure surface tab' });
            })();
            return;
          }
          safelyBindCreatedTab(tabs);
        });
      });
    });
  }

  async function claimedSurfaceForSender(sender, expectedPage = '') {
    const tabId = sender?.tab?.id;
    const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
    if (!Number.isInteger(tabId)) return null;
    const record = await sessionStore.loadClaimed(tabId, expectedPage, frameId);
    if (!record) return null;
    if (record.expiresAt <= now()) {
      await closeSurfaceRecord(record, true, (latest) => latest.expiresAt <= now());
      return null;
    }
    return record;
  }

  async function handleOpenSurface(data, sender, sendResponse) {
    const page = data?.page;
    const sourceTabId = sender?.tab?.id;
    const sourceFrameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
    const clientNonce = data?.clientNonce;
    if (!allowedPages.has(page) || !Number.isInteger(sourceTabId)
        || typeof clientNonce !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(clientNonce)) {
      sendResponse({ success: false, error: 'invalid surface request' });
      return;
    }
    let initJson;
    try { initJson = JSON.stringify(data?.initData || null); } catch (_e) { initJson = ''; }
    // Main accepts the complete selection/prefill. JSON validity is the only controller-level
    // check; the browser runtime remains the transport-allocation boundary.
    if (!initJson) {
      sendResponse({ success: false, error: 'invalid surface payload' });
      return;
    }

    const openedAt = now();
    await prune(openedAt);
    await sessionStore.withSourceLock(sourceTabId, page, async () => {
      let existing = await sessionStore.loadBySource(sourceTabId, page);
      if (existing?.expiresAt <= openedAt) {
        await closeSurfaceRecordUnlocked(existing, true);
        existing = null;
      }
      if (existing) {
        // Native utility windows may be focused safely, but an in-page surface
        // owns invocation-specific initData/host bridges. Reusing it would make
        // the second action operate on the first selection/image/prefill.
        if (existing.presentation === 'native-window' && await focusExistingSurface(existing)) {
          sendResponse(openResponse(existing, '', true));
          return;
        }
      }

      if (existing) {
        if (existing.presentation === 'overlay-iframe' && existing.surfaceTabId !== null) {
          // A claimed iframe may already be visually detached while accepted model work continues.
          // Release only the visible source singleton; keep its token/frame authorization alive so
          // reopening the same feature cannot cancel the earlier job or suppress its History write.
          await sessionStore.detachSource(existing);
        } else {
          await closeSurfaceRecordUnlocked(existing, true);
        }
      }

      const defaultPresentation = defaultPresentations.get(page);
      const nativeRequested = data?.presentation === 'native-window';
      const presentation = defaultPresentation === 'native-window' || nativeRequested
        ? 'native-window' : 'overlay-iframe';
      const fallbackReason = presentation === 'native-window' && defaultPresentation !== 'native-window'
        ? String(data?.fallbackReason || 'requested-native-fallback').slice(0, 160) : '';
      if (fallbackReason) logger.warn('[HyperPrompt] surface fallback', { page, sourceTabId, reason: fallbackReason });

      const token = createToken();
      const record = {
        storageKey: await sessionStore.keyForToken(token), page, clientNonce, sourceTabId, sourceFrameId,
        initData: data?.initData || null, presentation, fallbackReason,
        expectedSurfaceTabId: presentation === 'overlay-iframe' ? sourceTabId : null,
        expectedSurfaceFrameId: presentation === 'overlay-iframe' ? null : 0,
        surfaceTabId: null, surfaceFrameId: null, windowId: null, claimTimer: null,
        sourceIndexed: true,
        expiresAt: openedAt + claimTtlMs
      };
      await sessionStore.save(record);
      if (presentation === 'native-window') {
        sendResponse(await openNative(record, token));
        return;
      }
      scheduleClaimExpiry(record);
      sendResponse(openResponse(record, token));
    });
  }

  async function handleClaimSurface(data, sender, sendResponse) {
    let senderPath = '';
    try { senderPath = new URL(sender?.url || '').pathname; } catch (_e) { /* invalid sender URL */ }
    const candidate = await sessionStore.loadByToken(data?.token);
    if (!candidate) {
      sendResponse({ success: false, error: 'invalid surface session' });
      return;
    }
    await sessionStore.withSourceLock(candidate.sourceTabId, candidate.page, async () => {
      const latest = await sessionStore.loadByKey(candidate.storageKey);
      if (!latest) {
        sendResponse({ success: false, error: 'invalid surface session' });
        return;
      }
      const claim = await sessionStore.claim({
        token: data?.token,
        clientNonce: data?.clientNonce || '',
        tabId: sender?.tab?.id,
        frameId: Number.isInteger(sender?.frameId) ? sender.frameId : 0,
        senderPath,
        now: now(),
        activeTtlMs
      });
      if (!claim.success) {
        if (claim.record?.surfaceTabId === null) await closeSurfaceRecordUnlocked(claim.record, true);
        sendResponse({ success: false, error: 'invalid surface session' });
        return;
      }
      const record = claim.record;
      if (record.claimTimer !== null) clearTimer(record.claimTimer);
      record.claimTimer = null;
      sendResponse({ success: true, data: { page: record.page, initData: claim.initData } });
    });
  }

  async function handleSurfaceHostRequest(data, sender, sendResponse) {
    const record = await sessionStore.loadByToken(data?.token);
    const requestType = data?.requestType;
    const requestId = data?.requestId;
    if (!record || record.expiresAt <= now() || record.surfaceTabId !== sender?.tab?.id
        || record.surfaceFrameId !== (Number.isInteger(sender?.frameId) ? sender.frameId : 0)
        || typeof requestType !== 'string' || requestType.length > 80
        || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
        || !hostRequests.get(record.page)?.has(requestType)) {
      sendResponse({ success: false, error: 'invalid surface host request' });
      return;
    }
    chromeApi.tabs.sendMessage(record.sourceTabId, {
      __hpSurfaceHost: true, type: 'request', clientNonce: record.clientNonce,
      requestId, requestType, data: data?.data || null
    }, { frameId: record.sourceFrameId }, (response) => {
      if (chromeApi.runtime.lastError) {
        sendResponse({ success: false, error: chromeApi.runtime.lastError.message });
        return;
      }
      sendResponse(response?.success === false
        ? { success: false, error: String(response.error || 'host request failed') }
        : { success: true, data: response?.data });
    });
  }

  async function handleFocusSurface(data, sender, sendResponse) {
    const page = data?.page;
    const sourceTabId = sender?.tab?.id;
    const sourceFrameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
    const clientNonce = data?.clientNonce;
    if (!allowedPages.has(page) || !Number.isInteger(sourceTabId)
        || typeof clientNonce !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(clientNonce)) {
      sendResponse({ success: false, open: false, error: 'invalid surface focus request' });
      return;
    }
    await sessionStore.withSourceLock(sourceTabId, page, async () => {
      const record = await sessionStore.loadBySource(sourceTabId, page);
      const owned = !!record
        && record.sourceTabId === sourceTabId
        && record.sourceFrameId === sourceFrameId
        && record.clientNonce === clientNonce;
      if (!owned) {
        sendResponse({ success: false, open: false, error: 'surface is not open' });
        return;
      }
      if (record.expiresAt <= now() || !(await focusExistingSurface(record))) {
        await closeSurfaceRecordUnlocked(record, true);
        sendResponse({ success: false, open: false, error: 'surface is not open' });
        return;
      }
      sendResponse({ success: true, open: true, presentation: record.presentation });
    });
  }

  async function handleCloseSurface(data, sender, sendResponse) {
    const senderTabId = sender?.tab?.id;
    const senderFrameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
    let record = await sessionStore.loadByToken(data?.token);
    if (!record && allowedPages.has(data?.page) && typeof data?.clientNonce === 'string') {
      const indexed = await sessionStore.loadBySource(senderTabId, data.page);
      if (indexed?.clientNonce === data.clientNonce) record = indexed;
    }
    const claimedSurface = !!record && record.surfaceTabId === senderTabId && record.surfaceFrameId === senderFrameId;
    const sourceHost = !!record && record.sourceTabId === senderTabId && record.sourceFrameId === senderFrameId;
    const valid = claimedSurface || sourceHost;
    if (valid) await closeSurfaceRecord(record, sourceHost && record.presentation === 'native-window');
    sendResponse({ success: valid });
  }

  async function handleTabRemoved(tabId) {
    for (const record of await sessionStore.list()) {
      if (record.surfaceTabId === tabId || record.expectedSurfaceTabId === tabId) await closeSurfaceRecord(record, false);
      else if (record.sourceTabId === tabId) await closeSurfaceRecord(record, true);
    }
  }

  return Object.freeze({
    claimedSurfaceForSender,
    handleOpenSurface,
    handleClaimSurface,
    handleSurfaceHostRequest,
    handleFocusSurface,
    handleCloseSurface,
    handleTabRemoved
  });
}
