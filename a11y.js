/* 可访问性补强：给没有显式 label 的控件补 aria-label。
   只在找不到任何可读名称时补，不改变页面结构或视觉。 */
(function () {
  'use strict';

  function visible(el) {
    return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  }

  function text(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function findName(el) {
    if (el.labels && el.labels.length) {
      var l = text(el.labels[0]);
      if (l) return l;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) return '';

    var box = el.closest('.field, .form-group, .control, .range-field');
    if (box) {
      var lab = box.querySelector('label');
      if (lab && text(lab)) return text(lab);
      var rl = box.querySelector('.rl span, .range-label span');
      if (rl && text(rl)) return text(rl);
      var title = box.querySelector('.section-title');
      if (title && text(title)) return text(title);
    }

    var prev = el.previousElementSibling;
    while (prev) {
      if (prev.tagName === 'LABEL' && text(prev)) return text(prev);
      if (prev.classList && (prev.classList.contains('rl') || prev.classList.contains('range-label'))) {
        var sp = prev.querySelector('span');
        if (sp && text(sp)) return text(sp);
      }
      prev = prev.previousElementSibling;
    }

    var near = el.parentElement;
    if (near) {
      var rl2 = near.querySelector('.rl span, .range-label span');
      if (rl2 && text(rl2)) return text(rl2);
    }

    return el.getAttribute('placeholder') || el.getAttribute('title') || '';
  }

  function apply(root) {
    var nodes = root.querySelectorAll('input:not([type="hidden"]), select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.type === 'file' || el.disabled || !visible(el)) continue;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
      if (el.labels && el.labels.length) continue;
      var name = findName(el);
      if (name) el.setAttribute('aria-label', name);
    }
    var toast = document.getElementById('toast');
    if (toast && !toast.getAttribute('aria-live')) toast.setAttribute('aria-live', 'polite');
  }

  function boot() {
    apply(document);
    if (!window.MutationObserver) return;
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        apply(document);
      }, 80);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
