import { existsSync, readdirSync } from 'fs';
import { basename, dirname, join, extname } from 'path';

type VideoExtension = '.mkv' | '.mp4' | '.avi' | '.mov' | '.ts' | '.m4v' | '.webm' | '.wmv' | '.flv';
const VIDEO_EXTENSIONS: VideoExtension[] = ['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m4v', '.webm', '.wmv', '.flv'];

export function findMatchingVideoFile(srtPath: string): string | null {
  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');

  // 1. Try exact match first
  for (const ext of VIDEO_EXTENSIONS) {
    const possibleVideoPath = join(directory, `${srtBaseName}${ext}`);
    if (existsSync(possibleVideoPath)) {
      return possibleVideoPath;
    }
  }

  // 2. Progressive tag removal - split by dots and try removing one segment at a time
  const segments = srtBaseName.split('.');
  while (segments.length > 1) {
    segments.pop(); // Remove the last segment
    const baseNameToTry = segments.join('.');

    for (const ext of VIDEO_EXTENSIONS) {
      const possibleVideoPath = join(directory, `${baseNameToTry}${ext}`);
      if (existsSync(possibleVideoPath)) {
        return possibleVideoPath;
      }
    }
  }

  // 3. Fallback: Episode number matching (e.g. S00E20 vs 00x20, S01E05 vs 1x05)
  const episodeRegex = /(?:[sS]([0-9]{1,2})[eE]([0-9]{1,3})|(?:\b|^)([0-9]{1,2})[xX]([0-9]{1,3})\b)/;
  const match = srtBaseName.match(episodeRegex);
  if (match) {
    const season = parseInt(match[1] || match[3], 10);
    const episode = parseInt(match[2] || match[4], 10);

    try {
      const files = readdirSync(directory);
      for (const file of files) {
        const ext = extname(file).toLowerCase() as VideoExtension;
        if (VIDEO_EXTENSIONS.includes(ext)) {
          const fileMatch = file.match(episodeRegex);
          if (fileMatch) {
            const fileSeason = parseInt(fileMatch[1] || fileMatch[3], 10);
            const fileEpisode = parseInt(fileMatch[2] || fileMatch[4], 10);
            if (fileSeason === season && fileEpisode === episode) {
              return join(directory, file);
            }
          }
        }
      }
    } catch {
      // Ignore readdir errors
    }
  }

  return null;
}
