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

const PORT = 3000;
const WORKSPACE_ROOT = process.cwd();
const SESSIONS_ROOT = path.join(os.tmpdir(), 'sensorclean_sessions');
const UPLOADS_ROOT = path.join(os.tmpdir(), 'sensorclean_uploads');

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
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB max for high-resolution RW2/DNG files
  },
});

let pythonEnvBootstrapPromise: Promise<string> | null = null;

function getExistingPythonBinary(): string | null {
  const localVenvPy = path.join(WORKSPACE_ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(localVenvPy)) {
    return localVenvPy;
  }
  const tmpVenvPy = '/tmp/venv/bin/python';
  if (fs.existsSync(tmpVenvPy)) {
    return tmpVenvPy;
  }
  return null;
}

async function ensurePythonEnvironment(): Promise<string> {
  const existing = getExistingPythonBinary();
  if (existing) {
    return existing;
  }

  if (pythonEnvBootstrapPromise) {
    return pythonEnvBootstrapPromise;
  }

  pythonEnvBootstrapPromise = (async () => {
    try {
      const targetVenv = path.join(WORKSPACE_ROOT, '.venv');
      const targetPy = path.join(targetVenv, 'bin', 'python');
      const targetPip = path.join(targetVenv, 'bin', 'pip');
      console.log('Bootstrapping Python 16-bit environment in', targetVenv);

      await execFileAsync(
        'bash',
        [
          '-c',
          `python3 -m venv --without-pip "${targetVenv}" && curl -sS https://bootstrap.pypa.io/get-pip.py | "${targetPy}" && "${targetPip}" install --no-cache-dir numpy opencv-python-headless rawpy tifffile piexif`,
        ],
        { maxBuffer: 50 * 1024 * 1024, timeout: 240000 }
      );

      if (fs.existsSync(targetPy)) {
        return targetPy;
      }
      return 'python3';
    } catch (err) {
      console.error('Failed to auto-bootstrap Python venv:', err);
      return 'python3';
    } finally {
      pythonEnvBootstrapPromise = null;
    }
  })();

  return pythonEnvBootstrapPromise;
}

function getPythonBinary(): string {
  return getExistingPythonBinary() || 'python3';
}

function pruneOldSessions(keepMax: number = 2, protectSessionIds: string[] = []): void {
  try {
    // 1. Clean up stale files in UPLOADS_ROOT older than 5 minutes
    if (fs.existsSync(UPLOADS_ROOT)) {
      const now = Date.now();
      for (const name of fs.readdirSync(UPLOADS_ROOT)) {
        const fullPath = path.join(UPLOADS_ROOT, name);
        try {
          const st = fs.statSync(fullPath);
          if (now - st.mtimeMs > 5 * 60 * 1000) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {}
      }
    }

    // 2. Prune older session directories and old batch zip files in SESSIONS_ROOT to prevent /tmp tmpfs RAM exhaustion
    if (!fs.existsSync(SESSIONS_ROOT)) return;
    const protectSet = new Set(protectSessionIds);
    const entries = fs.readdirSync(SESSIONS_ROOT);
    const dirs: { name: string; fullPath: string; mtimeMs: number }[] = [];

    for (const name of entries) {
      if (protectSet.has(name)) continue;
      const fullPath = path.join(SESSIONS_ROOT, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory() && name.startsWith('sc_')) {
          dirs.push({ name, fullPath, mtimeMs: st.mtimeMs });
        } else if (st.isFile() && (name.endsWith('.zip') || name.startsWith('multi_cfg_'))) {
          if (Date.now() - st.mtimeMs > 5 * 60 * 1000) {
            fs.rmSync(fullPath, { force: true });
          }
        }
      } catch {}
    }

    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = keepMax; i < dirs.length; i++) {
      try {
        fs.rmSync(dirs[i].fullPath, { recursive: true, force: true });
      } catch {}
    }
  } catch (err) {
    console.warn('pruneOldSessions warning:', err);
  }
}

let activeWorker: ChildProcessWithoutNullStreams | null = null;
let workerPending = new Map<
  string,
  { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();
let workerSeq = 0;

async function ensurePythonWorker(): Promise<ChildProcessWithoutNullStreams> {
  if (activeWorker && !activeWorker.killed && activeWorker.exitCode === null) {
    return activeWorker;
  }

  const pyBin = await ensurePythonEnvironment();
  const scriptPath = path.join(WORKSPACE_ROOT, 'python', 'raw_pipeline.py');
  const child = spawn(pyBin, ['-u', scriptPath, '--worker'], {
    cwd: WORKSPACE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
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

  activeWorker = child;
  return child;
}

async function runPythonPipelineFallback(args: string[]): Promise<any> {
  const pyBin = await ensurePythonEnvironment();
  const scriptPath = path.join(WORKSPACE_ROOT, 'python', 'raw_pipeline.py');
  const { stdout, stderr } = await execFileAsync(pyBin, [scriptPath, ...args], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 300000,
  });

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
  try {
    const worker = await ensurePythonWorker();
    const reqId = `req_${++workerSeq}_${Date.now()}`;
    return await new Promise<any>((resolve, reject) => {
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
  } catch {
    return runPythonPipelineFallback(args);
  }
}

async function startServer() {
  // Pre-warm the persistent Python 16-bit engine in the background
  ensurePythonWorker().catch(() => {});
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 1. Check Python 16-bit Engine Status
  app.get('/api/engine-status', async (_req, res) => {
    try {
      const pyBin = await ensurePythonEnvironment();
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
        error: err.message,
      });
    }
  });

  // 2. Serve session preview images (original sRGB preview, B&W edge mask, healed preview)
  app.get('/api/session/:sessionId/file/:fileName', (req, res) => {
    const { sessionId, fileName } = req.params;
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeFile = path.basename(fileName);
    const filePath = path.join(SESSIONS_ROOT, safeSession, safeFile);

    if (!fs.existsSync(filePath)) {
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

        // Free old sessions in /tmp before ingesting a new 16-bit RAW array
        pruneOldSessions(1);

        const sessionId = `sc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const sessionDir = path.join(SESSIONS_ROOT, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });

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
      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
      const sessionDir = path.join(SESSIONS_ROOT, safeSession);
      if (!fs.existsSync(sessionDir)) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다. 파일을 다시 업로드해주세요.' });
        return;
      }

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
      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
      const sessionDir = path.join(SESSIONS_ROOT, safeSession);
      if (!fs.existsSync(sessionDir)) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
        return;
      }

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

      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
      const sessionDir = path.join(SESSIONS_ROOT, safeSession);
      if (!fs.existsSync(sessionDir)) {
        res.status(404).json({
          error: '세션을 찾을 수 없습니다. 사진을 다시 불러와 주세요.',
        });
        return;
      }

      const metaPath = path.join(sessionDir, 'session_meta.json');
      const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : { originalFileName: 'sensor_cleaned.rw2' };

      const rawStem = path
        .basename(
          meta.originalFileName || 'sensor_cleaned',
          path.extname(meta.originalFileName || '')
        )
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^_+|_+$/g, '');
      const baseStem = rawStem || 'sensor_cleaned';

      const fmtKey = String(format || 'dng').toLowerCase();
      const fmtMap: Record<string, { ext: string; suffix: string }> = {
        dng: { ext: 'dng', suffix: '_cleaned_linear16' },
        tiff16: { ext: 'tiff', suffix: '_cleaned_16bit' },
        png: { ext: 'png', suffix: '_cleaned_srgb' },
        jpg: { ext: 'jpg', suffix: '_cleaned_srgb' },
      };

      const target = fmtMap[fmtKey] || fmtMap.dng;
      const downloadName = `${baseStem}${target.suffix}.${target.ext}`;
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
      const filePath =
        sessionId === '__batch__'
          ? path.join(SESSIONS_ROOT, safeFile)
          : path.join(
              SESSIONS_ROOT,
              String(sessionId).replace(/[^a-zA-Z0-9_-]/g, ''),
              safeFile
            );

      if (!fs.existsSync(filePath)) {
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
      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
      const sessionDir = path.join(SESSIONS_ROOT, safeSession);
      if (!fs.existsSync(sessionDir)) {
        res.status(404).json({ error: '세션을 찾을 수 없습니다.' });
        return;
      }

      const metaPath = path.join(sessionDir, 'session_meta.json');
      const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : { originalFileName: 'sensor_cleaned.rw2' };

      const rawStem = path
        .basename(
          meta.originalFileName || 'sensor_cleaned',
          path.extname(meta.originalFileName || '')
        )
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^_+|_+$/g, '');
      const baseStem = rawStem || 'sensor_cleaned';

      const fmtMap: Record<string, { ext: string; suffix: string }> = {
        dng: { ext: 'dng', suffix: '_cleaned_linear16' },
        tiff16: { ext: 'tiff', suffix: '_cleaned_16bit' },
        png: { ext: 'png', suffix: '_cleaned_srgb' },
        jpg: { ext: 'jpg', suffix: '_cleaned_srgb' },
      };

      const target = fmtMap[format.toLowerCase()] || fmtMap.dng;
      const downloadName = `${baseStem}${target.suffix}.${target.ext}`;
      const outputPath = path.join(sessionDir, downloadName);

      const exportInfo = await runPythonPipeline([
        'export',
        sessionDir,
        format.toLowerCase(),
        outputPath,
      ]);

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
        pruneOldSessions(0);
        const sessionDirs: string[] = [];
        const sessionList: any[] = [];

        for (const file of files) {
          const sessionId = `sc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          const sessionDir = path.join(SESSIONS_ROOT, sessionId);
          fs.mkdirSync(sessionDir, { recursive: true });

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
        .map((sid: string) => path.join(SESSIONS_ROOT, String(sid).replace(/[^a-zA-Z0-9_-]/g, '')))
        .filter((d: string) => fs.existsSync(d));

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

      const pyBin = await ensurePythonEnvironment();
      const fmt = String(format || 'dng').toLowerCase();
      const zipFileName = `SensorClean_${fmt.toUpperCase()}_Sequence_${Date.now()}.zip`;
      const zipPath = path.join(SESSIONS_ROOT, zipFileName);

      const exportedFiles: { path: string; name: string }[] = [];
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const safeSession = String(item.sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
        const sessionDir = path.join(SESSIONS_ROOT, safeSession);
        if (!fs.existsSync(sessionDir)) continue;

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

        const metaPath = path.join(sessionDir, 'session_meta.json');
        const meta = fs.existsSync(metaPath)
          ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          : { originalFileName: `photo_${idx + 1}.rw2` };
        const rawStem = path
          .basename(meta.originalFileName || 'photo', path.extname(meta.originalFileName || ''))
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/^_+|_+$/g, '');
        const baseStem = rawStem || `photo_${idx + 1}`;

        const fmtExtMap: Record<string, string> = {
          dng: 'dng',
          tiff16: 'tiff',
          png: 'png',
          jpg: 'jpg',
        };
        const ext = fmtExtMap[fmt] || 'dng';
        const outName = `${String(idx + 1).padStart(2, '0')}_${baseStem}_cleaned.${ext}`;
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

  if (process.env.NODE_ENV !== 'production') {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SensorClean Pro Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
