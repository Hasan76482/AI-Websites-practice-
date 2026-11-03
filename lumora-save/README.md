# Lumora Save

Video and reel downloader for public links from Instagram, YouTube, TikTok, Facebook, LinkedIn and Snapchat. No API keys needed.

## Run it

You need [Node.js](https://nodejs.org). Open a terminal in this folder, then run:

```bash
npm install
npm start
```

`npm install` also downloads yt-dlp and ffmpeg, about 100 MB in total, so the first run can take several minutes.

Open http://localhost:3000. Opening `public/index.html` directly won't work, because the page needs the server.

## If links start failing

Platforms change often. Update the downloader with:

```bash
npm run update-downloader
```

Only download content you own or have permission to save.
