import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', '.data');
const storeFile = path.join(dataDir, 'mail-state.json');

const defaultState = {
  processedMessageIds: [],
  leads: [],
  syncLogs: [],
  mailQueue: [],
  sendQueue: [],
  lastSyncAt: '',
  lastError: '',
  context: {
    products: [],
    companyProfile: ''
  }
};

export async function loadMailState() {
  try {
    const raw = await readFile(storeFile, 'utf8');
    return { ...defaultState, ...JSON.parse(raw) };
  } catch {
    return { ...defaultState };
  }
}

export async function saveMailState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storeFile, JSON.stringify({ ...defaultState, ...state }, null, 2), 'utf8');
}

export async function updateMailContext(context = {}) {
  const state = await loadMailState();
  state.context = {
    products: Array.isArray(context.products) ? context.products : state.context.products,
    companyProfile: typeof context.companyProfile === 'string' ? context.companyProfile : state.context.companyProfile
  };
  await saveMailState(state);
  return state.context;
}
