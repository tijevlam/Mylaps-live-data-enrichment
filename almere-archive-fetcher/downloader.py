"""
Bulk image downloader for Stadsarchief Almere archive records.

Fetches scan data for each record ID, downloads the image via ViewerUrl,
and persists attribution metadata to data/metadata.json.
"""

import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse, unquote
import requests
from scraper import fetch_detail, make_session

DATA_DIR = Path("data")
IMAGES_DIR = DATA_DIR / "images"
METADATA_FILE = DATA_DIR / "metadata.json"


def ensure_dirs() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def load_metadata() -> dict[str, dict]:
    if METADATA_FILE.exists():
        with open(METADATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_metadata(metadata: dict[str, dict]) -> None:
    with open(METADATA_FILE, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)


def download_record(
    record_id: int,
    session: requests.Session,
    metadata: dict[str, dict],
    delay: float = 1.5,
) -> bool:
    """
    Download all scans for a single record. Returns True if at least one
    image was downloaded or was already present.
    """
    key = str(record_id)

    detail = fetch_detail(record_id, session)
    if not detail:
        return False

    scans = detail["scans"]
    downloaded_files = []

    for i, scan in enumerate(scans):
        viewer_url = scan.get("ViewerUrl")
        if not viewer_url:
            print(f"[downloader] id={record_id} scan {i}: no ViewerUrl, skipping")
            continue

        # Resolve relative URLs
        if viewer_url.startswith("/"):
            from scraper import BASE_URL
            viewer_url = BASE_URL + viewer_url

        filename = _derive_filename(record_id, i, scan, viewer_url)
        dest = IMAGES_DIR / filename

        if dest.exists():
            print(f"[downloader] id={record_id} scan {i}: already downloaded ({filename})")
            downloaded_files.append(str(dest))
            continue

        print(f"[downloader] id={record_id} scan {i}: downloading {viewer_url}")
        image_path = _download_file(viewer_url, dest, session)

        if image_path:
            downloaded_files.append(str(image_path))
            print(f"[downloader] id={record_id} scan {i}: saved to {image_path}")
        else:
            print(f"[downloader] id={record_id} scan {i}: download FAILED")

        time.sleep(delay)

    # Update metadata regardless of download success so we have attribution
    metadata[key] = {
        "record_id": record_id,
        "meta": detail["meta"],
        "attribution": detail["attribution"],
        "ark_url": detail["ark_url"],
        "source_url": detail["source_url"],
        "scans": [
            {
                "ViewerUrl": s.get("ViewerUrl"),
                "IcoonUrl": s.get("IcoonUrl"),
                "DownloadUrl": s.get("DownloadUrl"),
                "MagDownloaden": s.get("MagDownloaden"),
                "IsImage": s.get("IsImage"),
                "Title": s.get("Title"),
                "Description": s.get("Description"),
                "Bestandsnaam": s.get("Bestandsnaam"),
            }
            for s in scans
        ],
        "local_files": downloaded_files,
    }

    return bool(downloaded_files)


def _derive_filename(record_id: int, scan_index: int, scan: dict, url: str) -> str:
    """Build a local filename from available scan metadata."""
    # Try the server-provided filename first
    bestandsnaam = scan.get("Bestandsnaam", "")
    if bestandsnaam:
        safe = _safe_name(bestandsnaam)
        return f"{record_id}_{scan_index}_{safe}"

    # Fall back to URL basename
    path = unquote(urlparse(url).path)
    basename = os.path.basename(path) or f"scan_{scan_index}.jpg"
    safe = _safe_name(basename)
    return f"{record_id}_{scan_index}_{safe}"


def _safe_name(name: str) -> str:
    """Strip unsafe characters from a filename."""
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in name)


def _download_file(
    url: str,
    dest: Path,
    session: requests.Session,
    max_retries: int = 3,
) -> Path | None:
    """Download `url` to `dest` with retry logic. Returns dest on success."""
    for attempt in range(1, max_retries + 1):
        try:
            with session.get(url, stream=True, timeout=30) as resp:
                if resp.status_code == 404:
                    print(f"[downloader] 404 for {url}, skipping")
                    return None
                resp.raise_for_status()

                content_type = resp.headers.get("Content-Type", "")
                # If response is HTML it's likely a viewer page, not a raw image
                if "text/html" in content_type:
                    print(f"[downloader] ViewerUrl returned HTML — may be a viewer wrapper, not a raw image")
                    print(f"[downloader] Try opening {url} in a browser to inspect the actual image URL")
                    return None

                with open(dest, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=8192):
                        f.write(chunk)
            return dest

        except requests.RequestException as e:
            wait = 2 ** attempt
            print(f"[downloader] Attempt {attempt} failed: {e}. Retrying in {wait}s...")
            time.sleep(wait)

    return None


def download_all(
    record_ids: list[int],
    delay: float = 1.5,
) -> None:
    """
    Download images for all provided record IDs.
    Skips records already present in metadata.json.
    """
    ensure_dirs()
    session = make_session()
    metadata = load_metadata()

    total = len(record_ids)
    success = 0

    for i, record_id in enumerate(record_ids, 1):
        print(f"\n[downloader] [{i}/{total}] Processing record id={record_id}")
        ok = download_record(record_id, session, metadata, delay=delay)
        if ok:
            success += 1
        save_metadata(metadata)  # Save after each record for resilience

    print(f"\n[downloader] Done. {success}/{total} records downloaded successfully.")
    print(f"[downloader] Metadata saved to {METADATA_FILE}")


if __name__ == "__main__":
    import sys

    ensure_dirs()
    if len(sys.argv) > 1:
        ids = [int(x) for x in sys.argv[1:]]
    else:
        ids = [12185]

    download_all(ids)
