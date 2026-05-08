"""
Searches the Stadsarchief Almere archive and collects record IDs.

The search form at /zoeken.php accepts POST requests. Results pages list
detail links from which record IDs are extracted.
"""

import re
import time
import requests
from bs4 import BeautifulSoup
from scraper import BASE_URL, HEADERS, make_session

SEARCH_URL = BASE_URL + "/zoeken.php"
DETAIL_ID_RE = re.compile(r"[?&]id=(\d+)")


def search(
    query: str,
    only_with_images: bool = True,
    session: requests.Session | None = None,
    delay: float = 1.5,
) -> list[int]:
    """
    Search the archive for `query` and return all matching record IDs.

    Args:
        query: Free-text search term (e.g. "triatlon")
        only_with_images: When True, filters to records that have multimedia attached
        session: Existing requests.Session (created if not provided)
        delay: Seconds to wait between page requests

    Returns:
        Sorted list of unique record IDs (integers)
    """
    if session is None:
        session = make_session()

    all_ids: set[int] = set()
    page_num = 1

    while True:
        print(f"[navigator] Fetching search page {page_num} for query='{query}'...")
        ids, has_next = _fetch_search_page(query, page_num, only_with_images, session)
        all_ids.update(ids)
        print(f"[navigator] Page {page_num}: {len(ids)} records found (total so far: {len(all_ids)})")

        if not has_next:
            break

        page_num += 1
        time.sleep(delay)

    return sorted(all_ids)


def _fetch_search_page(
    query: str,
    page: int,
    only_with_images: bool,
    session: requests.Session,
) -> tuple[list[int], bool]:
    """
    Fetch one page of search results. Returns (list_of_ids, has_next_page).
    """
    data = {
        "zoeken[velden][Vrij zoeken][waarde]": query,
        "zoeken[spellingsvariant]": "1",
        "pagina": page,
    }
    if only_with_images:
        data["zoeken[velden][Heeft Multimedia][waarde]"] = "1"

    try:
        resp = session.post(SEARCH_URL, data=data, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"[navigator] ERROR on page {page}: {e}")
        return [], False

    soup = BeautifulSoup(resp.text, "html.parser")
    ids = _extract_ids(soup)
    has_next = _has_next_page(soup, page)
    return ids, has_next


def _extract_ids(soup: BeautifulSoup) -> list[int]:
    """Extract record IDs from all detail links on a results page."""
    ids = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "detail.php" in href:
            match = DETAIL_ID_RE.search(href)
            if match:
                ids.append(int(match.group(1)))
    return ids


def _has_next_page(soup: BeautifulSoup, current_page: int) -> bool:
    """Detect whether a next-page link exists."""
    # Look for pagination links containing the next page number
    next_page = current_page + 1

    # Common patterns: link text "Volgende", page number, or pagina= param
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True).lower()
        if text in ("volgende", "next", ">", "»"):
            return True
        if f"pagina={next_page}" in href:
            return True

    # Also check for a form input with page info (some archives use forms)
    for inp in soup.find_all("input", {"name": re.compile(r"pagina|page", re.I)}):
        pass  # If we find a paginator input, assume more pages exist only if IDs were found

    return False


if __name__ == "__main__":
    import json

    session = make_session()
    ids = search("triatlon", only_with_images=True, session=session)
    print(f"\n[navigator] Found {len(ids)} total records: {ids}")
    with open("data/search_ids.json", "w") as f:
        json.dump(ids, f, indent=2)
    print("[navigator] Saved to data/search_ids.json")
