import type { Message } from '../shared/messages.js';

/**
 * Background service worker: registers the two launch paths (context-menu item
 * and the Alt+R command) and tells the active tab's content script to start.
 * The content script does the actual selection reading + overlay work.
 */

const MENU_ID = 'gread-read-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Speed-read selection',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void start(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'start-reading') void start(tab);
});

/** Resolve a target tab id (the trigger usually supplies one) and message it. */
async function start(tab?: chrome.tabs.Tab): Promise<void> {
  let tabId = tab?.id;
  if (tabId == null) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id;
  }
  if (tabId == null) return;

  const message: Message = { type: 'START' };
  // Fails harmlessly on pages where no content script runs (chrome://, store).
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
