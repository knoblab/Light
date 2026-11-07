import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvDir = path.join(root, '.venv');
const isWin = process.platform === 'win32';
const venvPython = path.join(venvDir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
const requirements = path.join(root, 'python', 'requirements.txt');
const constraints = path.join(root, 'python', 'constraints.txt');
const withDev = process.argv.includes('--dev');
const devRequirements = path.join(root, 'python', 'requirements-dev.txt');

const MIN_MINOR = 10;
const MAX_MINOR = 13;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

function probe(cmd, args = []) {
  const res = spawnSync(cmd, [...args, '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  const [major, minor] = res.stdout.trim().split('.').map(Number);
  if (major !== 3 || minor < MIN_MINOR || minor > MAX_MINOR) return null;
  return `${major}.${minor}`;
}

function hasUv() {
  return spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
}

function createVenv() {
  if (hasUv()) {
    console.log('Creating .venv with uv (Python 3.12)');
    const res = run('uv', ['venv', venvDir, '--python', '3.12']);
    if (res.status === 0) return;
    console.warn('uv could not create the environment, falling back to system Python.');
  }

  const candidates = isWin
    ? [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['python', []]]
    : [['python3.12', []], ['python3.13', []], ['python3.11', []], ['python3', []]];

  for (const [cmd, args] of candidates) {
    const version = probe(cmd, args);
    if (!version) continue;
    console.log(`Creating .venv with ${cmd} ${args.join(' ')} (Python ${version})`);
    const res = run(cmd, [...args, '-m', 'venv', venvDir]);
    if (res.status === 0) return;
  }

  console.error(
    `No supported Python found. Install Python 3.${MIN_MINOR}-3.${MAX_MINOR} (or uv) and run again.`
  );
  process.exit(1);
}

if (!fs.existsSync(venvPython)) {
  createVenv();
}

const args = ['-r', withDev ? devRequirements : requirements, '-c', constraints];
let install;
if (spawnSync(venvPython, ['-m', 'pip', '--version'], { encoding: 'utf8' }).status === 0) {
  install = run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', ...args]);
} else if (hasUv()) {
  install = run('uv', ['pip', 'install', '--python', venvPython, ...args]);
} else {
  console.error('The virtual environment has no pip and uv is not installed.');
  process.exit(1);
}
if (install.status !== 0) process.exit(install.status ?? 1);

const check = spawnSync(
  venvPython,
  ['-c', 'import cv2, numpy, rawpy, tifffile, piexif; print("engine ok: rawpy", rawpy.__version__)'],
  { encoding: 'utf8' }
);
if (check.status !== 0) {
  console.error(check.stderr || 'Engine import check failed.');
  process.exit(1);
}
console.log(check.stdout.trim());
