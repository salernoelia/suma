# Suma

![demo](/screenshots/demo_3.png)

Desktop tool for generating structured Markdown summaries of academic research papers using Google Gemini. Drop PDFs onto the app and get detailed, machine-readable summaries covering title, authors, methods, results, conclusions, and more — saved as `.md` files alongside the originals.

## Download

Get the latest release from [GitHub Releases](../../releases/latest):

| Platform | File |
|---|---|
| macOS | `.dmg` |
| Windows | `.exe` (NSIS installer) |
| Linux | `.deb` |

## Usage

1. Open Suma
2. Click **Settings** and enter your [Google Gemini API key](https://aistudio.google.com/app/apikey)
3. Drag and drop PDF files onto the window
4. Summaries are saved as `.md` files in a `summary/` folder next to each PDF
5. Use **Archive all** to clear the view once you're done — summaries stay accessible

## Build from source

**Prerequisites:** [Rust](https://rustup.rs) and [Bun](https://bun.sh)

**Linux — install system dependencies first:**
```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

**All platforms:**
```sh
bun install
bun run tauri build
```

## Stack

Tauri · React · TypeScript · Google Gemini API
