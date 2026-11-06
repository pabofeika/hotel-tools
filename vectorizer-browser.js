/**
 * 浏览器端 Logo 矢量化管线（无需任何服务）
 *
 * v4 与原生引擎对齐的关键点：
 *   1. 背景判定：边框众数占比高、离差小 → 均匀底；否则用局部模糊差分
 *   2. 颜色核心：内部像素直方图 + 相近色合并，小面积强调色补救
 *   3. **抗锯齿覆盖率掩膜**：均匀底时不再按硬阈值切边，而是把每个像素到
 *      "背景→该颜色"的投影比例作为覆盖率（0..1），保留亚像素边缘
 *   4. **超采样描摹**：掩膜先双三次放大 2-6 倍（按图幅自适应），轻度高斯
 *      模糊后二值化，再交给 Potrace 拟合；细笔画和小字不会糊成一团
 *
 * 对外接口：window.ToolsVectorizer.vectorize(file, opts) → Promise<result>
 */
(function () {
  'use strict';

  var MAX_LOAD_DIM = 3600;  // 解码上限，避免超大图卡浏览器
  var MAX_LOAD_PIXELS = 6e6;
  var MAX_TRACE_PIXELS = 24e6; // 超采样后的像素上限（内存保护）

  // 与 vectorizer-kit 原生引擎一致的细节参数
  // 注意：opttolerance 不能大——容差大会把圆弧近似成直线段，放大后就是多边形边。
  // 去噪靠 sigma / threshold / median，曲线始终保持低容差拟合。
  var DETAILS = {
    fine:     { sigma: 0.24, alphamax: 1.00, opttolerance: 0.20, speck: 0.80, threshold: 128, target: 6000 },
    standard: { sigma: 0.50, alphamax: 1.20, opttolerance: 0.20, speck: 1.50, threshold: 136, target: 6000 },
    smooth:   { sigma: 0.80, alphamax: 1.30, opttolerance: 0.25, speck: 2.60, median: 1, threshold: 140, target: 6000 }
  };

  // 透明底：alpha 本身已是抗锯齿覆盖率，几乎不需要模糊；用更高描摹分辨率和更小容差
  var ALPHA_DETAILS = {
    fine:     { sigma: 0.10, alphamax: 0.20, opttolerance: 0.10, speck: 0.80, threshold: 128, target: 9000 },
    standard: { sigma: 0.15, alphamax: 0.30, opttolerance: 0.15, speck: 1.00, threshold: 127, target: 9000 },
    smooth:   { sigma: 0.50, alphamax: 0.80, opttolerance: 0.25, speck: 2.00, median: 1, threshold: 130, target: 6000 }
  };

  /* ───────────────── 解码 ───────────────── */

  function decodeFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      decodeUrl(url).then(function (r) {
        URL.revokeObjectURL(url);
        resolve(r);
      }).catch(function (e) {
        URL.revokeObjectURL(url);
        reject(e);
      });
    });
  }

  function decodeUrl(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var ow = img.naturalWidth, oh = img.naturalHeight;
        var s = Math.min(1, MAX_LOAD_DIM / Math.max(ow, oh), Math.sqrt(MAX_LOAD_PIXELS / (ow * oh)));
        var w = Math.max(1, Math.round(ow * s));
        var h = Math.max(1, Math.round(oh * s));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ w: w, h: h, ow: ow, oh: oh, id: ctx.getImageData(0, 0, w, h) });
      };
      img.onerror = function () { reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  /* ───────────────── 背景估计 ───────────────── */

  function estimateBackground(id) {
    var w = id.width, h = id.height, d = id.data;
    var strip = Math.max(1, Math.round(Math.min(w, h) * 0.02));
    var hist = new Map();
    function push(x, y) {
      var p = (y * w + x) * 4;
      if (d[p + 3] < 10) return;
      var key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
      var e = hist.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; hist.set(key, e); }
      e.n++; e.r += d[p]; e.g += d[p + 1]; e.b += d[p + 2];
    }
    for (var x = 0; x < w; x++) { for (var y = 0; y < strip; y++) { push(x, y); push(x, h - 1 - y); } }
    for (var y2 = 0; y2 < h; y2++) { for (var x2 = 0; x2 < strip; x2++) { push(x2, y2); push(w - 1 - x2, y2); } }
    if (!hist.size) return null;

    var best = null, total = 0;
    hist.forEach(function (e) { total += e.n; if (!best || e.n > best.n) best = e; });
    var col = [best.r / best.n, best.g / best.n, best.b / best.n];
    var dev = 0;
    hist.forEach(function (e) {
      var c = [e.r / e.n, e.g / e.n, e.b / e.n];
      dev += (Math.abs(c[0] - col[0]) + Math.abs(c[1] - col[1]) + Math.abs(c[2] - col[2])) / 3 * e.n;
    });
    return {
      color: col.map(Math.round),
      spread: (dev / Math.max(1, total)) / 255 * 100,
      ratio: best.n / total
    };
  }

  /* ───────────────── 局部背景（强模糊近似） ───────────────── */

  function boxBlurRGB(id, radius) {
    var w = id.width, h = id.height, src = id.data;
    var tmp = new Float32Array(w * h * 3);
    var out = new Float32Array(w * h * 3);
    var r = Math.max(1, radius | 0);
    var i, x, y, c, sum, n;

    for (y = 0; y < h; y++) {
      for (c = 0; c < 3; c++) {
        sum = 0; n = 0;
        for (x = -r; x <= r; x++) {
          var xx = Math.min(w - 1, Math.max(0, x));
          sum += src[(y * w + xx) * 4 + c]; n++;
        }
        for (x = 0; x < w; x++) {
          tmp[(y * w + x) * 3 + c] = sum / n;
          var addX = Math.min(w - 1, x + r + 1);
          var remX = Math.max(0, x - r);
          sum += src[(y * w + addX) * 4 + c] - src[(y * w + remX) * 4 + c];
        }
      }
    }
    for (x = 0; x < w; x++) {
      for (c = 0; c < 3; c++) {
        sum = 0; n = 0;
        for (y = -r; y <= r; y++) {
          var yy = Math.min(h - 1, Math.max(0, y));
          sum += tmp[(yy * w + x) * 3 + c]; n++;
        }
        for (y = 0; y < h; y++) {
          out[(y * w + x) * 3 + c] = sum / n;
          var addY = Math.min(h - 1, y + r + 1);
          var remY = Math.max(0, y - r);
          sum += tmp[(addY * w + x) * 3 + c] - tmp[(remY * w + x) * 3 + c];
        }
      }
    }
    return out;
  }

  /* ───────────────── 前景（ink）判定 ───────────────── */

  function buildInk(id, opts, bg) {
    var w = id.width, h = id.height, d = id.data;
    bg = bg || estimateBackground(id);
    var ink = new Uint8Array(w * h);
    var mode = 'border';
    var tol = 30;

    // 均匀底：边框众数占比高且离差小（8% 以内仍视为纯色底，
    // 允许 logo 有一小部分贴边，否则会退化成整图分层、SVG 体积暴涨）
    var uniform = bg && bg.ratio >= 0.45 && bg.spread <= 8.0;

    // 透明底（PNG/WebP）：边框大部分是 alpha=0。此时 alpha 通道就是现成的
    // 抗锯齿覆盖率，直接用 alpha 描摹，不能再二值化，否则字会变粗。
    var borderTotal = 0, borderClear = 0;
    for (var bx = 0; bx < w; bx++) {
      for (var by = 0; by < Math.min(3, h); by++) {
        borderTotal += 2;
        if (d[(by * w + bx) * 4 + 3] < 10) borderClear++;
        if (d[((h - 1 - by) * w + bx) * 4 + 3] < 10) borderClear++;
      }
    }
    for (var by2 = 0; by2 < h; by2++) {
      for (var bx2 = 0; bx2 < Math.min(3, w); bx2++) {
        borderTotal += 2;
        if (d[(by2 * w + bx2) * 4 + 3] < 10) borderClear++;
        if (d[(by2 * w + (w - 1 - bx2)) * 4 + 3] < 10) borderClear++;
      }
    }
    var alphaBg = borderTotal > 0 && borderClear / borderTotal > 0.5;
    if (alphaBg) {
      for (var ia = 0; ia < w * h; ia++) if (d[ia * 4 + 3] >= 12) ink[ia] = 1;
      return { ink: ink, bg: null, mode: 'alpha', uniform: false, alphaBg: true };
    }

    // 保留背景 + 非均匀底（渐变/照片）：整张图都要参与分层，否则会丢背景
    if (!opts.removeBg && !uniform) {
      for (var i0 = 0; i0 < w * h; i0++) if (d[i0 * 4 + 3] >= 12) ink[i0] = 1;
      return { ink: ink, bg: bg, mode: 'keep-all', uniform: false, alphaBg: false };
    }

    if (uniform) {
      for (var i = 0; i < w * h; i++) {
        var p = i * 4;
        if (d[p + 3] < 12) continue;
        var dist = Math.max(
          Math.abs(d[p] - bg.color[0]),
          Math.abs(d[p + 1] - bg.color[1]),
          Math.abs(d[p + 2] - bg.color[2])
        );
        if (dist > tol) ink[i] = 1;
      }
    } else {
      // 渐变 / 复杂底：用局部背景差分
      mode = 'local-blur';
      var radius = Math.max(6, Math.round(Math.min(w, h) * 0.04));
      var blur = boxBlurRGB(id, radius);
      var threshold = 26;
      for (var j = 0; j < w * h; j++) {
        var q = j * 4;
        if (d[q + 3] < 12) continue;
        var diff = Math.max(
          Math.abs(d[q] - blur[j * 3]),
          Math.abs(d[q + 1] - blur[j * 3 + 1]),
          Math.abs(d[q + 2] - blur[j * 3 + 2])
        );
        if (diff > threshold) ink[j] = 1;
      }

      // 极端情况（比如整体是渐变、没有明显图形）：按亮度/色度再兜一层
      var count = 0;
      for (var k = 0; k < w * h; k++) if (ink[k]) count++;
      if (count < w * h * 0.002) {
        mode = 'local-blur+fallback';
        for (var m = 0; m < w * h; m++) {
          var pm = m * 4;
          if (d[pm + 3] < 12) continue;
          var dist2 = Math.max(
            Math.abs(d[pm] - blur[m * 3]),
            Math.abs(d[pm + 1] - blur[m * 3 + 1]),
            Math.abs(d[pm + 2] - blur[m * 3 + 2])
          );
          if (dist2 > 12) ink[m] = 1;
        }
      }
    }

    return { ink: ink, bg: bg, mode: mode, uniform: uniform, alphaBg: false };
  }

  /* ───────────────── 颜色核心 ───────────────── */

  function rgb2hsv(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var v = max, s = max === 0 ? 0 : (max - min) / max;
    var h = 0, d = max - min;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: s, v: v };
  }

  // 与原生引擎 _is_similar 一致：同色系的明暗差（含 JPEG 压缩灰边）合并成一层
  function similarColor(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) < 26) return true;
    var x = rgb2hsv(a), y = rgb2hsv(b);
    if (x.s < 0.16 && y.s < 0.16) return Math.abs(x.v - y.v) < 0.24;
    var dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
    return dh < 14 && Math.abs(x.s - y.s) < 0.36 && Math.abs(x.v - y.v) < 0.24;
  }

  // 判断颜色 c 是否是"背景 bg ↔ 实色 strong"之间的抗锯齿过渡色
  function isBlendOf(c, bg, strong) {
    var vr = strong[0] - bg[0], vg = strong[1] - bg[1], vb = strong[2] - bg[2];
    var denom = vr * vr + vg * vg + vb * vb;
    if (denom < 400) return false;
    var wr = c[0] - bg[0], wg = c[1] - bg[1], wb = c[2] - bg[2];
    var t = (wr * vr + wg * vg + wb * vb) / denom;
    if (t <= 0.12 || t >= 0.9) return false;
    var pr = bg[0] + vr * t, pg = bg[1] + vg * t, pb = bg[2] + vb * t;
    var off = Math.sqrt(
      Math.pow(c[0] - pr, 2) + Math.pow(c[1] - pg, 2) + Math.pow(c[2] - pb, 2)
    );
    return off < 36;
  }

  function extractCores(id, ink, requestK, strict, bgColor) {
    var w = id.width, h = id.height, d = id.data;
    // 均匀底时用 2px 腐蚀取"实心内部"：抗锯齿灰边只有 1-2px，会被剔除，
    // 避免白色文字旁边多出一层灰色描边（原图上的实心灰色文字不受影响）。
    var r = strict ? 2 : 1;
    var inner = [];
    for (var y = r; y < h - r; y++) {
      for (var x = r; x < w - r; x++) {
        var i = y * w + x;
        if (!ink[i]) continue;
        if (!ink[i - r] || !ink[i + r] || !ink[i - r * w] || !ink[i + r * w]) continue;
        inner.push(i);
      }
    }
    // 细线条太细时退回全部前景像素
    if (inner.length < 300) {
      inner = [];
      for (var j = 0; j < w * h; j++) if (ink[j]) inner.push(j);
    }
    if (!inner.length) return [];

    var hist = new Map();
    for (var n = 0; n < inner.length; n++) {
      var p = inner[n] * 4;
      var key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
      var e = hist.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; hist.set(key, e); }
      e.n++; e.r += d[p]; e.g += d[p + 1]; e.b += d[p + 2];
    }
    var buckets = [];
    hist.forEach(function (e) { buckets.push({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] }); });
    buckets.sort(function (a, b) { return b.n - a.n; });
    if (buckets.length > 500) buckets = buckets.slice(0, 500);

    var cores = [];
    for (var bi = 0; bi < buckets.length; bi++) {
      var b = buckets[bi], hit = -1;
      for (var ci = 0; ci < cores.length; ci++) {
        var c = cores[ci];
        var same;
        if (strict) {
          // 纯色底：同色系明暗差是抗锯齿灰边，合并成一层
          same = similarColor(b.c, c.c);
        } else {
          // 渐变/照片底：保留层次，避免把渐变合并成色块
          var dr0 = b.c[0] - c.c[0], dg0 = b.c[1] - c.c[1], db0 = b.c[2] - c.c[2];
          same = Math.sqrt(dr0 * dr0 + dg0 * dg0 + db0 * db0) < 42;
        }
        if (same) { hit = ci; break; }
      }
      if (hit >= 0) {
        var c2 = cores[hit], total = c2.n + b.n;
        c2.c = [
          (c2.c[0] * c2.n + b.c[0] * b.n) / total,
          (c2.c[1] * c2.n + b.c[1] * b.n) / total,
          (c2.c[2] * c2.n + b.c[2] * b.n) / total
        ];
        c2.n = total;
      } else {
        cores.push({ n: b.n, c: b.c.slice() });
      }
      if (cores.length >= 16) break;
    }
    cores.sort(function (a, b) { return b.n - a.n; });

    var totalInk = inner.length;
    if (requestK === 'auto') {
      // 主色门槛：均匀底要求 3%（实心色），抗锯齿灰边通常 <2%，会被剔除；
      // 非均匀底（渐变/照片）保持 1.2%，避免丢失小色块。
      var minShare = strict ? 0.03 : 0.012;
      var keep = cores.filter(function (c) { return c.n >= totalInk * minShare; });
      if (!keep.length) keep = [cores[0]];

      // 补救：面积小但颜色明显不同（例如小面积强调色）也保留
      // 门槛随图幅自适应，避免把抗锯齿杂边当成"强调色"多描一层
      var DISTINCT = 110, MIN_ABS = 200;
      var rescueMin = Math.max(MIN_ABS, totalInk * 0.004);
      for (var ri = 0; ri < cores.length; ri++) {
        var cand = cores[ri];
        if (keep.indexOf(cand) >= 0) continue;
        if (cand.n < rescueMin) continue;
        // 背景与实色之间的过渡色（AA 灰边）不抢救；非均匀底的"背景色"不可靠，不做此判断
        if (strict && bgColor && keep.some(function (k3) {
          return isBlendOf(cand.c, bgColor, k3.c);
        })) continue;
        var far = keep.every(function (k2) {
          var dd = Math.sqrt(
            Math.pow(cand.c[0] - k2.c[0], 2) +
            Math.pow(cand.c[1] - k2.c[1], 2) +
            Math.pow(cand.c[2] - k2.c[2], 2)
          );
          return dd > DISTINCT;
        });
        if (far) keep.push(cand);
        if (keep.length >= 6) break;
      }
      cores = keep.slice(0, 6);
    } else {
      cores = cores.slice(0, Math.max(1, Math.min(8, requestK)));
    }
    return cores;
  }

  /* ───────────────── 工具 ───────────────── */

  function hexOf(c) {
    return '#' + c.map(function (v) {
      return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
    }).join('').toUpperCase();
  }

  function extractPathD(svg) {
    var m = svg.match(/<path d="([^"]*)"/);
    return m ? m[1] : '';
  }

  function traceScaleFor(w, h, target) {
    var want = Math.round((target || 6000) / Math.max(w, h));
    want = Math.max(2, Math.min(6, want));
    while (want > 1 && w * want * h * want > MAX_TRACE_PIXELS) want--;
    return want;
  }

  function medianMask(canvas, radius) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var id = ctx.getImageData(0, 0, w, h), d = id.data;
    var out = new Uint8ClampedArray(d.length);
    var r = radius, size = (2 * r + 1) * (2 * r + 1);
    var win = new Uint8Array(size);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
            win[k++] = d[(yy * w + xx) * 4];
          }
        }
        for (var i = 1; i < size; i++) {
          var v = win[i], j = i - 1;
          while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; }
          win[j + 1] = v;
        }
        var m = win[size >> 1];
        var p = (y * w + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = m; out[p + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
    return canvas;
  }

  function scalePath(d, k) {
    return d.replace(/-?\d+(?:\.\d+)?/g, function (n) {
      return (parseFloat(n) * k).toFixed(3).replace(/\.?0+$/, '');
    });
  }

  function traceMask(maskCanvas, scale, detail, onProgress) {
    if (detail.median) maskCanvas = medianMask(maskCanvas, detail.median);
    return new Promise(function (resolve) {
      var W = maskCanvas.width * scale, H = maskCanvas.height * scale;
      var big = document.createElement('canvas');
      big.width = W; big.height = H;
      var bctx = big.getContext('2d', { willReadFrequently: true });
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
      // 先双三次放大，再按比例做高斯模糊：等价于原生引擎的 resize + GaussianBlur
      bctx.filter = 'blur(' + (detail.sigma * scale).toFixed(2) + 'px)';
      bctx.drawImage(maskCanvas, 0, 0, W, H);
      bctx.filter = 'none';

      var bid = bctx.getImageData(0, 0, W, H);
      var bd = bid.data;
      for (var i = 0; i < bd.length; i += 4) {
        var lum = 0.2126 * bd[i] + 0.7153 * bd[i + 1] + 0.0721 * bd[i + 2];
        bd[i] = bd[i + 1] = bd[i + 2] = lum < (detail.threshold || 128) ? 0 : 255;
        bd[i + 3] = 255;
      }
      bctx.putImageData(bid, 0, 0);

      Potrace.setParameter({
        turnpolicy: 'minority',
        turdsize: Math.max(2, Math.round(detail.speck * scale * scale)),
        optcurve: true,
        alphamax: detail.alphamax,
        opttolerance: detail.opttolerance
      });
      Potrace.loadImageFromUrl(big.toDataURL());
      Potrace.process(function () {
        resolve(extractPathD(Potrace.getSVG(1)));
      });
    });
  }

  /* ───────────────── 掩膜 ───────────────── */

  // 均匀底：用"背景→颜色"的投影比例作为抗锯齿覆盖率
  function softMask(id, labels, layerIndex, core, bg, w, h) {
    var d = id.data;
    var vr = core.c[0] - bg.color[0];
    var vg = core.c[1] - bg.color[1];
    var vb = core.c[2] - bg.color[2];
    var denom = vr * vr + vg * vg + vb * vb;
    var mc = document.createElement('canvas');
    mc.width = w; mc.height = h;
    var ctx = mc.getContext('2d', { willReadFrequently: true });
    var mid = ctx.createImageData(w, h);
    var md = mid.data;
    for (var i = 0; i < w * h; i++) {
      var p = i * 4;
      var a = 0;
      if (labels[i] === layerIndex) {
        if (denom > 400) {
          var dot = (d[p] - bg.color[0]) * vr + (d[p + 1] - bg.color[1]) * vg + (d[p + 2] - bg.color[2]) * vb;
          a = dot / denom;
          a = a < 0 ? 0 : (a > 1 ? 1 : a);
        } else {
          var dr = d[p] - core.c[0], dg = d[p + 1] - core.c[1], db = d[p + 2] - core.c[2];
          a = (dr * dr + dg * dg + db * db) < 1600 ? 1 : 0;
        }
      }
      // 覆盖率越高 → 越黑（Potrace 把深色当墨）
      md[p] = md[p + 1] = md[p + 2] = Math.round(255 - a * 255);
      md[p + 3] = 255;
    }
    ctx.putImageData(mid, 0, 0);
    return mc;
  }

  // 透明底：alpha 即覆盖率（白=墨）
  function alphaMask(id, labels, layerIndex, w, h) {
    var d = id.data;
    var mc = document.createElement('canvas');
    mc.width = w; mc.height = h;
    var ctx = mc.getContext('2d', { willReadFrequently: true });
    var mid = ctx.createImageData(w, h);
    var md = mid.data;
    for (var i = 0; i < w * h; i++) {
      var p = i * 4;
      var a = (labels[i] === layerIndex) ? d[p + 3] / 255 : 0;
      md[p] = md[p + 1] = md[p + 2] = Math.round(255 - a * 255);
      md[p + 3] = 255;
    }
    ctx.putImageData(mid, 0, 0);
    return mc;
  }

  function binaryMask(labels, layerIndex, w, h) {
    var mc = document.createElement('canvas');
    mc.width = w; mc.height = h;
    var ctx = mc.getContext('2d', { willReadFrequently: true });
    var mid = ctx.createImageData(w, h);
    var md = mid.data;
    for (var i = 0; i < w * h; i++) {
      var on = labels[i] === layerIndex;
      var p = i * 4;
      md[p] = md[p + 1] = md[p + 2] = on ? 0 : 255;
      md[p + 3] = 255;
    }
    ctx.putImageData(mid, 0, 0);
    return mc;
  }

  /* ───────────────── 主流程 ───────────────── */

  function vectorizeFile(file, options) {
    var opts = Object.assign({
      colors: 'auto',
      background: 'auto',
      detail: 'standard'
    }, options || {});
    var detail = DETAILS[opts.detail] || DETAILS.standard;

    var debug = { steps: [] };

    return decodeFile(file).then(function (img) {
      var w = img.w, h = img.h, d = img.id.data;
      var t0 = Date.now();

      var bg0 = estimateBackground(img.id);

      // 自动：只有"近白且均匀"的底才抠掉（扫描件/白底 logo 的常见情况）。
      // 深色、彩色、渐变的底一律保留，否则结果会与原图观感差很多。
      if (opts.background === 'auto') {
        var lum = bg0 ? 0.2126 * bg0.color[0] + 0.7153 * bg0.color[1] + 0.0721 * bg0.color[2] : 0;
        opts.removeBg = !!(bg0 && bg0.ratio >= 0.45 && bg0.spread <= 4.0 && lum >= 200);
      } else {
        opts.removeBg = opts.background !== 'keep';
      }
      debug.autoRemoveBg = opts.removeBg;

      var built = buildInk(img.id, opts, bg0);
      var ink = built.ink;
      debug.bg = built.bg;
      debug.inkMode = built.mode;

      var inkCount = 0;
      for (var i = 0; i < w * h; i++) if (ink[i]) inkCount++;
      debug.inkPixels = inkCount;
      debug.inkRatio = +(inkCount / (w * h) * 100).toFixed(2);

      if (inkCount < 10) throw new Error('没有可描摹的前景像素（图片可能整张都是背景色）');

      var cores = extractCores(img.id, ink, opts.colors, built.uniform, built.bg ? built.bg.color : null);
      debug.coreCount = cores.length;
      debug.cores = cores.map(function (c) { return { hex: hexOf(c.c), pixels: c.n }; });
      if (!cores.length) throw new Error('没有可描摹的前景像素');

      // 逐像素归属最近核心
      var labels = new Int32Array(w * h).fill(-1);
      var counts = new Array(cores.length).fill(0);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          if (!ink[idx]) continue;
          var p = idx * 4;
          var best = 0, bd = Infinity;
          for (var ci = 0; ci < cores.length; ci++) {
            var dr = d[p] - cores[ci].c[0];
            var dg = d[p + 1] - cores[ci].c[1];
            var db = d[p + 2] - cores[ci].c[2];
            var dd = dr * dr + dg * dg + db * db;
            if (dd < bd) { bd = dd; best = ci; }
          }
          labels[idx] = best;
          counts[best]++;
        }
      }

      var order = [];
      for (var oi = 0; oi < cores.length; oi++) {
        if (counts[oi] > 0) order.push({ i: oi, c: cores[oi].c, n: counts[oi] });
      }
      order.sort(function (a, b) { return b.n - a.n; });
      debug.layerCount = order.length;
      debug.layers = order.map(function (o) { return { hex: hexOf(o.c), pixels: o.n }; });

      var activeDetail = built.alphaBg
        ? (ALPHA_DETAILS[opts.detail] || ALPHA_DETAILS.standard)
        : detail;
      var scale = traceScaleFor(w, h, activeDetail.target || 6000);
      debug.scale = scale;
      debug.softMask = built.uniform;

      var paths = '';
      var k = 0;
      return new Promise(function (resolve, reject) {
        function nextLayer() {
          if (k >= order.length) return finish();
          var o = order[k++];
          if (opts.onLayer) opts.onLayer(k, order.length);

          var mask = built.alphaBg
            ? alphaMask(img.id, labels, o.i, w, h)
            : (built.uniform
              ? softMask(img.id, labels, o.i, cores[o.i], built.bg, w, h)
              : binaryMask(labels, o.i, w, h));
          var layerDetail = built.alphaBg ? activeDetail : detail;

          traceMask(mask, scale, layerDetail).then(function (dd) {
            if (dd) paths += '<path fill="' + hexOf(o.c) + '" fill-rule="evenodd" d="'
              + scalePath(dd, img.ow / (w * scale)) + '"/>';
            nextLayer();
          }).catch(reject);
        }

        function finish() {
          // 路径坐标已换算到原图像素；width/height/viewBox 一致，无 transform
          var rect2 = '';
          if (!opts.removeBg && built.uniform && built.bg) {
            rect2 = '<rect width="' + img.ow + '" height="' + img.oh
              + '" fill="' + hexOf(built.bg.color) + '"/>';
          }
          var svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<svg xmlns="http://www.w3.org/2000/svg" width="' + img.ow + '" height="' + img.oh
            + '" viewBox="0 0 ' + img.ow + ' ' + img.oh + '" role="img">'
            + '<title>矢量 logo</title><desc>hotel-tools vectorizer v11 · browser · ' + opts.detail + '</desc>'
            + rect2 + paths + '</svg>';
          debug.elapsed = +((Date.now() - t0) / 1000).toFixed(2);
          debug.originalSize = [img.ow, img.oh];
          debug.workingSize = [w, h];
          resolve({
            svg: svg,
            width: img.ow,
            height: img.oh,
            scale: scale,
            colors: order.map(function (o) { return { hex: hexOf(o.c), pixels: o.n }; }),
            background: built.bg ? hexOf(built.bg.color) : null,
            background_removed: opts.removeBg,
            background_spread: built.bg ? +built.bg.spread.toFixed(2) : 0,
            engine: 'browser',
            version: '11',
            detail: opts.detail,
            debug: debug
          });
        }

        nextLayer();
      });
    });
  }

  /* ───────────────── 对外接口 ───────────────── */

  // 供"本地原生引擎"复用自动背景判定：auto → 明确返回 remove / keep
  function resolveBackground(file) {
    return decodeFile(file).then(function (img) {
      var bg = estimateBackground(img.id);
      var lum = bg ? 0.2126 * bg.color[0] + 0.7153 * bg.color[1] + 0.0721 * bg.color[2] : 0;
      var removeBg = !!(bg && bg.ratio >= 0.45 && bg.spread <= 4.0 && lum >= 200);
      return {
        background: removeBg ? 'remove' : 'keep',
        removeBg: removeBg,
        color: bg ? hexOf(bg.color) : null,
        spread: bg ? +bg.spread.toFixed(2) : 0,
        ratio: bg ? +bg.ratio.toFixed(2) : 0
      };
    });
  }

  window.ToolsVectorizer = {
    vectorize: vectorizeFile,
    resolveBackground: resolveBackground,
    version: '11'
  };
})();
