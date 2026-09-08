# 🧬 SubSyncArr-Ng

**SubSyncArr-Ng** (Next-Generation) is an automated subtitle synchronization suite designed to run seamlessly in Docker. It continuously monitors your movie and TV show libraries, identifies out-of-sync subtitles, and synchronizes them with precision using three complementary synchronization engines: **ffsubsync**, **autosubsync**, and **alass**.

SubSyncArr-Ng is non-destructive: it preserves your original subtitles untouched and creates distinct synchronized copies for each engine, providing full redundancy and flexibility in players like Plex, Jellyfin, Emby, and Kodi.

---

## 🌟 What's New in SubSyncArr-Ng

- 🌙 **Modern Dark Mode**: Sleek dark interface with responsive theme toggle (☀️ / 🌙), `localStorage` persistence, and automatic operating system theme detection (`prefers-color-scheme`).
- ⚡ **Live Real-Time File Logs**: Streaming terminal console embedded directly inside the "Currently Processing" card with an active status pulse and auto-scroll, showing audio extraction, speech feature detection, and alignment progress in real time.
- 📄 **Detailed File Log Modal**: Inspect complete stdout, stderr, execution duration, and timeline for any file (both currently running and completed/historical) with one click.
- 🗑️ **Orphaned Subtitle Cleanup (`DELETE_ORPHANED_SRT=true`)**: Automatically purges orphaned subtitle files and their previously synced variants if no corresponding video file exists on disk.
- 🎯 **Smart TV Episode Number Matching**: Intelligently resolves episode numbering differences between subtitles and videos (e.g., matching `00x20` to `S00E20`), preventing valid TV subtitles from being misidentified as orphans.
- 🛠️ **MKV Attachment Streams Fix for `alass`**: Includes an integrated `ffprobe` wrapper that handles MKV files containing embedded attachment streams (such as subtitle fonts or cover art) without crashing Rust's JSON deserializer.
- 🚀 **4K Remux / OOM Protection**: Optimizes `autosubsync` worker parallelism (`AUTOSUBSYNC_PARALLELISM=1`) and automatically delegates sparse forced subtitles (`AUTOSUBSYNC_SKIP_FORCED=true`) to `ffsubsync` and `alass`, preventing memory exhaustion and false failures.
- 📁 **Extended Video Formats**: Native support for `.mkv`, `.mp4`, `.avi`, `.mov`, `.ts`, `.m4v`, `.webm`, `.wmv`, and `.flv`.

---

## ⚙️ Why 3 Different Sync Engines? How Do They Work?

No single subtitle synchronization algorithm works perfectly for every scenario (movies, TV shows, PAL/NTSC frame rate changes, commercial breaks, noisy audio, or sparse forced dialogue). For this reason, SubSyncArr-Ng runs **three complementary engines**:

```
                  ┌─────────────────┐
                  │ Input Subtitle  │ (.srt)
                  └────────┬────────┘
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  ffsubsync   │    │ autosubsync  │    │    alass     │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       ▼                   ▼                   ▼
.ffsubsync.srt      .autosubsync.srt       .alass.srt
```

### 1. `ffsubsync` (Fast Forward Subtitle Sync)
- **Technology**: Python + WebRTC Voice Activity Detection (VAD) + Fast Fourier Transform (FFT).
- **How it works**: Uses ffmpeg to extract the audio stream and translates both the audio voice activity and the subtitle timestamps into mathematical signals. It applies FFT-accelerated cross-correlation to find the optimal global linear offset and speed skew.
- **Best for**: Standard movie releases, linear delays (e.g. subtitles starting 5 seconds too late), and frame-rate conversions (e.g. 23.976 fps to 25.000 fps).
- **Speed**: Extremely fast (typically 5–15 seconds).
- **Output**: `<filename>.<lang>.ffsubsync.srt`

### 2. `autosubsync` (Acoustic Feature & Speech Detection)
- **Technology**: Python + NumPy/SciPy + Pretrained Neural Acoustic Model.
- **How it works**: Computes Mel-Frequency Cepstral Coefficients (MFCC) and energy spectrograms from the audio track. A trained machine learning model identifies speech frames and computes correlation curves against dialogue blocks across a spectrum of candidate skew factors.
- **Best for**: Clean movie dialogue and studio audio tracks where speech cadence can be reliably matched.
- **Special Handling in Ng**: Because autosubsync requires continuous dialogue, SubSyncArr-Ng automatically skips `.forced.srt` files for autosubsync (delegating them to `ffsubsync` and `alass`) and limits worker threads to 1 (`--parallelism 1`) to ensure 4K Remuxes do not trigger Out-Of-Memory (OOM) errors.
- **Output**: `<filename>.<lang>.autosubsync.srt`

### 3. `alass` (Automatic Language-Agnostic Subtitle Synchronization)
- **Technology**: Rust + Dynamic Programming Alignment.
- **How it works**: Analyzes pauses and voice segments using advanced dynamic programming. Unlike pure linear-shift tools, `alass` can split subtitles into independent segments and align each chunk separately.
- **Best for**: TV shows with commercial breaks, Director's Cut vs Theatrical releases, or video files where scenes have been added or removed in the middle of the timeline.
- **Speed**: Blazing fast native Rust execution (typically 3–10 seconds).
- **Output**: `<filename>.<lang>.alass.srt`

---

## 🔄 What Happens During a Scan? (The Workflow)

1. **Discovery & Filtering**: SubSyncArr-Ng scans all paths configured in `SCAN_PATHS` for `.srt` files. Files that are already synchronized (or whose synced outputs already exist) are skipped to save system resources.
2. **Video Association**: The engine pairs each `.srt` file with its video file in the same directory:
   - First by exact name match.
   - Then by progressive tag stripping (removing release group, audio, and resolution tags).
   - Finally by TV episode pattern matching (`00x20` matches `S00E20`).
3. **Orphan Cleanup**: If a subtitle has no corresponding video file in its directory and `DELETE_ORPHANED_SRT` is enabled, the orphan subtitle and any obsolete synced variants are deleted automatically.
4. **Multi-Engine Execution**: Each enabled engine runs in sequence:
   - Real-time stdout and stderr output is streamed live to the Web UI via WebSockets.
   - Each engine produces its own separate `.srt` output.
   - If one engine fails or has insufficient fit quality on noisy background audio, the others continue and succeed.
5. **Database & History**: Results, timestamps, and full execution logs are recorded in the local SQLite database.

---

## 🚀 Quick Start

### Using Docker Compose

Create or update your `docker-compose.yaml`:

```yaml
name: subsyncarr

services:
  subsyncarr:
    build:
      context: .
      dockerfile: Dockerfile
    image: subsyncarr-ng:latest
    container_name: subsyncarr
    ports:
      - '3030:3000' # Web UI accessible at http://<host>:3030
    volumes:
      # Mount your media directories
      - /path/to/movies:/movies
      - /path/to/tv:/tv
      - /path/to/appdata/subsyncarr:/app/data # SQLite database & logs
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2048M # Recommended for 4K / high-bitrate media
        reservations:
          memory: 256M
    environment:
      - PUID=1000
      - PGID=100
      - TZ=Europe/Rome
      - CRON_SCHEDULE=0 0 * * * # Automatic scan daily at midnight
      - SCAN_PATHS=/movies,/tv
      - EXCLUDE_PATHS=/movies/temp,/tv/downloads
      - MAX_CONCURRENT_SYNC_TASKS=1
      - INCLUDE_ENGINES=ffsubsync,autosubsync,alass
      - AUTOSUBSYNC_PARALLELISM=1
      - AUTOSUBSYNC_SKIP_FORCED=true
      - DELETE_ORPHANED_SRT=true
```

Run the container:

```bash
docker compose up -d
```

Open your browser at **`http://localhost:3030`** (or your server's IP address on port `3030`).

---

## 📋 Configuration Options

### Core Settings

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SCAN_PATHS` | `/scan_dir` | Comma-separated paths to scan for subtitles (e.g. `/movies,/tv`) |
| `EXCLUDE_PATHS` | _(none)_ | Comma-separated directory paths to exclude from scanning |
| `SYNC_LANGUAGES` | _(none)_ | Comma-separated language codes to sync (e.g., `it,en`). If unset, all subtitles are synced |
| `CRON_SCHEDULE` | `0 0 * * *` | Cron schedule for automatic runs, or `disabled` to turn off |
| `MAX_CONCURRENT_SYNC_TASKS` | `1` | Number of files processed in parallel (1 is recommended to conserve CPU/RAM) |
| `INCLUDE_ENGINES` | `ffsubsync,autosubsync,alass` | Comma-separated list of engines to run |
| `DELETE_ORPHANED_SRT` | `true` | Automatically delete subtitle files that have no matching video in their folder |
| `AUTOSUBSYNC_PARALLELISM` | `1` | Worker threads for autosubsync (set to 1 to prevent OOM on 4K files) |
| `AUTOSUBSYNC_SKIP_FORCED` | `true` | Skip autosubsync on `.forced.srt` files (handled by ffsubsync and alass) |
| `FFSUBSYNC_SUFFIX` | `ffsubsync` | Custom suffix for ffsubsync outputs (e.g. `movie.en.ffsubsync.srt`) |
| `AUTOSUBSYNC_SUFFIX` | `autosubsync` | Custom suffix for autosubsync outputs |
| `ALASS_SUFFIX` | `alass` | Custom suffix for alass outputs |
| `SYNC_ENGINE_TIMEOUT_MS` | `1800000` | Engine timeout in milliseconds (default 30 minutes) |
| `WEB_PORT` | `3000` | Internal port for the Web UI (mapped to host port via docker-compose) |
| `WEB_HOST` | `0.0.0.0` | Host interface for Web UI binding |
| `PUID` | `1000` | User ID for file permissions |
| `PGID` | `100` | Group ID for file permissions |
| `TZ` | `Etc/UTC` | Timezone for logs and cron scheduling (e.g. `Europe/Rome`) |

### Database & Retention Settings

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DB_PATH` | `/app/data/subsyncarr-plus.db` | SQLite database file location |
| `LOG_BUFFER_SIZE` | `1000` | Maximum log lines kept in memory |
| `RETENTION_KEEP_RUNS_DAYS` | `30` | Keep completed runs in database for N days |
| `RETENTION_TRIM_LOGS_DAYS` | `7` | Trim verbose logs after N days (keeps summary only) |
| `RETENTION_CLEANUP_INTERVAL_HOURS` | `24` | Frequency of database cleanup job |

---

## 🖥️ Web UI Guide

The Web UI provides complete real-time monitoring and control:

1. **Header & Status Indicators**:
   - ☀️ / 🌙 **Theme Switcher**: Instant toggle between sleek Dark Mode and Light Mode.
   - **Watching Folders**: Displays currently monitored directories.
   - **Next Scheduled Scan**: Shows the next automated cron run time.
   - **Controls**: *Start Full Run*, *Scan Specific Path* (with interactive folder picker), and *Stop Processing*.

2. **Currently Processing Card**:
   - Live progress bar with completion percentages.
   - Current engine indicator (`⚙️ Working on ffsubsync`).
   - **Embedded Live Console**: Monospace terminal box streaming the real-time output of the running engine, complete with pulsing green indicator and auto-scrolling.
   - **`[📄 View Log]` Button**: Opens a full-screen detailed log modal for the active file.
   - **`[Skip]` Button**: Cancels processing for that specific file.
   - **`[📜 Live Run Log]` Button**: Opens the global run log for the entire session.

3. **Completed & Skipped Files**:
   - Badges showing engine execution times (e.g., `✓ ffsubsync 5.0s`, `✓ alass 3.3s`).
   - **`[📄 Log]` Button**: Click on any completed file to view its complete timeline, engine duration, stdout, stderr, and copy log output to clipboard.
   - **`Clear Files` Button**: Cleans completed files from the UI display without altering disk data.

4. **Run History**:
   - Comprehensive historical table of past runs with file counts, engine pass/fail breakdown (**F**, **Au**, **Al**), duration, and full run log viewer.

---

## 📁 Recommended Media Organization

```txt
/movies
├── The Old Man and the Gun (2018) {imdb-tt2837574}/
│   ├── The Old Man and the Gun (2018).mkv
│   ├── The Old Man and the Gun (2018).it.forced.srt          # Original subtitle
│   ├── The Old Man and the Gun (2018).it.forced.ffsubsync.srt # Synced copy
│   └── The Old Man and the Gun (2018).it.forced.alass.srt     # Synced copy

/tv
└── American Ninja Warrior (2009)/
    ├── American Ninja Warrior (2009) - S00E20.mkv
    ├── American Ninja Warrior (2009) - 00x20 - Celebrity.en.srt          # Original
    ├── American Ninja Warrior (2009) - 00x20 - Celebrity.en.ffsubsync.srt # Synced
    └── American Ninja Warrior (2009) - 00x20 - Celebrity.en.alass.srt     # Synced
```

---

## 📄 License

Open-source under the original project license. Maintained at [https://github.com/Jorman/SubSyncArr-Ng](https://github.com/Jorman/SubSyncArr-Ng).
