const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream');

const PORT           = 8765;
const DIR             = path.resolve(path.join(__dirname, 'deploy'));
const FFMPEG          = path.join(__dirname, 'ffmpeg_bin', 'ffmpeg');
const VECTORIZER_DIR  = path.join(__dirname, 'vectorizer-kit');
const VECTORIZER_CLI  = path.join(VECTORIZER_DIR, 'cli.py');
const MAX_BODY_SIZE   = 512 * 1024 * 1024; // 512MB max upload
const FFMPEG_TIMEOUT  = 300000;            // 5 minutes
const MAX_DURATION    = 45;                // max segment seconds (matches frontend)
const VECTOR_MAX_BODY = 25 * 1024 * 1024;  // 25MB (vectorizer limit)
const VECTOR_TIMEOUT  = 120000;            // 2 minutes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.ttf':  'font/ttf',
  '.ts':   'video/mp2t',
  '.mp4':  'video/mp4',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ── Security helpers ────────────────────────────────────────────────────

function generateTempName(prefix, ext) {
  const rand = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}_${rand}${ext}`);
}

function safeUnlink(filepath, label) {
  if (!filepath) return;
  fs.unlink(filepath, function(err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`[cleanup] failed to remove ${label}:`, err.message);
    }
  });
}

function validateResolution(val) {
  // Must match WIDTHxHEIGHT with positive integers
  if (!/^\d{3,4}x\d{3,4}$/.test(val)) return null;
  const [w, h] = val.split('x').map(Number);
  if (w < 320 || w > 7680 || h < 240 || h > 4320) return null;
  return val;
}

function validateCrf(val) {
  // CRF: 0-51, sane range for libx264 is 18-28
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0 || n > 51) return null;
  return String(n);
}

function validateFps(val) {
  if (!val) return ''; // empty = original
  const n = parseFloat(val);
  if (isNaN(n) || n <= 0 || n > 120) return null;
  return String(n);
}

function validateDuration(val) {
  if (!val) return null;
  const n = parseFloat(val);
  if (isNaN(n) || n <= 0 || n > MAX_DURATION) return null;
  return n;
}

function validateStart(val) {
  const n = parseFloat(val);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

// ── Static file serving ─────────────────────────────────────────────────

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  // Normalize to remove dot segments, then prefix with '.' to ensure
  // relative resolution — prevents absolute-path bypass of DIR prefix
  const safePath = path.normalize(urlPath === '/' ? '/tools-hub.html' : urlPath);
  // Prepend '.' to force relative resolution (prevents /absolute bypass)
  const fp = path.resolve(DIR, '.' + safePath);

  // Ensure resolved path is within DIR (prevent directory traversal)
  if (!fp.startsWith(DIR + path.sep) && fp !== DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fp).toLowerCase();

  fs.readFile(fp, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, Object.assign(
      { 'Content-Type': MIME[ext] || 'application/octet-stream' },
      CORS_HEADERS
    ));
    res.end(data);
  });
}

// ── POST /api/convert ───────────────────────────────────────────────────

function handleConvert(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  // ── Parse & validate params ──
  const start      = validateStart(url.searchParams.get('start') || '0');
  const end        = validateDuration(url.searchParams.get('end'));
  const duration   = validateDuration(url.searchParams.get('duration'));
  const resolution = validateResolution(url.searchParams.get('resolution') || '1920x1080');
  const crf        = validateCrf(url.searchParams.get('crf') || '23');
  const fps        = validateFps(url.searchParams.get('fps') || '');

  if (!resolution) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid resolution. Must be WIDTHxHEIGHT (320-7680 x 240-4320).' }));
    return;
  }
  if (!crf) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid CRF. Must be 0-51.' }));
    return;
  }
  if (fps === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid FPS. Must be positive number ≤ 120.' }));
    return;
  }

  // Check Content-Length
  const contentLength = parseInt(req.headers['content-length'], 10);
  if (contentLength && contentLength > MAX_BODY_SIZE) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File too large. Maximum size is 512MB.' }));
    return;
  }

  // ── Write incoming binary to temp file ──
  const tmpIn  = generateTempName('hotel_input', '.mp4');
  const tmpOut = generateTempName('hotel_output', '.ts');
  let bodySize = 0;

  // Track body size to enforce limit (especially when no Content-Length)
  req.on('data', function(chunk) {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File too large. Maximum size is 512MB.' }));
      // Clean up partial file
      safeUnlink(tmpIn, 'tmpIn (oversize)');
      safeUnlink(tmpOut, 'tmpOut (oversize)');
    }
  });

  const ws = fs.createWriteStream(tmpIn);

  pipeline(req, ws, function(err) {
    if (err) {
      safeUnlink(tmpIn, 'tmpIn (upload error)');
      safeUnlink(tmpOut, 'tmpOut (upload error)');
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Upload failed');
      }
      return;
    }

    // ── Build FFmpeg args ──
    const args = ['-y', '-i', tmpIn];

    // Trim
    if (start > 0) args.push('-ss', start.toFixed(2));

    // Duration or end
    if (duration) {
      args.push('-t', duration.toFixed(2));
    } else if (end) {
      const dur = end - start;
      if (dur > 0) args.push('-t', dur.toFixed(2));
    }

    // Video codec H.264
    args.push('-c:v', 'libx264', '-preset', 'fast');
    args.push('-crf', crf);

    // Resolution
    args.push('-vf', 'scale=' + resolution);

    // Frame rate
    if (fps) args.push('-r', fps);

    // Audio
    args.push('-c:a', 'aac', '-b:a', '128k');

    // Output format
    args.push('-f', 'mpegts', tmpOut);

    execFile(FFMPEG, args, { timeout: FFMPEG_TIMEOUT }, function(err2, stdout, stderr) {
      // Clean up input temp file immediately
      safeUnlink(tmpIn, 'tmpIn');

      if (err2) {
        console.error('FFmpeg error:', stderr);
        safeUnlink(tmpOut, 'tmpOut (ffmpeg error)');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Conversion failed',
          detail: (stderr || '').slice(-500)
        }));
        return;
      }

      // Stream output to client
      const rs = fs.createReadStream(tmpOut);
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Disposition': 'attachment; filename="output.ts"',
      });

      pipeline(rs, res, function(pipelineErr) {
        // Clean up output temp file after streaming
        safeUnlink(tmpOut, 'tmpOut');
        if (pipelineErr) {
          console.error('Output stream error:', pipelineErr.message);
        }
      });
    });
  });
}

// ── POST /api/vectorize ─────────────────────────────────────────────────
// Body: raw image bytes. Query: colors=auto|1..6, background=remove|keep, detail=fine|standard|smooth
// Runs vectorizer-kit/cli.py (Potrace) and returns { ok, svg, width, height, colors, ... }

function validateVectorOptions(url) {
  const colors = (url.searchParams.get('colors') || 'auto').toLowerCase();
  if (!['auto', '1', '2', '3', '4', '5', '6'].includes(colors)) return null;

  const background = (url.searchParams.get('background') || 'remove').toLowerCase();
  if (!['remove', 'keep'].includes(background)) return null;

  const detail = (url.searchParams.get('detail') || 'standard').toLowerCase();
  if (!['fine', 'standard', 'smooth'].includes(detail)) return null;

  return { colors, background, detail };
}

function handleVectorize(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const opts = validateVectorOptions(url);
  if (!opts) {
    res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: false, error: '参数无效：colors/background/detail 取值不合法' }));
    return;
  }

  if (!fs.existsSync(VECTORIZER_CLI)) {
    res.writeHead(503, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: false, error: '矢量化工具包缺失：vectorizer-kit 未安装' }));
    return;
  }

  const contentLength = parseInt(req.headers['content-length'], 10);
  if (contentLength && contentLength > VECTOR_MAX_BODY) {
    res.writeHead(413, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: false, error: '图片超过 25MB' }));
    return;
  }

  const tmpIn  = generateTempName('vec_input', '.png');
  const tmpOut = generateTempName('vec_output', '.svg');
  let bodySize = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > VECTOR_MAX_BODY && !aborted) {
      aborted = true;
      req.destroy();
      res.writeHead(413, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: '图片超过 25MB' }));
      safeUnlink(tmpIn, 'vec tmpIn');
      safeUnlink(tmpOut, 'vec tmpOut');
    }
  });

  const ws = fs.createWriteStream(tmpIn);
  pipeline(req, ws, (err) => {
    if (aborted) return;
    if (err) {
      safeUnlink(tmpIn, 'vec tmpIn');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: '上传失败' }));
      }
      return;
    }
    if (bodySize === 0) {
      safeUnlink(tmpIn, 'vec tmpIn');
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: '没有收到图片' }));
      return;
    }

    const args = [
      VECTORIZER_CLI,
      tmpIn,
      '--colors', opts.colors,
      '--background', opts.background,
      '--detail', opts.detail,
      '--metadata',
      '-o', tmpOut,
    ];

    execFile('python3', args, {
      cwd: VECTORIZER_DIR,
      timeout: VECTOR_TIMEOUT,
      maxBuffer: 16 * 1024 * 1024,
      env: Object.assign({}, process.env, { POTRACE_PATH: path.join(VECTORIZER_DIR, 'bin', 'potrace') }),
    }, (err2, stdout, stderr) => {
      safeUnlink(tmpIn, 'vec tmpIn');

      if (err2) {
        console.error('[vectorize] failed:', (stderr || err2.message || '').slice(0, 800));
        safeUnlink(tmpOut, 'vec tmpOut');
        const detail = (stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0] || err2.message;
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: '矢量化失败：' + detail }));
        return;
      }

      fs.readFile(tmpOut, 'utf8', (readErr, svg) => {
        safeUnlink(tmpOut, 'vec tmpOut');
        if (readErr || !svg) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ ok: false, error: '读取 SVG 输出失败' }));
          return;
        }

        // cli.py --metadata 把元数据以 JSON 打到 stderr
        let meta = {};
        try {
          const text = (stderr || '').trim();
          const start = text.indexOf('{');
          if (start >= 0) meta = JSON.parse(text.slice(start));
        } catch (e) {
          meta = {};
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
        res.end(JSON.stringify(Object.assign({ ok: true, svg }, meta)));
      });
    });
  });
}

// ── Server ──────────────────────────────────────────────────────────────

http.createServer(function(req, res) {
  // COOP/COEP headers for cross-origin isolation (needed for SharedArrayBuffer in ffmpeg.wasm)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check for environment badge
  if (req.url === '/api/ping') {
    res.writeHead(200, CORS_HEADERS);
    res.end('OK');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/convert')) {
    handleConvert(req, res);
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/vectorize')) {
    handleVectorize(req, res);
    return;
  }

  serveStatic(req, res);
}).listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
  console.log('FFmpeg binary:', FFMPEG);
  console.log('Vectorizer kit:', VECTORIZER_DIR);
  console.log('COOP + COEP headers: enabled');
  console.log('Max upload size:', (MAX_BODY_SIZE / 1024 / 1024).toFixed(0) + 'MB');
});
