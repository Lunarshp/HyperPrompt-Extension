/** locale 聚合：新增语种在此登记，并加进 i18n.js 的 SUPPORTED_LANGS */
import '../overlay-locales.js';
import { zhCN } from './zh-CN.js';
import { en } from './en.js';

const sharedOverlayStrings = globalThis.__hpSharedOverlayStrings;

export const messages = {
  'zh-CN': { ...sharedOverlayStrings['zh-CN'], ...zhCN },
  'en': { ...sharedOverlayStrings.en, ...en }
};
