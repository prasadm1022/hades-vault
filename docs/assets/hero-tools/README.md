# README hero tools

`docs/assets/hades-hero.webp` is an animated WebP made from a short video (1280x720, about 10 s) of a
digital wireframe head. These tools turn such a video into the banner, with the HADES name and
tagline drawn into every frame. They need only Node.js and a browser; no ffmpeg.

1. Copy the source video into this folder as `in.mp4` (it is not committed).
2. Start the local server (it serves this folder and saves uploaded frames into `frames/`):

   ```bash
   node docs/assets/hero-tools/server.cjs
   ```

3. Open `http://127.0.0.1:4176/capture.html?fps=10&q=0.55&scale=0.75` and wait until the tab title
   says `done`. Useful parameters:
   - `preview=<seconds>`: draw one frame only, to check the layout;
   - `ox`, `oy`: where the video's top-left corner lands on the 1280x640 banner (default 150, -50);
   - `fade`: seconds cross-faded from the end into the start, so the loop has no jump (default 0.6);
   - `fps`, `q` (WebP quality 0-1), `scale` (0.75 = 960x480).
4. Mux the frames into one looping animated WebP:

   ```bash
   node docs/assets/hero-tools/mux-webp.mjs docs/assets/hero-tools/frames 10 docs/assets/hades-hero.webp
   ```

Keep the result under about 3 MB so the README loads quickly. `docs/assets/social-preview.png` is a
single 1280x640 frame, for GitHub's Settings > General > Social preview.
