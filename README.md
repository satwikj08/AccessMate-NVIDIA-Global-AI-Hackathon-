# AccessMate

An accessibility-focused tool that explains documents in plain language and helps navigate websites with an AI browser agent, powered by NVIDIA NIM (Nemotron).

## Features

- **Document Q&A** — Upload a PDF, screenshot, or scanned image and ask questions. Nemotron reads the extracted text and gives grounded answers.
- **Browser Agent** — A Chrome extension that navigates websites step-by-step toward a goal you set, with human approval required for every sensitive action.
- **Text-to-Speech** — Hear answers read aloud using the browser's built-in speech synthesis.

## Folder Layout

```
project/
├── main.py                  ← FastAPI backend (document analysis, Q&A, browser agent)
├── requirements.txt
├── test_browser_agent.py    ← Unit tests for the browser agent planner
├── .env                     ← NVIDIA NIM API key and model (never commit this)
├── static/                  ← Web UI
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── icon.svg
└── extension/               ← Chrome extension (browser agent)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── sidepanel.html
    ├── sidepanel.css
    ├── sidepanel.js
    └── README.md
```

## Setup

### 1. Install dependencies

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

### 2. Configure NVIDIA NIM

Get an API key from [build.nvidia.com](https://build.nvidia.com) and create a `.env` file:

```env
NVIDIA_NIM_API_KEY=nvapi-YOUR_KEY_HERE
NVIDIA_NIM_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
```

### 3. Start the server

```bash
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Open **http://127.0.0.1:8000** to use the document Q&A web UI.

### 4. Install the Chrome extension (optional)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Navigate to any website, click the AccessMate icon, enter a goal, and click Start

## Safety

- The browser agent **never fills** password, payment, or other sensitive fields.
- Login, submit, delete, purchase, and similar actions **pause for human approval**.
- The model receives only the goal, page title/origin, and control labels — never page body text or field values.
- The agent runs at most 12 low-risk steps per run before pausing.
- Document Q&A is read-only and does not take any actions.

## Running Tests

```bash
python -m pytest test_browser_agent.py -v
```
