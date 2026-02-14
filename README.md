# HTML2Figma (Open Source)

Convert any live webpage into editable Figma layers. This tool scrapes a website's computed styles and layout structure, then imports it directly into Figma.

> **⚠️ Disclaimer:** This project is currently in **Beta**. It is not fully stable and you may encounter quality issues, missing elements, or imperfect conversions. Contributions and bug reports are welcome!

## Features

- **Full Page Scrape:** Captures the entire DOM structure.
- **Computed Styles:** Extracts colors, fonts, borders, shadows, and gradients.
- **Images & SVGs:** Imports regular images, background images, and inline SVGs.
- **Auto-Layout:** Attempts to map HTML structure to Figma Frames (WIP).

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/yourusername/HTML2Figma.git
    cd HTML2Figma
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # This installs Puppeteer for scraping
    ```

## Usage

### Step 1: Scrape a Website

Run the scraper script to generate a `design.json` file from any URL.

```bash
# Default (scrapes localhost:5173)
npm run scrape

# Custom URL
node scrape.js https://example.com

# Custom Viewport
node scrape.js https://example.com 1920 1080
```

This will create a `design.json` file in your project root.

### Step 2: Import into Figma

1.  Open **Figma**.
2.  Go to **Plugins** > **Development** > **Import plugin from manifest...**
3.  Select the `manifest.json` file located in the `plugin/` folder of this repository.
4.  Run the **HTML to Figma** plugin.
5.  Click the upload area and select your generated `design.json` file.
6.  Click **Import to Figma**.

## Troubleshooting

-   **Missing fonts?** Ensure you have the fonts locally or that Figma has access to them.
-   **Layout broken?** Complex CSS setups (Grid, some Flexbox edge cases) might not translate perfectly yet.
-   **Images not loading?** The scraper tries to fetch base64 data, but some CORS policies might block it depending on the site.

## License

MIT License. Free to use and modify.
