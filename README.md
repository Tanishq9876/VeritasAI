# Veritas — AI Misinformation Detection Platform

A web application that fact-checks WhatsApp forwards, viral claims, and news headlines using AI. Supports text, image, and video input with confidence scoring and source attribution.

## Live Demo

🔗 [veritasaifactchecker.netlify.app](https://veritasaifactchecker.netlify.app/)

## Features

- **Text Verification** — Paste any message or claim and get a verdict instantly
- **Image Verification** — Upload screenshots and let AI read and verify visible text
- **Video Verification** — Upload a video and AI extracts a frame to analyse on-screen claims
- **Confidence Scoring** — Every result includes a 0–100% reliability score
- **Claim Extraction** — Breaks down messages into individual verifiable statements
- **Source Attribution** — Links to authoritative sources like Reuters, WHO, BBC, PolitiFact
- **Rumour Pattern Detection** — Flags chain-message language, artificial urgency, and unverified authority claims
- **Check History** — Tracks all verified items in the current session

## Tech Stack

- React, JavaScript (ES6+)
- Groq AI API (LLaMA 3.3 70B)
- Canvas API (video frame extraction)
- FileReader API (image encoding)
- HTML5 Drag-and-Drop API
- Netlify Functions (serverless backend)
- Vite

## Getting Started

### Prerequisites
- Node.js v18+
- Groq API key — get one free at [console.groq.com](https://console.groq.com)

### Installation
```bash
git clone https://github.com/Tanishq9876/VeritasAI.git
cd veritas
npm install
```

### Add your API key

Create a `.env` file in the root:
```
GROQ_API_KEY=your_api_key_here
```

### Run locally
```bash
netlify dev
```

Open [http://localhost:8888](http://localhost:8888)

### Build for production
```bash
npm run build
```

## Usage

1. Open the app and select an input mode — **Text**, **Image**, or **Video**
2. Paste your message or upload a file
3. Click **Verify with Veritas**
4. Review the verdict, confidence score, extracted claims, and sources

## Project Structure
```
veritas/
  src/
    App.jsx          # Main application
    main.jsx         # Entry point
  netlify/
    functions/
      verify.js      # Serverless backend — Groq API proxy
  public/
  .env               # API keys (not committed)
  index.html
  vite.config.js
```
