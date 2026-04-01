import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.mjs';

const FILE = path.join(DATA_DIR, 'hh-apply-launches.json');
const HOUR_MS = 60 * 60 * 1000;

function readState() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.timestamps) ? j : { timestamps: [] };
  } catch {
    return { timestamps: [] };
  }
}

function prune(now, timestamps) {
  return timestamps.filter((t) => typeof t === 'number' && now - t < HOUR_MS);
}

export function countApplyLaunchesLastHour() {
  const now = Date.now();
  const { timestamps } = readState();
  return prune(now, timestamps).length;
}

export function recordApplyLaunch() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const now = Date.now();
  const { timestamps } = readState();
  const next = [...prune(now, timestamps), now];
  fs.writeFileSync(FILE, JSON.stringify({ timestamps: next }, null, 0), 'utf8');
}
