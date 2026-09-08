import { spawn } from 'child_process';
import { basename, dirname, join } from 'path';

export function buildOutputPath(srtPath: string, suffix: string): string {
  const directory = dirname(srtPath);
  let srtBaseName = basename(srtPath, '.srt');
  if (srtBaseName.endsWith(`.${suffix}`)) {
    srtBaseName = srtBaseName.slice(0, -(suffix.length + 1));
  }
  return join(directory, `${srtBaseName}.${suffix}.srt`);
}

export interface ProcessingResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
}

function getTimeoutMs(): number {
  // Support both SYNC_TIMEOUT (seconds) and SYNC_ENGINE_TIMEOUT_MS (milliseconds)
  const seconds = process.env.SYNC_TIMEOUT;
  if (seconds) {
    const val = parseInt(seconds, 10);
    if (!isNaN(val) && val > 0) return val * 1000;
  }
  const ms = process.env.SYNC_ENGINE_TIMEOUT_MS;
  if (ms) {
    const val = parseInt(ms, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 1800000; // 30 minutes default
}

export function execPromise(
  command: string,
  timeoutMs?: number,
  onLog?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  const timeout = timeoutMs ?? getTimeoutMs();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true });
    let stdout = '';
    let stderr = '';
    let isTimedOut = false;

    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (onLog) {
        onLog(text);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onLog) {
        onLog(text);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (isTimedOut) {
        reject(new Error(`Timed out after ${timeout / 1000}s: ${command}`));
      } else if (code !== 0) {
        const error = new Error(`Command failed: ${command}\n${stderr || stdout}`);
        (error as Error & { code?: number | null; stdout?: string; stderr?: string }).code = code;
        (error as Error & { code?: number | null; stdout?: string; stderr?: string }).stdout = stdout;
        (error as Error & { code?: number | null; stdout?: string; stderr?: string }).stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
