"""
Fetches detail pages from Stadsarchief Almere and extracts scan (image) data
and attribution metadata embedded in the page's data-scans JSON attribute.
"""

import json
import re
import time
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://digitaalerfgoed.almere.nl"
DETAIL_URL = BASE_URL + "/detail.php"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
    "Referer": BASE_URL + "/",
}


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS)
    # Warm up session with a homepage visit to pick up any session cookies
    try:
        session.get(BASE_URL + "/", timeout=15)
    except requests.RequestException:
        pass
    return session


def fetch_detail(record_id: int, session: requests.Session | None = None) -> dict | None:
    """
    Fetch a detail page and return a dict with:
      - 'scans': list of scan objects from data-scans JSON
      - 'meta': page-level metadata (title, creator, date, collection, inventory_nr)
      - 'attribution': formatted attribution string
      - 'ark_url': persistent ARK URL
      - 'source_url': canonical detail page URL
    Returns None if the page cannot be fetched or has no scan data.
    """
    if session is None:
        session = make_session()

    url = f"{DETAIL_URL}?id={record_id}"
    try:
        resp = session.get(url, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"[scraper] ERROR fetching id={record_id}: {e}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    scans = _extract_scans(soup)
    meta = _extract_meta(soup, record_id)

    if not scans:
        print(f"[scraper] No scan data found for id={record_id}")
        return None

    print(f"[scraper] id={record_id}: found {len(scans)} scan(s), ViewerUrl={scans[0].get('ViewerUrl', 'N/A')}")

    return {
        "scans": scans,
        "meta": meta,
        "attribution": _build_attribution(meta),
        "ark_url": f"https://n2t.net/ark:/65671/ALM_{record_id}",
        "source_url": url,
    }


def _extract_scans(soup: BeautifulSoup) -> list[dict]:
    """Extract the data-scans JSON attribute from the DOM."""
    element = soup.find(attrs={"data-scans": True})
    if not element:
        return []
    try:
        raw = element.get("data-scans", "[]")
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []


def _extract_meta(soup: BeautifulSoup, record_id: int) -> dict:
    """Scrape page-level descriptive metadata."""
    meta = {
        "record_id": record_id,
        "title": "",
        "creator": "",
        "date": "",
        "collection": "",
        "inventory_nr": "",
        "description": "",
    }

    # Title is usually in <h1> or <title>
    h1 = soup.find("h1")
    if h1:
        meta["title"] = h1.get_text(strip=True)
    else:
        title_tag = soup.find("title")
        if title_tag:
            meta["title"] = title_tag.get_text(strip=True)

    # Detail rows are typically in a definition list or table
    # Try <dt>/<dd> pairs first
    dts = soup.find_all("dt")
    for dt in dts:
        label = dt.get_text(strip=True).lower()
        dd = dt.find_next_sibling("dd")
        if not dd:
            continue
        value = dd.get_text(strip=True)
        if "maker" in label or "vervaardiger" in label or "fotograaf" in label or "creator" in label:
            meta["creator"] = value
        elif "datering" in label or "datum" in label or "period" in label or "jaar" in label:
            meta["date"] = value
        elif "collectie" in label or "archief" in label or "bestand" in label:
            meta["collection"] = value
        elif "inventaris" in label or "inv.nr" in label or "id-nummer" in label:
            meta["inventory_nr"] = value
        elif "beschrijving" in label or "omschrijving" in label or "description" in label:
            meta["description"] = value

    # Fallback: look for table rows
    if not meta["creator"] and not meta["date"]:
        for row in soup.find_all("tr"):
            cells = row.find_all(["th", "td"])
            if len(cells) >= 2:
                label = cells[0].get_text(strip=True).lower()
                value = cells[1].get_text(strip=True)
                if "maker" in label or "fotograaf" in label:
                    meta["creator"] = value
                elif "datering" in label or "datum" in label:
                    meta["date"] = value
                elif "inventaris" in label or "inv" in label:
                    meta["inventory_nr"] = value

    # Try to find inventory number in hidden inputs
    inv_input = soup.find("input", {"name": re.compile(r"inv|xmlid|detail_id", re.I)})
    if inv_input and not meta["inventory_nr"]:
        meta["inventory_nr"] = inv_input.get("value", "")

    return meta


def _build_attribution(meta: dict) -> str:
    """Build a citation string as required by Stadsarchief Almere."""
    parts = ["Stadsarchief Almere"]
    if meta.get("collection"):
        parts.append(meta["collection"])
    if meta.get("inventory_nr"):
        parts.append(f"inv.nr. {meta['inventory_nr']}")
    if meta.get("title"):
        parts.append(meta["title"])
    if meta.get("date"):
        parts.append(meta["date"])
    if meta.get("creator"):
        parts.append(meta["creator"])
    return ", ".join(parts)


if __name__ == "__main__":
    session = make_session()
    result = fetch_detail(12185, session)
    if result:
        print("\n--- METADATA ---")
        print(json.dumps(result["meta"], indent=2, ensure_ascii=False))
        print("\n--- ATTRIBUTION ---")
        print(result["attribution"])
        print("\n--- SCANS (first entry) ---")
        print(json.dumps(result["scans"][0], indent=2, ensure_ascii=False))
