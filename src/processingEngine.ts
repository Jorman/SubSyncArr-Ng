import EventEmitter from 'events';
import { existsSync, unlinkSync } from 'fs';
import { ScanConfig, getScanConfig, getSuffixConfig } from './config';
import { findAllSrtFiles } from './findAllSrtFiles';
import { findMatchingVideoFile } from './findMatchingVideoFile';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { StateManager } from './stateManager';
import { buildOutputPath } from './helpers';
import { computeVideoFingerprint, computeSrtFingerprint } from './fingerprint';

export class ProcessingEngine extends EventEmitter {
  private cancelledFiles: Set<string> = new Set();
  private maxConcurrent: number;
  private enabledEngines: string[];
  private logBuffer: string[] = [];
  private maxLogBufferSize: number;
  private fileLogs: Map<string, string[]> = new Map();
  public stateManager?: StateManager;

  constructor() {
    super();
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
  }

  private log(message: string): void {
    console.log(message);

    // Ring buffer - remove oldest if at capacity
    if (this.logBuffer.length >= this.maxLogBufferSize) {
      this.logBuffer.shift(); // Remove oldest
    }

    this.logBuffer.push(message);
    this.emit('log', message);
  }

  private appendFileLog(srtPath: string, message: string): void {
    let logs = this.fileLogs.get(srtPath);
    if (!logs) {
      logs = [];
      this.fileLogs.set(srtPath, logs);
    }
    if (logs.length >= 300) {
      logs.shift();
    }
    logs.push(message);
    this.emit('file:log', { srtPath, log: message });
  }

  getFileLogs(srtPath: string): string[] {
    return this.fileLogs.get(srtPath) || [];
  }

  getAllActiveFileLogs(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [path, logs] of this.fileLogs.entries()) {
      result[path] = logs;
    }
    return result;
  }

  getLogs(): string[] {
    return [...this.logBuffer];
  }

  clearLogs(): void {
    this.logBuffer = [];
  }

  async processRun(config?: ScanConfig): Promise<void> {
    const scanConfig = config || getScanConfig();
    this.log(`[${new Date().toISOString()}] Scanning for subtitle files...`);
    this.log(`[${new Date().toISOString()}] Scan paths: ${JSON.stringify(scanConfig.includePaths)}`);

    const { files: srtFiles, skippedCount, skippedFiles } = await findAllSrtFiles(scanConfig);
    this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files to process (${skippedCount} already synced)`);

    this.emit('run:files_found', srtFiles, skippedCount, skippedFiles);

    // Keep up to maxConcurrent files in flight at all times: each worker pulls the next
    // file off the shared queue as soon as it finishes, instead of waiting for an entire
    // fixed-size batch to drain (which stalls idle slots behind the slowest file in a batch).
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(`[${new Date().toISOString()}] Enabled engines: ${this.enabledEngines.join(', ')}`);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < srtFiles.length) {
        const file = srtFiles[nextIndex++];
        await this.processFile(file);
      }
    };

    const workerCount = Math.min(this.maxConcurrent, srtFiles.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    this.log(`[${new Date().toISOString()}] All files processed`);
  }

  private async processFile(srtPath: string): Promise<void> {
    this.fileLogs.set(srtPath, []);
    const fileName = srtPath.split('/').pop() || srtPath;
    const startMsg = `[${new Date().toISOString()}] Processing: ${fileName}`;
    this.log(startMsg);
    this.appendFileLog(srtPath, startMsg);

    // Check if cancelled
    if (this.cancelledFiles.has(srtPath)) {
      const skipMsg = `[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`;
      this.log(skipMsg);
      this.appendFileLog(srtPath, skipMsg);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return;
    }

    const videoPath = findMatchingVideoFile(srtPath);

    this.emit('file:started', { srtPath, videoPath });

    if (!videoPath) {
      const noVideoMsg = `[${new Date().toISOString()}] No matching video found for: ${fileName}`;
      this.log(noVideoMsg);
      this.appendFileLog(srtPath, noVideoMsg);

      const shouldDeleteOrphan = process.env.DELETE_ORPHANED_SRT !== 'false';
      if (shouldDeleteOrphan) {
        try {
          if (existsSync(srtPath)) {
            unlinkSync(srtPath);
            const delMsg = `[${new Date().toISOString()}] 🗑 Deleted orphaned subtitle: ${fileName}`;
            this.log(delMsg);
            this.appendFileLog(srtPath, delMsg);
          }
          // Also remove any previously synced variants for this orphaned srt if they exist
          const suffixConfig = getSuffixConfig();
          for (const engine of ['ffsubsync', 'autosubsync', 'alass']) {
            const suffix = suffixConfig[engine as keyof typeof suffixConfig] || engine;
            const syncedPath = buildOutputPath(srtPath, suffix);
            if (existsSync(syncedPath)) {
              unlinkSync(syncedPath);
              const delSyncedMsg = `[${new Date().toISOString()}] 🗑 Deleted orphaned synced subtitle: ${syncedPath.split('/').pop()}`;
              this.log(delSyncedMsg);
              this.appendFileLog(srtPath, delSyncedMsg);
            }
          }
          this.emit('file:no_video', { srtPath, deleted: true });
        } catch (error) {
          const failDelMsg = `[${new Date().toISOString()}] ✗ Failed to delete orphaned subtitle ${fileName}: ${error instanceof Error ? error.message : String(error)}`;
          this.log(failDelMsg);
          this.appendFileLog(srtPath, failDelMsg);
          this.emit('file:no_video', { srtPath, deleted: false });
        }
      } else {
        this.emit('file:no_video', { srtPath, deleted: false });
      }
      return;
    }

    const foundVideoMsg = `[${new Date().toISOString()}] Found video: ${videoPath.split('/').pop()}`;
    this.log(foundVideoMsg);
    this.appendFileLog(srtPath, foundVideoMsg);

    // Lazily fingerprint the video (size + 1MB head/tail sample)
    let videoFingerprint: string | null = null;
    const getVideoFingerprint = async (): Promise<string> => {
      if (videoFingerprint === null) {
        videoFingerprint = await computeVideoFingerprint(videoPath);
      }
      return videoFingerprint;
    };

    // Lazily fingerprint the SRT file
    let srtFingerprint: string | null = null;
    const getSrtFingerprint = async (): Promise<string> => {
      if (srtFingerprint === null) {
        srtFingerprint = await computeSrtFingerprint(srtPath);
      }
      return srtFingerprint;
    };

    // Process with each enabled engine
    let anyEngineSucceeded = false;
    let anyEnginePreviouslySynced = false;
    let allEnginesSkipped = true;
    for (const engine of this.enabledEngines) {
      // Check cancellation before each engine
      if (this.cancelledFiles.has(srtPath)) {
        const skipMsg = `[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`;
        this.log(skipMsg);
        this.appendFileLog(srtPath, skipMsg);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      // Check if this engine already processed this exact video & srt combination
      // (handles external tools like Bazarr that rename/replace output file,
      // while detecting if Bazarr updated the subtitle with a better version)
      const processedRecord = this.stateManager?.getProcessedRecord(srtPath, engine);
      if (processedRecord) {
        const vFingerprint = await getVideoFingerprint();
        const sFingerprint = await getSrtFingerprint();

        if (
          vFingerprint === processedRecord.video_fingerprint &&
          (!processedRecord.srt_fingerprint || sFingerprint === processedRecord.srt_fingerprint)
        ) {
          anyEnginePreviouslySynced = true;
          const skipMsg = `[${new Date().toISOString()}] ⊘ Skipping ${engine} (already processed, video & subtitle unchanged): ${fileName}`;
          this.log(skipMsg);
          this.appendFileLog(srtPath, skipMsg);
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: {
              success: true,
              duration: 0,
              message: 'Already processed (unchanged)',
              skipped: true,
            },
          });
          continue; // allEnginesSkipped stays true
        }
      }

      // Check if engine should be skipped due to consecutive failures
      if (this.stateManager?.shouldSkipEngine(srtPath, engine)) {
        const consecMsg = `[${new Date().toISOString()}] ⊘ Skipping ${engine} (3+ consecutive failures): ${fileName}`;
        this.log(consecMsg);
        this.appendFileLog(srtPath, consecMsg);
        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: {
            success: false,
            duration: 0,
            message: 'Skipped due to 3+ consecutive failures',
            skipped: true,
          },
        });
        continue; // Skip to next engine (allEnginesSkipped remains true)
      }

      const engStartMsg = `[${new Date().toISOString()}] Starting ${engine} for: ${fileName}`;
      this.log(engStartMsg);
      this.appendFileLog(srtPath, engStartMsg);
      this.emit('file:engine_started', { srtPath, engine });

      const startTime = Date.now();
      let result;

      const onEngineLog = (chunk: string) => {
        const clean = chunk.replace(/\r/g, '\n');
        const lines = clean.split('\n').filter((l) => l.trim().length > 0);
        for (const line of lines) {
          this.appendFileLog(srtPath, `[${engine}] ${line}`);
        }
      };

      try {
        switch (engine) {
          case 'ffsubsync':
            result = await generateFfsubsyncSubtitles(srtPath, videoPath, onEngineLog);
            break;
          case 'autosubsync':
            result = await generateAutosubsyncSubtitles(srtPath, videoPath, onEngineLog);
            break;
          case 'alass':
            result = await generateAlassSubtitles(srtPath, videoPath, onEngineLog);
            break;
          default:
            continue;
        }

        const duration = Date.now() - startTime;

        // Record success in processed_files with dual fingerprint (video + srt)
        if (result.success && this.stateManager) {
          this.stateManager.markProcessed(
            srtPath,
            engine,
            videoPath,
            await getVideoFingerprint(),
            await getSrtFingerprint(),
          );
        }

        // If this engine was skipped (already processed or skipped by rule), log and continue
        if (result.skipped) {
          if (result.success && result.message?.includes('already processed')) {
            anyEnginePreviouslySynced = true;
          }
          const skipResultMsg = `[${new Date().toISOString()}] ⊘ ${engine} skipped (${result.message || 'already processed'}): ${fileName}`;
          this.log(skipResultMsg);
          this.appendFileLog(srtPath, skipResultMsg);
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: { ...result, duration },
          });
          continue; // allEnginesSkipped stays true
        }

        // An engine actually ran (not skipped), so not all are skipped
        allEnginesSkipped = false;

        const status = result.success ? '✓' : '✗';
        const engDoneMsg = `[${new Date().toISOString()}] ${status} ${engine} completed (${(duration / 1000).toFixed(1)}s): ${fileName}`;
        this.log(engDoneMsg);
        this.appendFileLog(srtPath, engDoneMsg);
        if (!result.success) {
          if (result.message) {
            this.log(`[${new Date().toISOString()}]   Error: ${result.message}`);
            this.appendFileLog(srtPath, `[${engine}] Error: ${result.message}`);
          }
          // Log stderr if available for debugging
          if (result.stderr) {
            this.log(`[${new Date().toISOString()}]   Stderr: ${result.stderr.substring(0, 500)}`);
          }
        }

        if (result.success) {
          anyEngineSucceeded = true;
        }

        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: { ...result, duration },
        });
      } catch (error) {
        // Engine attempted to run (not skipped), so not all are skipped
        allEnginesSkipped = false;

        const duration = Date.now() - startTime;
        const engFailMsg = `[${new Date().toISOString()}] ✗ ${engine} failed (${(duration / 1000).toFixed(1)}s): ${fileName}`;
        this.log(engFailMsg);
        this.appendFileLog(srtPath, engFailMsg);
        const errMsg = error instanceof Error ? error.message : String(error);
        this.log(`[${new Date().toISOString()}]   Error: ${errMsg}`);
        this.appendFileLog(srtPath, `[${engine}] Error: ${errMsg}`);

        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: {
            success: false,
            message: errMsg,
            duration,
          },
        });
      }
    }

    if (anyEngineSucceeded) {
      const finishMsg = `[${new Date().toISOString()}] ✓ Completed successfully for: ${fileName}`;
      this.log(finishMsg);
      this.appendFileLog(srtPath, finishMsg);
      this.emit('file:completed', { srtPath });
    } else if (allEnginesSkipped || anyEnginePreviouslySynced) {
      const skipAllMsg = `[${new Date().toISOString()}] ⊘ All engines skipped: ${fileName}`;
      this.log(skipAllMsg);
      this.appendFileLog(srtPath, skipAllMsg);
      this.emit('file:skipped', { srtPath, reason: 'all_engines_skipped' });
    } else {
      const failAllMsg = `[${new Date().toISOString()}] ✗ All engines failed for: ${fileName}`;
      this.log(failAllMsg);
      this.appendFileLog(srtPath, failAllMsg);
      this.emit('file:failed', { srtPath });
    }
  }

  skipFile(filePath: string): void {
    this.cancelledFiles.add(filePath);
    this.emit('file:skip_requested', { filePath });
  }

  stopAllProcessing(allFiles: string[]): void {
    this.log(`[${new Date().toISOString()}] Stop requested - cancelling all remaining files`);
    allFiles.forEach((file) => this.cancelledFiles.add(file));
  }

  reset(): void {
    this.cancelledFiles.clear();
    this.clearLogs();
    this.fileLogs.clear();
  }
}
