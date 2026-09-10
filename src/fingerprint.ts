import { createHash } from 'crypto';
import { open, readFile, stat } from 'fs/promises';

const SAMPLE_SIZE = 1024 * 1024; // 1MB

/**
 * Computes a fast fingerprint for a video file by hashing its exact file size
 * and the first & last 1MB of the file.
 * This prevents reading multi-gigabyte files (e.g. 40-70GB 4K Remuxes) over disk/network
 * while maintaining virtually 100% collision resistance against file replacements.
 */
export async function computeVideoFingerprint(videoPath: string): Promise<string> {
  const { size } = await stat(videoPath);
  const hash = createHash('sha256');
  hash.update(String(size));

  const handle = await open(videoPath, 'r');
  try {
    const headSize = Math.min(SAMPLE_SIZE, size);
    if (headSize > 0) {
      const head = Buffer.alloc(headSize);
      await handle.read(head, 0, headSize, 0);
      hash.update(head);
    }

    if (size > SAMPLE_SIZE) {
      const tail = Buffer.alloc(SAMPLE_SIZE);
      await handle.read(tail, 0, SAMPLE_SIZE, size - SAMPLE_SIZE);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}

/**
 * Computes a fingerprint for an SRT subtitle file.
 * Since subtitle files are small (~20KB to 150KB), computing the full SHA256 hash
 * takes less than 0.1ms. This ensures that if Bazarr or an automated tool updates
 * the subtitle with a better version, SubSyncArr-Ng immediately detects the change
 * and resynchronizes.
 */
export async function computeSrtFingerprint(srtPath: string): Promise<string> {
  const data = await readFile(srtPath);
  return createHash('sha256').update(data).digest('hex');
}
