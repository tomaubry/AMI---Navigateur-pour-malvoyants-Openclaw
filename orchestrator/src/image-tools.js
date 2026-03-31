import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_IMAGE_DIR = path.resolve(process.cwd(), '.tmp/incoming_images');

const DEFAULT_NOVNC_DOWNLOAD_DIRS = [
  // chemins fréquents selon images docker / utilisateurs
  '/home/ubuntu/Downloads',
  '/home/user/Downloads',
  '/home/chromium/Downloads',
  '/home/seluser/Downloads',
  '/home/ami/Downloads',
  '/root/Downloads',
];

function getImageDir() {
  // Permet d'overrider facilement en prod
  return process.env.AMI_IMAGE_DIR
    ? path.resolve(process.env.AMI_IMAGE_DIR)
    : DEFAULT_IMAGE_DIR;
}

export async function ensureImageDir() {
  const dir = getImageDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function isSupportedImageFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || '')).trim();
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function dirExists(dirPath) {
  try {
    const st = await fs.stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listImagesFromDir(dir, { source = 'store' } = {}) {
  if (!(await dirExists(dir))) return [];

  const items = await fs.readdir(dir).catch(() => []);
  const stats = await Promise.all(
    items
      .filter(isSupportedImageFile)
      .map(async (filename) => {
        const filePath = path.join(dir, filename);
        const st = await fs.stat(filePath);
        return {
          id: `${source}:${filename}`,
          filename,
          filePath,
          createdAt: st.mtimeMs,
          size: st.size,
          source,
          dir,
        };
      })
  );

  return stats;
}

function getNovncDownloadDirs() {
  const custom = process.env.AMI_NOVNC_DOWNLOAD_DIR;
  if (custom) return [path.resolve(custom)];
  return DEFAULT_NOVNC_DOWNLOAD_DIRS;
}

async function importImageToStore(img) {
  const storeDir = await ensureImageDir();

  // Déjà dans le store
  if (path.resolve(img.dir) === path.resolve(storeDir)) return img;

  const safeName = sanitizeFilename(img.filename);
  const destFilename = `${Date.now()}_${safeName}`;
  const destPath = path.join(storeDir, destFilename);

  await fs.copyFile(img.filePath, destPath);
  const st = await fs.stat(destPath);

  return {
    id: `store:${destFilename}`,
    filename: destFilename,
    filePath: destPath,
    createdAt: st.mtimeMs,
    size: st.size,
    source: 'store',
    dir: storeDir,
    importedFrom: img.filePath,
  };
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

export async function listImages() {
  // Images “officielles” du store
  const dir = await ensureImageDir();
  const stats = await listImagesFromDir(dir, { source: 'store' });
  return stats.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Retourne la dernière image disponible.
 * Par défaut, inclut aussi le dossier de téléchargements noVNC (si accessible),
 * puis importe l'image dans le store afin qu'elle soit servie via /incoming-images.
 */
export async function getLatestImage({ includeNoVncDownloads = true, importToStore = true } = {}) {
  const storeDir = await ensureImageDir();
  const storeImages = await listImagesFromDir(storeDir, { source: 'store' });

  let candidates = [...storeImages];

  if (includeNoVncDownloads) {
    const dlDirs = getNovncDownloadDirs();
    const dlLists = await Promise.all(dlDirs.map((d) => listImagesFromDir(d, { source: 'novnc_downloads' })));
    candidates = candidates.concat(dlLists.flat());
  }

  candidates.sort((a, b) => b.createdAt - a.createdAt);
  const latest = candidates[0] || null;
  if (!latest) return null;

  if (importToStore) {
    return await importImageToStore(latest);
  }

  return latest;
}

export function getPublicImageUrl(filename) {
  // Route servie par Express (voir server.js)
  return `/incoming-images/${encodeURIComponent(filename)}`;
}

export async function readImageAsDataUrl(filePath, filename) {
  const buf = await fs.readFile(filePath);
  const mime = getMimeType(filename);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function describeImage({ filePath, filename, userInstruction = '' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquant dans .env');

  const dataUrl = await readImageAsDataUrl(filePath, filename);

  const instruction = userInstruction?.trim()
    ? `Contrainte utilisateur: ${userInstruction.trim()}`
    : '';

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'Tu es Ami. Ta tâche ici: décrire une image de façon claire, utile et honnête. '
          + 'N\'inventes jamais des détails non visibles. Si une zone est floue/illisible, dis-le. '
          + 'Réponds en français. Style: 3 à 6 phrases max, ton chaleureux et direct. '
          + 'Si du texte est lisible, retranscris-le. '
          + 'Termine par une question courte: "Tu veux que je regarde un détail en particulier ?"',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Décris précisément cette image. ${instruction}`.trim() },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return res.choices?.[0]?.message?.content?.trim() || '';
}
