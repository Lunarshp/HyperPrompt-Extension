'use strict';

const field = document.getElementById('clipboard');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message?.action !== 'clipboard:write') return;
  if (sender.id !== chrome.runtime.id || typeof message.text !== 'string') {
    sendResponse({ success: false, error: 'Invalid clipboard request' });
    return;
  }

  field.value = message.text;
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
  let success = false;
  try {
    success = document.execCommand('copy');
  } finally {
    field.value = '';
  }
  sendResponse({
    success,
    error: success ? undefined : 'Clipboard copy command failed'
  });
});
