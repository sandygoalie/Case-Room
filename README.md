# Case Room (self-hosted)

Live AI case-interview practice, hosted on your own Vercel project. Unlike the
claude.ai artifact version, this one:

- Needs no Claude account, no sharing roles, no "contributor" access — anyone
  with the URL can open it.
- Lets each person paste their **own** API key for a **free-tier** AI
  provider — Google Gemini, Groq, OpenRouter, Cerebras, Mistral, or NVIDIA
  NIM — nothing runs on your account or your bill.
- Supports real **microphone dictation** (impossible inside a claude.ai
  artifact, which blocks mic access outright) — browsers can finally ask for
  mic permission properly here.

## What's in this folder

```
case-room-vercel/
  api/chat.js       <- serverless function: proxies one request to whichever
                        provider the caller picked, using the key they sent
  public/
    index.html       <- the whole app (UI, state, rendering — one file)
    cases.json        <- 744-case book, trimmed to the fields the app uses
    institutes.json
    categories.json
  package.json
  vercel.json
```

No npm dependencies — `api/chat.js` uses Node's built-in `fetch`, so there's
nothing to `npm install`.

## Deploy it (first time)

You'll need a free Vercel account (vercel.com — sign up with GitHub, GitLab,
or email) and the Vercel CLI, or you can skip the CLI entirely and deploy
via GitHub instead. Pick one:

### Option A — Vercel CLI (fastest if you're on a machine with Node installed)

```bash
npm install -g vercel     # one-time
cd case-room-vercel
vercel login               # opens a browser to authenticate
vercel --prod               # deploys and prints your live URL
```

That's it — `vercel --prod` both creates the project (first run asks a few
setup questions; accept the defaults) and deploys it. Re-run `vercel --prod`
any time you change the code to redeploy.

### Option B — GitHub + Vercel dashboard (no CLI, no local Node needed)

1. Create a new **empty** GitHub repo (e.g. `case-room`).
2. Push this folder's contents to it:
   ```bash
   cd case-room-vercel
   git init
   git add .
   git commit -m "Case Room"
   git branch -M main
   git remote add origin https://github.com/<you>/case-room.git
   git push -u origin main
   ```
3. Go to vercel.com → **Add New → Project** → import that GitHub repo.
4. Leave the framework preset as **Other** (no build command needed) and
   click **Deploy**.
5. Vercel gives you a URL like `https://case-room-yourname.vercel.app` —
   that's the link to share.

With this option, every future `git push` to `main` auto-redeploys.

## Using it

1. Open the deployed URL.
2. Pick a provider and paste a free API key:
   - **Gemini**: aistudio.google.com/apikey — sign in with any Google
     account, generate a key, no card required.
   - **Groq**: console.groq.com/keys — free account, fast open-weight models.
   - **OpenRouter**: openrouter.ai/keys — gives access to several labs'
     `:free`-suffixed models through one key.
   - **Cerebras**: cloud.cerebras.ai — free account, very fast inference.
   - **Mistral**: console.mistral.ai/api-keys — free tier on La Plateforme.
   - **NVIDIA NIM**: build.nvidia.com — free account, hosted open models.
3. Pick a case (book / AI-generated / AI remix) and start the interview.

If one provider is overloaded (the occasional "high demand, try again" error
some free tiers return under load), switching providers in the dropdown is
the fastest workaround — each one has entirely separate quota.

Each person who opens the link pastes their **own** key, stored only in
their own browser's `localStorage` — it's sent to this site's own `/api/chat`
function on each request and passed straight through to the provider; it is
never logged, written to a database, or visible to you as the host.

## What's different from the claude.ai artifact version

| | claude.ai artifact | this (self-hosted) |
|---|---|---|
| AI calls | Anthropic, billed to each viewer's Claude account | your choice of free-tier provider, billed to whoever's key is entered |
| History | Claude's `db` capability, per-account | browser `localStorage`, per-device (not synced across devices) |
| Downloads | Claude's `downloads` capability | plain browser download |
| Microphone dictation | **blocked** by the artifact sandbox, no exception | **works** — real `SpeechRecognition`, browser asks permission normally |
| Sharing | needed Claude sign-in + share-role juggling | just a URL |

The history tradeoff is the one worth knowing: since there's no account
system here, "Past interviews" lives in whatever browser you used, on
whatever device you used it on. If that's a problem later, the natural next
step is adding a real database (Supabase/Firebase) with simple email sign-in
— that's a bigger addition, not something this version does.

## Model choices

`api/chat.js` maps each provider's three difficulty tiers to specific model
IDs (see `MODELS` at the top of that file). Free-tier model lineups change
over time — if a model gets deprecated or renamed, update the IDs there;
nothing else in the app needs to change.
