/**
 * 内容脚本 - 上下文菜单规则解析层（默认规则表 + 按分类解析活动规则内容）
 * 从 content.js 抽出的规则 helper：getDefaultCtxRules（内置默认规则表）与
 * getRuleContentForCategory（拉取用户规则配置 + 解析当前活动规则内容）。
 * 经典脚本（无 import/export），在 content-streaming.js 之后、content.js 之前加载。
 * 对外挂 window.__hpRules（与 content-common 的 window.__hp、content-streaming 的 window.__hpStreaming、
 * content-metadata 的 window.__hpMetadata 相互独立）。
 * 依赖：window.__hpStreaming.safeSendMessage、window.__hp.resolveRuleForContext。
 */

(() => {
  if (window.__hpRules) return;

const safeSendMessage = window.__hpStreaming.safeSendMessage;
const resolveRuleForContext = window.__hp.resolveRuleForContext;

function getDefaultCtxRules() {
  const factory = globalThis.__hpBuiltinRules?.getDefaultRules;
  if (typeof factory !== 'function') {
    throw new Error('Built-in rules source was not loaded before content-rules.js');
  }
  return factory();
}

// 共享迁移保持原有 eager + fail-soft 语义；options/content 共用同一实现和 marker。
const visionEnDefaultMigration = globalThis.__hpBuiltinRules.migrateVisionEnDefault();

function getRuleContentForCategory(ruleCategory, fallback, callback) {
  const defaults = getDefaultCtxRules();
  visionEnDefaultMigration.finally(() => {
    safeSendMessage({ action: 'getConfig', data: { type: 'rules' } }, (resp) => {
      const rulesConfig = resp?.success && resp.data ? resp.data : defaults;
      const catData = rulesConfig[ruleCategory] || defaults[ruleCategory] || { active: '', rules: [] };
      const activeRule = resolveRuleForContext(catData);
      // 第二参把完整规则对象也给到调用方，供需要规则元信息的调用方使用；旧调用方只收第一参不受影响
      callback(activeRule?.content || fallback, activeRule);
    });
  });
}

// 内置规则全量对所有用户开放，不区分任何等级；不设按次或按类别的用量闸门。

window.__hpRules = { getDefaultCtxRules, getRuleContentForCategory };
})();
