# Suma

![Dashboard](/screenshots/dashboard.png)

Desktop tool for generating structured summaries of PDF documents using Google Gemini. Drop files onto the app to get detailed, machine-readable summaries saved alongside your originals in your preferred format.

## Screenshots

<p align="center">
  <img src="/screenshots/prompt_editor.png" width="45%" alt="Prompt Editor" />
  <img src="/screenshots/settings.png" width="45%" alt="Settings" />
</p>

## Download

Get the latest release from [GitHub Releases](../../releases/latest):

| Platform | File |
|---|---|
| macOS | `.dmg` |
| Windows | `.exe` (NSIS installer) |
| Linux | `.deb` |

## Features

- **Multi-Prompt Management**: Create and switch between multiple prompt templates for different summary styles.
- **Top Bar Switcher**: Quickly change the active prompt directly from the main interface.
- **Custom Formats**: Set output extensions to .md, .txt, .csv, or .json for each template.
- **Interactive UI**: Click filenames to open PDFs or click output paths to reveal summaries in your file manager.
- **API Key Rotation**: Add multiple Gemini API keys to handle higher volumes through rotation.
- **Light and Dark Mode**: Native support for your system's color scheme.
- **Keyboard Shortcuts**: Use the Escape key to quickly close any modal.

## Usage

1. Open Suma
2. Click **Settings** to enter your [Google Gemini API keys](https://aistudio.google.com/app/apikey) and select your preferred model
3. Drag and drop PDF files or folders onto the window to start processing
4. Use the top bar dropdown to switch between active prompt templates
5. Click any filename to open the source PDF in your default viewer
6. Click any output path to open the folder where the summary is saved
7. Clear the list when finished, all summaries remain safely on your disk

## Build from source

**Prerequisites:** [Rust](https://rustup.rs) and [Bun](https://bun.sh)

**Linux, install system dependencies first:**
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
