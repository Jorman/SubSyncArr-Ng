import { buildOutputPath, execPromise, ProcessingResult } from './helpers';
import { existsSync, unlinkSync } from 'fs';
import { getSuffixConfig } from './config';

export function isForcedSubtitle(filePath: string): boolean {
  return /\.forced\.srt$/i.test(filePath) || /[-._]forced[-._]/i.test(filePath);
}

export async function generateAutosubsyncSubtitles(srtPath: string, videoPath: string): Promise<ProcessingResult> {
  const outputPath = buildOutputPath(srtPath, getSuffixConfig().autosubsync);

  // Check if forced subtitle should be skipped for autosubsync (autosubsync fails on sparse text)
  if (isForcedSubtitle(srtPath) && process.env.AUTOSUBSYNC_SKIP_FORCED !== 'false') {
    return {
      success: true,
      message: 'Skipped: autosubsync does not support forced subtitles (sparse dialogue)',
      skipped: true,
    };
  }

  const exists = existsSync(outputPath);
  if (exists) {
    return {
      success: true,
      message: `Skipping ${outputPath} - already processed`,
      skipped: true,
    };
  }

  try {
    const parallelism = process.env.AUTOSUBSYNC_PARALLELISM || '1';
    const maxShift = process.env.AUTOSUBSYNC_MAX_SHIFT_SECS ? ` --max_shift_secs ${process.env.AUTOSUBSYNC_MAX_SHIFT_SECS}` : '';
    const command = `autosubsync --parallelism ${parallelism}${maxShift} "${videoPath}" "${srtPath}" "${outputPath}"`;
    console.log(`${new Date().toLocaleString()} Processing: ${command}`);
    const { stdout, stderr } = await execPromise(command);
    return {
      success: true,
      message: `Successfully processed: ${outputPath}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  } catch (error) {
    // Clean up partial or bad output file written before failure
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {
        // Ignore unlink error
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('SIGTERM') || errorMessage.includes('timed out');

    // Extract stdout/stderr from error if available
    const execError = error as { stdout?: string; stderr?: string };
    const stdout = execError.stdout || '';
    const stderr = execError.stderr || '';

    if (isTimeout) {
      return {
        success: false,
        message: `Timeout: ${outputPath} took longer than allowed timeout`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }

    return {
      success: false,
      message: `Error processing ${outputPath}: ${errorMessage}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  }
}
