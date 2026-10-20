# Checkers

3D American checkers that runs in the browser on GitHub Pages:

- **Play the AI**: a value network trained here by self-play (TD-Leaf(λ)) with alpha-beta search, running in a Web Worker.
- **Play a friend**: serverless peer-to-peer via WebRTC. You send an invite link, your friend sends back a reply link, and the game connects directly. Only public STUN is used, so no game data goes through any server.
- **Training Lab**: an Elo curve over generations and replays of the AI's self-play games as it improved.

Live: https://duaneshaffer.github.io/checkers/

## Development

```sh
npm ci
npm run dev          # http://localhost:5173/checkers/  (POLL=1 npm run dev if edits are not picked up on /mnt/c)
npm test             # unit tests (PERFT_DEEP=1 for deep perft)
npm run e2e          # Playwright (npx playwright install chromium first)
npm run build
```

The dev server serves `public/training/**` straight from disk on every request (the `live-training-files` plugin in `vite.config.ts`), so output from a run with `--publish-every` appears on reload without restarting the server or setting `POLL=1`. `POLL=1` is still needed for source edits on `/mnt/c`, where file watching misses changes (including CSS).

## Training

```sh
npm run bench                       # measure throughput on this machine
npm run train -- --run main         # writes to ~/checkers-runs/main (CHECKERS_RUNS overrides)
npm run train:resume -- --run main  # resume after a stop; Ctrl+C finishes the current generation
npm run export -- --run main        # curate replays and nets into public/training (≤ 5 MB); --champion N overrides the shipped net
```

Commit `public/training/` and push to publish a new training history to the site.
