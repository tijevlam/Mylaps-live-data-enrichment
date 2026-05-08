#!/usr/bin/env python3
"""
Almere Archive Fetcher — CLI entry point.

Usage:
    python main.py search <query>           Search archive, save IDs to data/search_ids.json
    python main.py fetch <id> [id ...]      Fetch and download specific record(s)
    python main.py download-all             Download all IDs from data/search_ids.json
    python main.py viewer                   Open the HTML gallery in the default browser
"""

import json
import sys
import webbrowser
from pathlib import Path

DATA_DIR = Path("data")
SEARCH_IDS_FILE = DATA_DIR / "search_ids.json"


def cmd_search(args: list[str]) -> None:
    if not args:
        print("Usage: python main.py search <query>")
        sys.exit(1)

    from navigator import search
    from scraper import make_session

    query = " ".join(args)
    print(f"Searching for: '{query}'")
    session = make_session()
    ids = search(query, only_with_images=True, session=session)

    DATA_DIR.mkdir(exist_ok=True)
    with open(SEARCH_IDS_FILE, "w") as f:
        json.dump(ids, f, indent=2)

    print(f"\nFound {len(ids)} records with images.")
    print(f"IDs saved to {SEARCH_IDS_FILE}")
    print(f"IDs: {ids}")


def cmd_fetch(args: list[str]) -> None:
    if not args:
        print("Usage: python main.py fetch <id> [id ...]")
        sys.exit(1)

    from downloader import download_all, ensure_dirs

    try:
        ids = [int(x) for x in args]
    except ValueError:
        print("Error: IDs must be integers")
        sys.exit(1)

    ensure_dirs()
    download_all(ids)


def cmd_download_all(_args: list[str]) -> None:
    from downloader import download_all, ensure_dirs

    if not SEARCH_IDS_FILE.exists():
        print(f"No search IDs file found at {SEARCH_IDS_FILE}.")
        print("Run 'python main.py search <query>' first.")
        sys.exit(1)

    with open(SEARCH_IDS_FILE) as f:
        ids = json.load(f)

    print(f"Downloading {len(ids)} records...")
    ensure_dirs()
    download_all(ids)


def cmd_viewer(_args: list[str]) -> None:
    viewer_path = Path(__file__).parent / "viewer.html"
    if not viewer_path.exists():
        print("viewer.html not found.")
        sys.exit(1)

    url = viewer_path.resolve().as_uri()
    print(f"Opening gallery: {url}")
    webbrowser.open(url)


COMMANDS = {
    "search": cmd_search,
    "fetch": cmd_fetch,
    "download-all": cmd_download_all,
    "viewer": cmd_viewer,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(0 if len(sys.argv) < 2 else 1)

    cmd = sys.argv[1]
    args = sys.argv[2:]
    COMMANDS[cmd](args)


if __name__ == "__main__":
    main()
