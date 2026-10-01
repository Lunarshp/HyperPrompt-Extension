/**
 * 页面图片采集层 - 从 content.js 抽出（经典脚本，共享 isolated-world window）。
 * Pinterest/Behance 感知的页面图片收集、去重、按分辨率排序，以及可视化历史 URL 过滤。
 * 无 import/export；IIFE 隔离内部声明（共享全局防撞名）+ 幂等守卫；挂 window.__hpScan，供 content.js 别名引用。
 */

(() => {
  if (window.__hpScan) return;

function collectPageImages() {
  const url = location.href;
  let images = [];

  if (url.includes('pinterest.com')) {
    images = Array.from(document.querySelectorAll('img[src]'))
      .filter(img => (img.currentSrc || img.src).includes('pinimg') || (img.currentSrc || img.src).includes('pinterest'));
    if (!images.length) {
      images = Array.from(document.querySelectorAll('img[src]'));
    }
  } else if (url.includes('behance.net')) {
    images = Array.from(document.querySelectorAll('img[src]'))
      .filter(img => (img.currentSrc || img.src).includes('behance') || (img.currentSrc || img.src).includes('pixel'));
    if (!images.length) {
      images = Array.from(document.querySelectorAll('img[src]'));
    }
  } else {
    images = Array.from(document.querySelectorAll('img[src]'));
  }

  // 去重并且保证有尺寸；取图片实际资源（srcset/picture 场景 currentSrc 才是真正渲染出的那张）
  const filtered = images
    .map(img => ({
      src: img.currentSrc || img.src,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height
    }))
    .filter(item => item.src && item.width > 0 && item.height > 0)
    .filter((item, index, self) => index === self.findIndex(s => s.src === item.src));

  // 优先高分辨率
  filtered.sort((a, b) => (b.width * b.height) - (a.width * a.height));

  return filtered.map(item => item.src);
}

function isVisualHistoryUrl(url) {
  return typeof url === 'string' && /^(https?:|data:image\/)/i.test(url);
}

window.__hpScan = { collectPageImages, isVisualHistoryUrl };
})();
