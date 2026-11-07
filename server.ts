import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const IS_WINDOWS = process.platform === 'win32';
const WORKSPACE_ROOT = process.cwd();
const SESSIONS_ROOT = path.join(os.tmpdir(), 'sensorclean_sessions');
const UPLOADS_ROOT = path.join(os.tmpdir(), 'sensorclean_uploads');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const TEMP_FILE_TTL_MS = 30 * 60 * 1000;
const CLIENT_COOKIE = 'sc_client';
const OWNER_FILE = '.owner';

fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_ROOT);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.rw2';
    const safeBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  defParamCharset: 'utf8',
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB max for high-resolution RW2/DNG files
  },
});

function getVenvPython(): string | null {
  const venvPython = path.join(
    WORKSPACE_ROOT,
    '.venv',
    IS_WINDOWS ? 'Scripts' : 'bin',
    IS_WINDOWS ? 'python.exe' : 'python'
  );
  return fs.existsSync(venvPython) ? venvPython : null;
}

function getPythonBinary(): string {
  return process.env.SENSORCLEAN_PYTHON || getVenvPython() || (IS_WINDOWS ? 'python' : 'python3');
}

// Force UTF-8 so non-ASCII file names survive the stdin/argv hop on Windows locales (e.g. cp949)
const PYTHON_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

const PYTHON_SETUP_HINT = 'Python 엔진이 준비되지 않았습니다. `npm run setup:python`을 실행해 주세요.';

function readSessionOwner(sessionDir: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir, OWNER_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function removePath(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

/**
 * Removes expired sessions and temp files. When `clientId` is given, also trims that client's own
 * older sessions down to `keepForClient`; other clients' sessions are never touched.
 */
function pruneSessions(
  options: { clientId?: string; keepForClient?: number; protectSessionIds?: string[] } = {}
): void {
  const { clientId, keepForClient = 0, protectSessionIds = [] } = options;
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(UPLOADS_ROOT)) {
      const fullPath = path.join(UPLOADS_ROOT, name);
      try {
        if (now - fs.statSync(fullPath).mtimeMs > TEMP_FILE_TTL_MS) removePath(fullPath);
      } catch {}
    }

    const protectSet = new Set(protectSessionIds);
    const ownDirs: { fullPath: string; mtimeMs: number }[] = [];
    for (const name of fs.readdirSync(SESSIONS_ROOT)) {
      const fullPath = path.join(SESSIONS_ROOT, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory() && name.startsWith('sc_')) {
          if (protectSet.has(name)) continue;
          if (now - st.mtimeMs > SESSION_TTL_MS) {
            removePath(fullPath);
          } else if (clientId && readSessionOwner(fullPath) === clientId) {
            ownDirs.push({ fullPath, mtimeMs: st.mtimeMs });
          }
        } else if (st.isFile() && (name.endsWith('.zip') || name.startsWith('multi_cfg_'))) {
          if (now - st.mtimeMs > TEMP_FILE_TTL_MS) removePath(fullPath);
        }
      } catch {}
    }

    ownDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = keepForClient; i < ownDirs.length; i++) removePath(ownDirs[i].fullPath);
  } catch (err) {
    console.warn('pruneSessions warning:', err);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function getClientId(res: express.Response): string {
  return String(res.locals.clientId);
}

/**
 * Resolves a session directory for the calling client. Returns null if the session does not exist
 * or belongs to another client. Touching the directory keeps active sessions alive past the TTL.
 */
function resolveSessionDir(res: express.Response, rawSessionId: unknown): string | null {
  const safeSession = String(rawSessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeSession.startsWith('sc_')) return null;
  const sessionDir = path.join(SESSIONS_ROOT, safeSession);
  if (!fs.existsSync(sessionDir)) return null;
  const owner = readSessionOwner(sessionDir);
  if (owner && owner !== getClientId(res)) return null;
  try {
    const nowDate = new Date();
    fs.utimesSync(sessionDir, nowDate, nowDate);
  } catch {}
  return sessionDir;
}

function createSessionDir(res: express.Response): { sessionId: string; sessionDir: string } {
  const sessionId = `sc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const sessionDir = path.join(SESSIONS_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, OWNER_FILE), getClientId(res));
  return { sessionId, sessionDir };
}

let activeWorker: ChildProcessWithoutNullStreams | null = null;
let workerPending = new Map<
  string,
  { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();
let workerSeq = 0;

async function startPythonWorker(): Promise<ChildProcessWithoutNullStreams> {
  const pyBin = getPythonBinary();
  const scriptPath = path.join(WORKSPACE_ROOT, 'python', 'raw_pipeline.py');
  const child = spawn(pyBin, ['-u', scriptPath, '--worker'], {
    cwd: WORKSPACE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: PYTHON_ENV,
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error('[python]', text);
  });

  child.on('error', (err) => {
    console.error(`Python 작업 프로세스를 시작할 수 없습니다 (${pyBin}): ${err.message}`);
    if (activeWorker === child) {
      activeWorker = null;
    }
    for (const [, entry] of workerPending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(PYTHON_SETUP_HINT));
    }
    workerPending.clear();
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      const reqId = String(msg.id || '');
      const entry = workerPending.get(reqId);
      if (entry) {
        clearTimeout(entry.timer);
        workerPending.delete(reqId);
        if (msg.ok) {
          entry.resolve(msg.data);
        } else {
          entry.reject(new Error(msg.error || 'Python worker error'));
        }
      }
    } catch {
      // Ignore non-JSON stdout lines
    }
  });

  child.on('exit', () => {
    if (activeWorker === child) {
      activeWorker = null;
    }
    for (const [, entry] of workerPending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Python worker exited unexpectedly'));
    }
    workerPending.clear();
  });

  // spawn() reports a missing interpreter asynchronously; only hand out workers that really started
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });

  activeWorker = child;
  return child;
}

let workerStarting: Promise<ChildProcessWithoutNullStreams> | null = null;

function ensurePythonWorker(): Promise<ChildProcessWithoutNullStreams> {
  if (activeWorker && !activeWorker.killed && activeWorker.exitCode === null) {
    return Promise.resolve(activeWorker);
  }
  if (!workerStarting) {
    workerStarting = startPythonWorker().finally(() => {
      workerStarting = null;
    });
  }
  return workerStarting;
}

async function runPythonPipelineFallback(args: string[]): Promise<any> {
  const pyBin = getPythonBinary();
  const scriptPath = path.join(WORKSPACE_ROOT, 'python', 'raw_pipeline.py');
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(pyBin, [scriptPath, ...args], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300000,
      env: PYTHON_ENV,
    }));
  } catch (err: any) {
    if (err?.code === 'ENOENT' || /ModuleNotFoundError|No module named/.test(String(err?.stderr || ''))) {
      throw new Error(PYTHON_SETUP_HINT);
    }
    throw err;
  }

  const lines = stdout.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(lastLine);
    if (!parsed.ok) {
      throw new Error(parsed.error || stderr || 'Python pipeline execution failed');
    }
    return parsed.data;
  } catch (err: any) {
    throw new Error(
      `Python 파이프라인 오류: ${err.message}\nSTDERR: ${stderr || 'none'}`
    );
  }
}

async function runPythonPipeline(args: string[]): Promise<any> {
  let worker: ChildProcessWithoutNullStreams;
  try {
    worker = await ensurePythonWorker();
  } catch {
    return runPythonPipelineFallback(args);
  }

  const reqId = `req_${++workerSeq}_${Date.now()}`;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      workerPending.delete(reqId);
      try {
        worker.kill();
      } catch {}
      reject(new Error('Python worker request timed out'));
    }, 240000);

    workerPending.set(reqId, { resolve, reject, timer });
    worker.stdin.write(JSON.stringify({ id: reqId, args }) + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        workerPending.delete(reqId);
        reject(err);
      }
    });
  });
}

const EXPORT_FORMATS: Record<string, { ext: string; suffix: string }> = {
  dng: { ext: 'dng', suffix: '_cleaned_linear16' },
  tiff16: { ext: 'tiff', suffix: '_cleaned_16bit' },
  png: { ext: 'png', suffix: '_cleaned_srgb' },
  jpg: { ext: 'jpg', suffix: '_cleaned_srgb' },
};

function batchZipPrefix(res: express.Response): string {
  return `${getClientId(res).slice(0, 12)}_`;
}

function toSafeStem(originalFileName: unknown, fallback: string): string {
  const name = String(originalFileName || '');
  const stem = path
    .basename(name, path.extname(name))
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
  return stem || fallback;
}

function readSessionMeta(sessionDir: string): Record<string, any> {
  const metaPath = path.join(sessionDir, 'session_meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return {};
  }
}

/** Returns an error message when the requested export format is not valid for this session. */
function validateExportFormat(fmtKey: string, meta: Record<string, any>): string | null {
  if (!EXPORT_FORMATS[fmtKey]) {
    return `지원하지 않는 내보내기 형식입니다: ${fmtKey}`;
  }
  if (fmtKey === 'dng') {
    const hasRawData =
      meta.decodeKind === 'raw-developed' || (meta.decodeKind === undefined && meta.isRaw !== false);
    if (!hasRawData) {
      return 'RAW 센서 데이터가 아닌 이미지는 DNG로 내보낼 수 없습니다. TIFF 또는 PNG를 사용해 주세요.';
    }
  }
  return null;
}

async function startServer() {
  pruneSessions();
  setInterval(() => pruneSessions(), 10 * 60 * 1000).unref();

  // Pre-warm the persistent Python 16-bit engine in the background
  ensurePythonWorker().catch(() => {});
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Anonymous per-browser identity: sessions are only reachable by the client that created them.
  app.use((req, res, next) => {
    let clientId = parseCookies(req.headers.cookie)[CLIENT_COOKIE];
    if (!clientId || !/^[a-f0-9]{32}$/.test(clientId)) {
      clientId = crypto.randomBytes(16).toString('hex');
      res.setHeader(
        'Set-Cookie',
        `${CLIENT_COOKIE}=${clientId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`
      );
    }
    res.locals.clientId = clientId;
    next();
  });

  // 1. Check Python 16-bit Engine Status
  app.get('/api/engine-status', async (_req, res) => {
    const pyBin = getPythonBinary();
    try {
      const { stdout } = await execFileAsync(pyBin, [
        '-c',
        'import json, cv2, numpy, rawpy, tifffile, piexif; print(json.dumps({"opencv": cv2.__version__, "numpy": numpy.__version__, "rawpy": rawpy.__version__, "tifffile": tifffile.__version__}))',
      ]);
      const versions = JSON.parse(stdout.trim());
      res.json({
        ready: true,
        pythonBinary: pyBin,
        versions,
      });
    } catch (err: any) {
      res.status(500).json({
        ready: false,
        pythonBinary: pyBin,
        error: PYTHON_SETUP_HINT,
        detail: err.message,
      });
    }
  });

  // 2. Serve session preview images (original sRGB preview, B&W edge mask, healed preview)
  app.get('/api/session/:sessionId/file/:fileName', (req, res) => {
    const sessionDir = resolveSessionDir(res, req.params.sessionId);
    if (!sessionDir) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const safeFile = path.basename(req.params.fileName);
    const filePath = path.join(sessionDir, safeFile);

    if (safeFile === OWNER_FILE || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(filePath);
  });

  // 3. Upload RW2 / RAW / Image file -> 16-bit Linear Demosaicing + Initial Dust Detection
  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, async (uploadErr: any) => {
      if (uploadErr) {
        console.error('Multer upload error:', uploadErr);
        res.status(400).json({
          error: `파일 업로드 오류: ${uploadErr.message || String(uploadErr)}`,
        });
        return;
      }

      try {
        if (!req.file) {
          res.status(400).json({ error: '업로드된 파일이 없습니다.' });
          return;
        }

        // Trim only this client's older sessions (expired sessions of anyone are removed as well)
        pruneSessions({ clientId: getClientId(res), keepForClient: 2 });

        const { sessionId, sessionDir } = createSessionDir(res);

        // Preserve original filename inside session directory
        const ext = path.extname(req.file.originalname) || '.rw2';
        const inputFilePath = path.join(sessionDir, `source_input${ext}`);
        fs.renameSync(req.file.path, inputFilePath);

        const defaultParams = {
          method: req.body?.method || 'dual',
          sensitivity: Number(req.body?.sensitivity ?? 68),
          cloudProtection: Number(req.body?.cloudProtection ?? 75),
          minRadius: Number(req.body?.minRadius ?? 2),
          maxRadius: Number(req.body?.maxRadius ?? 40),
          minCircularity: Number(req.body?.minCircularity ?? 0.6),
        };

        const { meta, detection } = await runPythonPipeline([
          'ingest_and_detect',
          inputFilePath,
          sessionDir,
          JSON.stringify(defaultParams),
          req.file.originalname,
        ]);

        const ts = Date.now();
        res.json({
          sessionId,
          meta,
          detection,
          urls: {
            previewOriginal: `/api/session/${sessionId}/file/preview_original.jpg?t=${ts}`,
            vizBwEdge: `/api/session/${sessionId}/file/viz_bw_edge.jpg?t=${ts}`,
            maskAuto: `/api/session/${sessionId}/file/mask_auto.png?t=${ts}`,
          },
        });
      } catch (err: any) {
        console.error('Upload error:', err);
        res.status(500).json({
          error: err.message || '파일 처리 중 오류가 발생했습니다.',
        });
      }
    });
  });

  // 4. Re-run Sensor Dust Detection on 16-bit Linear Data when sliders change
  app.post('/api/detect', async (req, res) => {
    try {
      const { sessionId, params } = req.body;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId가 필요합니다.' });
        return;
      }
      const sessionDir = resolveSessionDir(res, sessionId);
      if (!sessionDir) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다. 파일을 다시 업로드해주세요.' });
        return;
      }
      const safeSession = path.basename(sessionDir);

      const detection = await runPythonPipeline([
        'detect',
        sessionDir,
        JSON.stringify(params || {}),
      ]);

      const ts = Date.now();
      res.json({
        detection,
        urls: {
          vizBwEdge: `/api/session/${safeSession}/file/viz_bw_edge.jpg?t=${ts}`,
          maskAuto: `/api/session/${safeSession}/file/mask_auto.png?t=${ts}`,
        },
      });
    } catch (err: any) {
      console.error('Detect error:', err);
      res.status(500).json({
        error: err.message || '먼지 탐지 중 오류가 발생했습니다.',
      });
    }
  });

  // 5. Run 16-bit Linear Telea Inpainting (cv2.INPAINT_TELEA + Soft Feathering + Sensor Grain Matching)
  app.post('/api/inpaint', async (req, res) => {
    try {
      const { sessionId, spots, manualStrokes, inpaintRadius, preserveGrain } = req.body;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId가 필요합니다.' });
        return;
      }
      const sessionDir = resolveSessionDir(res, sessionId);
      if (!sessionDir) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
        return;
      }
      const safeSession = path.basename(sessionDir);

      const paramsFile = path.join(sessionDir, 'inpaint_params.json');
      fs.writeFileSync(
        paramsFile,
        JSON.stringify({
          spots: spots || [],
          manualStrokes: manualStrokes || [],
          inpaintRadius: Number(inpaintRadius ?? 6),
          preserveGrain: preserveGrain !== false,
        })
      );

      const inpaintResult = await runPythonPipeline([
        'inpaint',
        sessionDir,
        paramsFile,
      ]);

      const ts = Date.now();
      res.json({
        inpaintResult,
        urls: {
          previewInpainted: `/api/session/${safeSession}/file/preview_inpainted.jpg?t=${ts}`,
          maskFinal: `/api/session/${safeSession}/file/mask_final_work.png?t=${ts}`,
        },
      });
    } catch (err: any) {
      console.error('Inpaint error:', err);
      res.status(500).json({
        error: err.message || '16-bit Telea 인페인팅 중 오류가 발생했습니다.',
      });
    }
  });

  // 6. Export Lossless 16-bit Linear DNG (.dng), 16-bit TIFF (.tiff), PNG, or JPG
  // 6a-1. Atomic Inpaint + Export Prepare (returns metadata for 4MB chunked binary download)
  app.post('/api/export-prepare', async (req, res) => {
    try {
      const {
        sessionId,
        format,
        spots,
        manualStrokes,
        inpaintRadius,
        preserveGrain,
      } = req.body;

      if (!sessionId) {
        res.status(400).json({ error: 'sessionId가 필요합니다.' });
        return;
      }

      const sessionDir = resolveSessionDir(res, sessionId);
      if (!sessionDir) {
        res.status(404).json({
          error: '세션을 찾을 수 없습니다. 사진을 다시 불러와 주세요.',
        });
        return;
      }
      const safeSession = path.basename(sessionDir);

      const meta = readSessionMeta(sessionDir);
      const fmtKey = String(format || 'dng').toLowerCase();
      const formatError = validateExportFormat(fmtKey, meta);
      if (formatError) {
        res.status(400).json({ error: formatError });
        return;
      }

      const target = EXPORT_FORMATS[fmtKey];
      const downloadName = `${toSafeStem(meta.originalFileName, 'sensor_cleaned')}${target.suffix}.${target.ext}`;
      const outputPath = path.join(sessionDir, downloadName);

      const paramsFile = path.join(sessionDir, 'inpaint_params.json');
      fs.writeFileSync(
        paramsFile,
        JSON.stringify({
          spots: spots || [],
          manualStrokes: manualStrokes || [],
          inpaintRadius: Number(inpaintRadius ?? 6),
          preserveGrain: preserveGrain !== false,
        })
      );

      const combinedResult = await runPythonPipeline([
        'inpaint_and_export',
        sessionDir,
        paramsFile,
        fmtKey,
        outputPath,
      ]);

      const exportInfo = combinedResult.exportInfo;
      const inpaintResult = combinedResult.inpaintResult;
      const fileSizeBytes = Number(
        exportInfo?.fileSizeBytes || fs.statSync(outputPath).size
      );
      const chunkSize = 4 * 1024 * 1024; // 4MB per HTTP response (safely under 32MB Cloud Run proxy limit)
      const totalChunks = Math.max(1, Math.ceil(fileSizeBytes / chunkSize));
      const ts = Date.now();

      res.json({
        ok: true,
        inpaintResult,
        urls: {
          previewInpainted: `/api/session/${safeSession}/file/preview_inpainted.jpg?t=${ts}`,
          maskFinal: `/api/session/${safeSession}/file/mask_final_work.png?t=${ts}`,
        },
        exportMeta: {
          sessionId: safeSession,
          fileName: downloadName,
          mimeType: exportInfo?.mimeType || 'application/octet-stream',
          fileSizeBytes,
          chunkSize,
          totalChunks,
        },
      });
    } catch (err: any) {
      console.error('Export-prepare error:', err);
      res.status(500).json({
        error: err.message || '파일 내보내기 준비 중 오류가 발생했습니다.',
      });
    }
  });

  // 6a-2. Chunked Binary Stream Endpoint (serves <= 8MB slices so 96MB+ 16-bit DNG/TIFF never hit 32MB proxy HTTP 500)
  app.get('/api/export-chunk/:sessionId/:fileName', (req, res) => {
    try {
      const { sessionId, fileName } = req.params;
      const safeFile = path.basename(fileName);
      let filePath: string | null = null;
      if (sessionId === '__batch__') {
        if (safeFile.startsWith(batchZipPrefix(res)) && safeFile.endsWith('.zip')) {
          filePath = path.join(SESSIONS_ROOT, safeFile);
        }
      } else {
        const sessionDir = resolveSessionDir(res, sessionId);
        if (sessionDir && safeFile !== OWNER_FILE) {
          filePath = path.join(sessionDir, safeFile);
        }
      }

      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({ error: '내보낼 파일을 찾을 수 없습니다.' });
        return;
      }

      const stat = fs.statSync(filePath);
      const totalSize = stat.size;
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      const requestedLength = Math.min(
        8 * 1024 * 1024,
        Math.max(1, Number(req.query.length ?? 4 * 1024 * 1024))
      );

      if (offset >= totalSize) {
        res.status(416).json({ error: 'Offset out of range' });
        return;
      }

      const actualLength = Math.min(requestedLength, totalSize - offset);
      const buf = Buffer.allocUnsafe(actualLength);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buf, 0, actualLength, offset);
      } finally {
        fs.closeSync(fd);
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(actualLength));
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.end(buf);
    } catch (err: any) {
      console.error('Export-chunk error:', err);
      res.status(500).json({
        error: err.message || '파일 청크 전송 중 오류가 발생했습니다.',
      });
    }
  });

  // 6a-3. Legacy direct GET export endpoint
  app.get('/api/export/:sessionId/:format', async (req, res) => {
    try {
      const { sessionId, format } = req.params;
      const sessionDir = resolveSessionDir(res, sessionId);
      if (!sessionDir) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
        return;
      }

      const meta = readSessionMeta(sessionDir);
      const fmtKey = format.toLowerCase();
      const formatError = validateExportFormat(fmtKey, meta);
      if (formatError) {
        res.status(400).json({ error: formatError });
        return;
      }

      const target = EXPORT_FORMATS[fmtKey];
      const downloadName = `${toSafeStem(meta.originalFileName, 'sensor_cleaned')}${target.suffix}.${target.ext}`;
      const outputPath = path.join(sessionDir, downloadName);

      const exportInfo = await runPythonPipeline(['export', sessionDir, fmtKey, outputPath]);

      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-File-Name');
      res.setHeader('X-File-Name', encodeURIComponent(downloadName));
      res.setHeader('Content-Type', exportInfo.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );
      res.sendFile(outputPath, (sendErr) => {
        if (sendErr && !res.headersSent) {
          console.error('sendFile error:', sendErr);
          res.status(500).json({ error: '파일 전송 중 오류가 발생했습니다.' });
        }
      });
    } catch (err: any) {
      console.error('Export error:', err);
      res.status(500).json({
        error: err.message || '파일 내보내기 중 오류가 발생했습니다.',
      });
    }
  });

  // 6b. Multi-Frame Upload for Continuous Sequence Mode (2 to 10 photos)
  app.post('/api/multi-upload', (req, res) => {
    upload.array('files', 10)(req, res, async (uploadErr: any) => {
      if (uploadErr) {
        return res.status(400).json({
          error: uploadErr.message || '다중 파일 업로드에 실패했습니다.',
        });
      }
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
      }

      try {
        // A new sequence replaces this client's previous sessions only
        pruneSessions({ clientId: getClientId(res), keepForClient: 0 });
        const sessionDirs: string[] = [];
        const sessionList: any[] = [];

        for (const file of files) {
          const { sessionId, sessionDir } = createSessionDir(res);

          const inputFilePath = path.join(
            sessionDir,
            `source_input${path.extname(file.originalname)}`
          );
          fs.copyFileSync(file.path, inputFilePath);
          try {
            fs.unlinkSync(file.path);
          } catch {}

          const { meta: ingestMeta, detection } = await runPythonPipeline([
            'ingest_and_detect',
            inputFilePath,
            sessionDir,
            '{}',
            file.originalname,
          ]);

          sessionDirs.push(sessionDir);
          const ts = Date.now();
          sessionList.push({
            sessionId,
            meta: ingestMeta,
            detection,
            urls: {
              previewOriginal: `/api/session/${sessionId}/file/preview_original.jpg?t=${ts}`,
              vizBwEdge: `/api/session/${sessionId}/file/viz_bw_edge.jpg?t=${ts}`,
              maskAuto: `/api/session/${sessionId}/file/mask_auto.png?t=${ts}`,
            },
          });
        }

        // Run multi-frame temporal clustering across all uploaded sessions
        const multiConfigPath = path.join(
          SESSIONS_ROOT,
          `multi_cfg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.json`
        );
        fs.writeFileSync(
          multiConfigPath,
          JSON.stringify({
            sessionDirs,
            tolerancePx: 14.0,
            minFramesMatch: 2,
            detectionParams: {},
          })
        );

        const multiReport = await runPythonPipeline(['multi_detect', multiConfigPath]);
        try {
          fs.unlinkSync(multiConfigPath);
        } catch {}

        for (const item of sessionList) {
          const matchFrame = multiReport.perFrame?.find(
            (pf: any) => pf.sessionId === item.sessionId
          );
          if (matchFrame && matchFrame.spots) {
            item.detection.spots = matchFrame.spots;
            item.detection.totalDetected = matchFrame.totalDetected;
            item.detection.multiConfirmedCount = matchFrame.multiConfirmedCount;
            item.detection.singleFrameCount = matchFrame.singleFrameCount;
            item.detection.projectedCount = matchFrame.projectedCount;
          }
        }

        res.json({
          sessions: sessionList,
          multiReport: {
            totalFrames: multiReport.totalFrames,
            totalClusters: multiReport.totalClusters,
            multiConfirmedClusters: multiReport.multiConfirmedClusters,
            clusters: multiReport.clusters,
          },
        });
      } catch (err: any) {
        console.error('Multi-upload error:', err);
        res.status(500).json({
          error: err.message || '다중 사진 처리 중 오류가 발생했습니다.',
        });
      }
    });
  });

  // 6c. Re-run Multi-Frame Detection
  app.post('/api/multi-detect', async (req, res) => {
    try {
      const { sessionIds, params, tolerancePx, minFramesMatch } = req.body;
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({ error: 'sessionIds 배열이 필요합니다.' });
      }

      const sessionDirs = sessionIds
        .map((sid: string) => resolveSessionDir(res, sid))
        .filter((d: string | null): d is string => d !== null);
      if (sessionDirs.length === 0) {
        return res.status(404).json({ error: '세션을 찾을 수 없습니다. 파일을 다시 업로드해주세요.' });
      }

      const multiConfigPath = path.join(
        SESSIONS_ROOT,
        `multi_cfg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.json`
      );
      fs.writeFileSync(
        multiConfigPath,
        JSON.stringify({
          sessionDirs,
          tolerancePx: Number(tolerancePx ?? 14.0),
          minFramesMatch: Number(minFramesMatch ?? 2),
          detectionParams: params || {},
          forceRedetect: true,
        })
      );

      const multiReport = await runPythonPipeline(['multi_detect', multiConfigPath]);
      try {
        fs.unlinkSync(multiConfigPath);
      } catch {}

      res.json(multiReport);
    } catch (err: any) {
      console.error('Multi-detect error:', err);
      res.status(500).json({ error: err.message || '다중 감지 재실행 중 오류가 발생했습니다.' });
    }
  });

  // 6d. Batch Export and ZIP Download for Continuous Multi-Frame Mode
  app.post('/api/multi-export-zip', async (req, res) => {
    try {
      const { items, format, prepareOnly } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '내보낼 항목 목록이 비어있습니다.' });
      }

      const pyBin = getPythonBinary();
      const fmt = String(format || 'dng').toLowerCase();
      if (!EXPORT_FORMATS[fmt]) {
        return res.status(400).json({ error: `지원하지 않는 내보내기 형식입니다: ${fmt}` });
      }
      const zipFileName = `${batchZipPrefix(res)}SensorClean_${fmt.toUpperCase()}_Sequence_${Date.now()}.zip`;
      const zipPath = path.join(SESSIONS_ROOT, zipFileName);

      const exportedFiles: { path: string; name: string }[] = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const sessionDir = resolveSessionDir(res, item?.sessionId);
        if (!sessionDir) continue;

        const frameMeta = readSessionMeta(sessionDir);
        const formatError = validateExportFormat(fmt, frameMeta);
        if (formatError) {
          return res.status(400).json({ error: `${frameMeta.originalFileName || `#${idx + 1}`}: ${formatError}` });
        }

        const paramsFile = path.join(sessionDir, 'inpaint_params.json');
        fs.writeFileSync(
          paramsFile,
          JSON.stringify({
            spots: item.spots || [],
            manualStrokes: item.manualStrokes || [],
            inpaintRadius: Number(item.params?.inpaintRadius ?? 6),
            preserveGrain: item.params?.preserveGrain !== false,
          })
        );

        const baseStem = toSafeStem(frameMeta.originalFileName, `photo_${idx + 1}`);
        const outName = `${String(idx + 1).padStart(2, '0')}_${baseStem}_cleaned.${EXPORT_FORMATS[fmt].ext}`;
        const outPath = path.join(sessionDir, outName);

        await runPythonPipeline([
          'inpaint_and_export',
          sessionDir,
          paramsFile,
          fmt,
          outPath,
        ]);
        exportedFiles.push({ path: outPath, name: outName });
      }

      if (exportedFiles.length === 0) {
        return res.status(404).json({ error: '내보낼 수 있는 세션이 없습니다. 파일을 다시 업로드해주세요.' });
      }

      const zipScript = `
import zipfile, sys, json, os
data = json.loads(sys.argv[1])
zip_path = sys.argv[2]
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for item in data:
        zf.write(item['path'], item['name'])
        try:
            os.remove(item['path'])
        except Exception:
            pass
`;
      await execFileAsync(pyBin, ['-c', zipScript, JSON.stringify(exportedFiles), zipPath]);

      if (prepareOnly) {
        const fileSizeBytes = fs.statSync(zipPath).size;
        const chunkSize = 4 * 1024 * 1024;
        const totalChunks = Math.max(1, Math.ceil(fileSizeBytes / chunkSize));
        res.json({
          ok: true,
          exportMeta: {
            sessionId: '__batch__',
            fileName: zipFileName,
            downloadName: `SensorClean_${fmt.toUpperCase()}_Sequence.zip`,
            mimeType: 'application/zip',
            fileSizeBytes,
            chunkSize,
            totalChunks,
          },
        });
        return;
      }

      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-File-Name');
      res.setHeader('X-File-Name', encodeURIComponent('SensorClean_Cleaned_Photos.zip'));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="SensorClean_Cleaned_Photos.zip"'
      );
      res.sendFile(zipPath, (sendErr) => {
        if (sendErr && !res.headersSent) {
          res.status(500).json({ error: 'ZIP 전송 실패' });
        }
        try {
          fs.unlinkSync(zipPath);
        } catch {}
      });
    } catch (err: any) {
      console.error('Multi export zip error:', err);
      res.status(500).json({ error: err.message || 'ZIP 내보내기 중 오류가 발생했습니다.' });
    }
  });

  // 7. Return standalone Python source files (Streamlit app.py, raw_pipeline.py, requirements.txt)
  app.get('/api/python-source', (_req, res) => {
    try {
      const streamlitApp = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'python', 'app.py'),
        'utf-8'
      );
      const rawPipeline = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'python', 'raw_pipeline.py'),
        'utf-8'
      );
      const requirements = fs.readFileSync(
        path.join(WORKSPACE_ROOT, 'python', 'requirements.txt'),
        'utf-8'
      );
      res.json({
        streamlitApp,
        rawPipeline,
        requirements,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Ensure unmatched /api/* routes never fall through to Vite's index.html
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `요청한 API 경로를 찾을 수 없습니다 (${req.method} ${req.originalUrl}).`,
    });
  });

  if (!IS_PRODUCTION) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(WORKSPACE_ROOT, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Global error handler so Express / body-parser / multer never return HTML <!DOCTYPE html>
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      console.error('Unhandled server error:', err);
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(err?.status || 500).json({
        error: err?.message || '서버 요청 처리 중 오류가 발생했습니다.',
      });
    }
  );

  app.listen(PORT, HOST, () => {
    console.log(`SensorClean Server listening on http://${HOST}:${PORT}`);
  });
}

startServer();
