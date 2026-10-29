"""Free anonymous channel discovery and bounded trailer delivery. No bot token."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

import imageio_ffmpeg
import requests
import yt_dlp

MAX_BYTES = 45_000_000
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class MediaError(Exception):
    pass


class SafeLogger:
    def __init__(self):
        self.blocked = False

    def debug(self, _message):
        pass

    info = debug

    def warning(self, message):
        if re.search(r"sign in|captcha|confirm you.re not a bot|429|rate.limit", message, re.I):
            self.blocked = True

    error = warning


def options(logger):
    return dict(quiet=True, logger=logger, socket_timeout=15, retries=0,
                extractor_retries=0, fragment_retries=0, noplaylist=True,
                js_runtimes={"node": {}}, cachedir=False, ignoreconfig=True)


def list_channel(channel):
    logger = SafeLogger()
    try:
        with yt_dlp.YoutubeDL({**options(logger), "extract_flat": "in_playlist", "playlistend": 40}) as ydl:
            info = ydl.extract_info(channel["url"], download=False)
        if info.get("channel_id") != channel["id"]:
            raise MediaError("invalid_channel")
        return [entry for entry in info.get("entries", []) if VIDEO_ID.fullmatch(entry.get("id", ""))]
    except Exception as exc:
        raise MediaError("access_blocked" if logger.blocked else "fetch_failed") from exc


def metadata(video_id, expected_channel):
    if not VIDEO_ID.fullmatch(video_id):
        raise MediaError("invalid_media")
    logger = SafeLogger()
    try:
        with yt_dlp.YoutubeDL(options(logger)) as ydl:
            info = ydl.extract_info("https://www.youtube.com/watch?v=" + video_id, download=False)
        if info.get("channel_id") != expected_channel or info.get("id") != video_id:
            raise MediaError("invalid_media")
        return info
    except MediaError:
        raise
    except Exception as exc:
        raise MediaError("access_blocked" if logger.blocked else "fetch_failed") from exc


def download(job, folder):
    video_id = job["video_id"]
    info = metadata(video_id, job["channel_id"])
    if not 5 <= (info.get("duration") or 0) <= 600 or info.get("is_live") or info.get("live_status") == "is_upcoming":
        raise MediaError("invalid_media")
    logger = SafeLogger()
    try:
        def size_guard(progress):
            if progress.get("downloaded_bytes", 0) > MAX_BYTES:
                raise MediaError("too_large")

        # Prefer a complete progressive MP4. Do not fetch a silent video-only
        # stream, truncate the trailer, or use cookies to bypass access checks.
        opts = {**options(logger), "format": "best[ext=mp4][height<=480][vcodec!=none][acodec!=none]",
                "max_filesize": MAX_BYTES, "outtmpl": str(folder / "source.%(ext)s"),
                "progress_hooks": [size_guard]}
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.process_ie_result(info, download=True)
        source = folder / "source.mp4"
        if not source.is_file() or source.stat().st_size > MAX_BYTES:
            raise MediaError("too_large")
        target = folder / "trailer.mp4"
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error",
                                 "-i", str(source), "-map", "0:v:0", "-map", "0:a:0",
                                 "-c:v", "libx264", "-preset", "fast", "-crf", "25", "-maxrate", "450k", "-bufsize", "900k",
                                 "-vf", "scale=w='min(854,iw)':h=-2", "-pix_fmt", "yuv420p",
                                 "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(target)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=240)
        if result.returncode or not target.is_file() or target.stat().st_size < 1000:
            raise MediaError("invalid_media")
        if target.stat().st_size > MAX_BYTES:
            raise MediaError("too_large")
        return target
    except MediaError:
        raise
    except Exception as exc:
        raise MediaError("access_blocked" if logger.blocked else "download_failed") from exc


class API:
    def __init__(self, config):
        self.base = config["url"].rstrip("/")
        if not self.base.startswith("https://"):
            raise ValueError("HTTPS required")
        self.session = requests.Session()
        self.session.headers["Authorization"] = "Bearer " + config["secret"]

    def call(self, path, data=None):
        r = self.session.request("GET" if data is None else "POST", self.base + path,
                                 json=data, timeout=30, allow_redirects=False)
        r.raise_for_status()
        return r.json()

    def upload(self, video_id, path):
        with path.open("rb") as handle:
            # No transport retries: Telegram could have accepted an upload even
            # when the connection is lost. The Worker owns delivery recovery.
            r = self.session.post(self.base + "/media/upload/" + video_id, data=handle,
                                  headers={"Content-Type": "video/mp4", "Content-Length": str(path.stat().st_size)},
                                  timeout=150, allow_redirects=False)
        if r.status_code not in (200, 202, 409, 429):
            r.raise_for_status()
        return r.json()


def run(api):
    state = api.call("/media/monitor")
    for channel in state["channels"]:
        try:
            entries = list_channel(channel)
            if not entries:
                raise MediaError("fetch_failed")
            known = set(channel["known"])
            items = []
            for entry in entries:
                video_id = entry["id"]
                if video_id in known:
                    continue
                # The first scan establishes a baseline without downloading
                # historical trailers or fetching their individual watch pages.
                if known and re.search(r"\b(trailer|teaser)\b", entry.get("title", ""), re.I):
                    entry = metadata(video_id, channel["id"])
                items.append({k: entry.get(k) for k in ("id", "title", "channel_id", "timestamp", "duration", "is_live", "live_status")}
                             | {"description": (entry.get("description") or "")[:6000]})
            if not items:
                # Keep heartbeat accurate when all recent items are known.
                items = [{"id": entry["id"], "title": entry.get("title", "")} for entry in entries[:1]]
            api.call("/media/scan", {"channel_id": channel["id"], "status": "ok", "items": items})
            print(json.dumps({"channel": channel["title"], "status": "ok", "new_items": len([x for x in items if x['id'] not in known])}))
        except MediaError as exc:
            api.call("/media/scan", {"channel_id": channel["id"], "status": "error", "items": [], "error": str(exc)})
            print(json.dumps({"channel": channel["title"], "status": str(exc)}))
            if str(exc) == "access_blocked":
                # Stop the platform attempt; no account, cookie or backend hop.
                return
    for job in api.call("/media/monitor")["jobs"][:1]:
        try:
            with tempfile.TemporaryDirectory(prefix="swbot-media-") as temp:
                path = download(job, Path(temp))
                result = api.upload(job["video_id"], path)
                print(json.dumps({"video_id": job["video_id"], "delivery": result}))
        except MediaError as exc:
            api.call("/media/failure", {"video_id": job["video_id"], "reason": str(exc)})
            print(json.dumps({"video_id": job["video_id"], "error": str(exc)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        run(API(json.loads(Path(args.config).read_text())))
    except Exception as exc:
        # requests exceptions may contain URLs; never log credentials or raw
        # third-party error responses to the service journal.
        print(json.dumps({"error": type(exc).__name__}))
        raise SystemExit(1)
