/**
 * 浏览器端 Logo 矢量化管线（无需任何服务）
 *
 * 设计要点（对应实测问题）：
 *   1. 背景估计分两条路：
 *      - 均匀底（边框众数占比高、离差小）→ 用边框众数色 + 容差
 *      - 渐变/照片底（离差大）→ 用**局部背景**（强模糊后近似）做差分，避免整张图被判成背景而塌掉
 *   2. 颜色核心：内部像素直方图 + 相近色合并，阈值按占比自适应，避免小面积文字被丢掉
 *   3. 逐色掩膜 → 轻度模糊重二值化去锯齿 → potrace 拟合
 *
 * 对外接口：window.ToolsVectorizer.vectorize(file, opts) → Promise<result>
 */
(function () {
  'use strict';

  var BOX_WHITE = 238;      // 判定"底图白框"用的白阈值
  var MERGE_DIST = 42;      // 相近色合并距离
  var MAX_LOAD_DIM = 1600;  // 解码上限，避免超大图卡浏览器

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
        var s = Math.min(1, MAX_LOAD_DIM / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * s));
        var h = Math.max(1, Math.round(img.naturalHeight * s));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ w: w, h: h, id: ctx.getImageData(0, 0, w, h) });
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

    // 水平
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
    // 垂直
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

    // 均匀底：边框众数占比高且离差小
    var uniform = bg && bg.ratio >= 0.45 && bg.spread <= 4.0;
    if (!opts.removeBg) {
      // 保留背景：全部非透明像素都算前景
      for (var i0 = 0; i0 < w * h; i0++) if (d[i0 * 4 + 3] >= 12) ink[i0] = 1;
      return { ink: ink, bg: bg, mode: 'keep-all', bgTest: null };
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

    return { ink: ink, bg: bg, mode: mode, bgTest: null };
  }

  /* ───────────────── 颜色核心 ───────────────── */

  function extractCores(id, ink, requestK, opts) {
    var w = id.width, h = id.height, d = id.data;
    var inner = [];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        if (!ink[i]) continue;
        if (!ink[i - 1] || !ink[i + 1] || !ink[i - w] || !ink[i + w]) continue;
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
        var dist = Math.sqrt(
          Math.pow(b.c[0] - c.c[0], 2) + Math.pow(b.c[1] - c.c[1], 2) + Math.pow(b.c[2] - c.c[2], 2)
        );
        if (dist < MERGE_DIST) { hit = ci; break; }
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
      // 主色：占比 >= 1.2%（实测与原生引擎的分层结果最接近，避免深浅色被拆成多层）
      var minShare = 0.012;
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

  function traceMask(maskCanvas) {
    return new Promise(function (resolve) {
      Potrace.setParameter({
        turnpolicy: 'minority',
        turdsize: 2,
        optcurve: true,
        alphamax: 1,
        opttolerance: 0.2
      });
      Potrace.loadImageFromUrl(maskCanvas.toDataURL());
      Potrace.process(function () { resolve(extractPathD(Potrace.getSVG(1))); });
    });
  }

  /* ───────────────── 主流程 ───────────────── */

  function vectorizeFile(file, options) {
    var opts = Object.assign({
      colors: 'auto',
      background: 'auto',
      detail: 'standard'
    }, options || {});

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

      var cores = extractCores(img.id, ink, opts.colors, opts);
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

      var blur = opts.detail === 'fine' ? 0 : (opts.detail === 'smooth' ? 1.4 : 0.75);

      var paths = '';
      var k = 0;
      return new Promise(function (resolve, reject) {
        function nextLayer() {
          if (k >= order.length) return finish();
          var o = order[k++];
          if (opts.onLayer) opts.onLayer(k, order.length);

          var mc = document.createElement('canvas');
          mc.width = w; mc.height = h;
          var mctx = mc.getContext('2d', { willReadFrequently: true });
          var mid = mctx.createImageData(w, h);
          var md = mid.data;
          for (var j = 0; j < w * h; j++) {
            var on = labels[j] === o.i;
            var pj = j * 4;
            md[pj] = md[pj + 1] = md[pj + 2] = on ? 0 : 255;
            md[pj + 3] = 255;
          }
          mctx.putImageData(mid, 0, 0);

          if (blur > 0) {
            var sc = document.createElement('canvas');
            sc.width = w; sc.height = h;
            var sctx = sc.getContext('2d', { willReadFrequently: true });
            sctx.filter = 'blur(' + blur + 'px)';
            sctx.drawImage(mc, 0, 0);
            sctx.filter = 'none';
            var sid = sctx.getImageData(0, 0, w, h);
            var sd = sid.data;
            for (var q = 0; q < w * h; q++) {
              var pq = q * 4;
              var lum = 0.2126 * sd[pq] + 0.7153 * sd[pq + 1] + 0.0721 * sd[pq + 2];
              var on2 = lum < 200;
              sd[pq] = sd[pq + 1] = sd[pq + 2] = on2 ? 0 : 255;
              sd[pq + 3] = 255;
            }
            sctx.putImageData(sid, 0, 0);
            mctx.clearRect(0, 0, w, h);
            mctx.drawImage(sc, 0, 0);
          }

          traceMask(mc).then(function (dd) {
            if (dd) paths += '<path fill="' + hexOf(o.c) + '" fill-rule="evenodd" d="' + dd + '"/>';
            nextLayer();
          }).catch(reject);
        }

        function finish() {
          var svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h
            + '" viewBox="0 0 ' + w + ' ' + h + '" role="img"><title>矢量 logo</title>'
            + paths + '</svg>';
          debug.elapsed = +((Date.now() - t0) / 1000).toFixed(2);
          resolve({
            svg: svg,
            width: w,
            height: h,
            scale: 1,
            colors: order.map(function (o) { return { hex: hexOf(o.c), pixels: o.n }; }),
            background: built.bg ? hexOf(built.bg.color) : null,
            background_removed: opts.removeBg,
            background_spread: built.bg ? +built.bg.spread.toFixed(2) : 0,
            engine: 'browser',
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
    version: '3'
  };
})();
