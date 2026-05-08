# Almere Archive Fetcher

Fetches and downloads historical images from [Digitaal Erfgoed Almere](https://digitaalerfgoed.almere.nl) (Stadsarchief Almere) for offline use — with proper attribution as required by the archive.

## How the site works (reverse-engineered)

The archive displays images inside `<iframe>` elements. The iframe `src` is a `ViewerUrl` that comes from a `data-scans` JSON attribute embedded server-side in the detail page HTML. There is **no JavaScript-based right-click prevention or drag blocking** — the "protection" is:

1. The download button is hidden when the server sets `MagDownloaden: false`
2. Images are one level deep inside an iframe, making casual right-click saving less obvious

The actual image URL (`ViewerUrl`) is accessible directly once extracted from the `data-scans` attribute.

## Attribution requirement

Stadsarchief Almere requires naamsvermelding (name attribution) for all use of archival materials. The format used by this tool:

```
Stadsarchief Almere, {collection}, inv.nr. {id}, {title}, {date}, {creator}
```

Every downloaded image has a corresponding entry in `data/metadata.json` with the full attribution string and a persistent ARK URL (e.g. `https://n2t.net/ark:/65671/ALM_12185`).

## Setup

```bash
pip install -r requirements.txt
```

Python 3.10+ required (uses `X | Y` union type hints).

## Usage

```bash
# 1. Search for records with images
python main.py search triatlon

# 2. Bulk download all found records
python main.py download-all

# 3. Download a specific record by ID
python main.py fetch 12185

# 4. Open the offline HTML gallery
python main.py viewer
```

## Output structure

```
data/
├── search_ids.json     # Record IDs found by search
├── metadata.json       # Attribution metadata for all downloaded records
└── images/             # Downloaded image files (named {id}_{index}_{filename})
viewer.html             # Offline gallery — open in any browser
```

## Robots.txt note

The site's `robots.txt` blocks named AI crawlers but explicitly allows `Allow: /*detail.php` for `User-agent: *`. This tool uses a standard browser User-Agent and accesses only detail pages, with a 1.5-second delay between requests.

## License / disclaimer

This tool is for personal research use with proper attribution. All images remain the property of Stadsarchief Almere and their respective rights holders. Verify reproduction rights for your specific use case at [digitaalerfgoed.almere.nl](https://digitaalerfgoed.almere.nl).
