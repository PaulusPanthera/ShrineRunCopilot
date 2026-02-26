# shrineruncopilot
A tool to run the Abundand Shrine Run for LNY Event in PokeMMO
Abundant Shrine — Roster Planner (alpha v13)

A local-first, browser-based planner for the Abundant Shrine challenge: build your roster, plan waves, track unlocked species, and quickly check one-shot / damage info from your active roster.

Built by [MÜSH] PaulusTFT
Runs fully in the browser — no backend, no accounts.

✨ Features

Waves tab: plan defenders per wave / phase

Roster tab: manage your active attackers / sets

Bag tab: track items/resources (if enabled in rules)

Unlocked tab: track discovered/available species

Attack Overview: click a defender/species to see one-shot info from your roster

Export / Import: move your planner state between devices

Reset: wipe state and start fresh

Local-first storage: saves automatically to localStorage

📦 Project structure

index.html — app shell / layout

styles.css — styling

calc.js — calc helpers / damage logic wrapper

src/main.js — entry point

src/app/app.js — main app logic (state, UI rendering, rules)

data/*.json — dex, moves, typing, rules, stages, slots, claimed sets

assets/bg.png — background

💾 Data & persistence

Your data is stored in your browser under:

localStorage key: abundantShrinePlanner_state_v13

Export downloads a JSON snapshot of your state

Import restores from that JSON snapshot

⚠️ If you clear browser storage/cache, your local state is gone unless you exported.

🚀 Run locally

Because this uses ES modules, open it via a local server (not file://).

Option 1: Python
python -m http.server 8000

Open: http://localhost:8000

Option 2: Node
npx serve
🌍 Deploy (GitHub Pages)

Push this repo to GitHub

Go to Settings → Pages

Under Build and deployment:

Source: Deploy from a branch

Branch: main

Folder: / (root)

Your site will be available at:

https://<username>.github.io/<repo-name>/

✅ Tip: If assets don’t load, make sure your paths are relative (this project is already set up that way).

🛠️ Editing rules / data

Most shrine rules live in:

data/rules.json

data/stages.json

data/calcSlots.json

data/claimedSets.json

Dex/moves/type data:

data/dex.json

data/moves.json

data/typing.json

📄 License

This project is licensed under the MIT License — see LICENSE.

🙌 Credits

Pokémon is © Nintendo / Game Freak / Creatures (this is a fan tool).

Sprites/data sources (if applicable): document here if you later want to attribute specific datasets/providers.
