# Colmeia

A personal organizer -- agenda (calendar), to-dos, and notes/links, with the
ability to "clip" a saved note or link onto a reminder.

## What's in this folder

```
index.html        the app shell
styles.css        all styling
app.js            all app logic
manifest.json     PWA manifest (Add to Home Screen)
sw.js             service worker (offline support)
icons/            app icons
```

This is a fully static site -- no build step, no server required.

## Deploying

This is a fully static site (plain HTML/CSS/JS, no React, no build step) --
any static host works. Below are full step-by-step instructions for the two
most common options.

---

### Option A: Netlify, drag-and-drop (no account setup needed beyond signup, easiest for a first deploy)

1. Go to **https://app.netlify.com** and sign up / log in (GitHub, GitLab, email -- any works)
2. Once logged in, you'll land on your team's dashboard. Look for a box that
   says **"Want to deploy a new site without connecting to Git?"** with a
   dashed drop-zone underneath it
3. Unzip this package on your computer first, so you have a plain folder
   called `site` (not the `.zip`)
4. Drag the whole `site` **folder** onto that drop-zone (drag the folder
   itself, not individual files inside it)
5. Netlify uploads it and gives you a live URL immediately, like
   `https://random-name-123.netlify.app`
6. Open that URL on your phone and test "Add to Home Screen" -- the honeycomb
   icon should show up
7. **Optional -- rename the URL:** Site settings -> "Change site name" ->
   pick something like `colmeia` (subject to availability) -> your URL
   becomes `https://colmeia.netlify.app`
8. **Optional -- custom domain:** Site settings -> Domain management ->
   "Add a domain" -> follow the DNS instructions if you own a domain

**To update the site later:** unzip your updated files again and drag the
folder onto the same site's "Deploys" tab -- it replaces the live version.

---

### Option B: Netlify via GitHub (recommended once you're iterating often, since every push auto-deploys)

1. Create a new repository on **https://github.com** (e.g. `colmeia`)
2. Push this folder's contents to that repo:
   ```
   cd site
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/colmeia.git
   git push -u origin main
   ```
3. In Netlify: **"Add new site"** -> **"Import an existing project"** ->
   **"Deploy with GitHub"** -> authorize Netlify -> pick the `colmeia` repo
4. Build settings: leave **Build command blank** and **Publish directory** as
   `.` (this is a static site, nothing to build)
5. Click **Deploy** -- you get the same kind of live URL as Option A
6. From now on, any `git push` to `main` automatically redeploys the live site

---

### Option C: Vercel via CLI

1. Install Node.js if you don't have it already (https://nodejs.org)
2. Install the Vercel CLI:
   ```
   npm install -g vercel
   ```
3. From inside the unzipped `site` folder, run:
   ```
   vercel
   ```
4. It'll ask you to log in (opens a browser) the first time
5. Answer the setup questions:
   - "Set up and deploy?" -> **Yes**
   - "Which scope?" -> pick your account
   - "Link to existing project?" -> **No**
   - "What's your project's name?" -> `colmeia` (or anything)
   - "In which directory is your code located?" -> `./` (press Enter)
   - It will detect no framework -- that's correct, confirm/continue
6. Vercel deploys and prints a live URL in the terminal
7. **To go live on your permanent URL:** run `vercel --prod` (the first
   command deploys a preview link; this one promotes it to production)

**To update the site later:** just run `vercel --prod` again from the folder
after making changes.

---

### Option D: Vercel via GitHub (same idea as Netlify's Git option)

1. Push the folder to a GitHub repo (see the `git` steps in Option B)
2. Go to **https://vercel.com** -> **"Add New" -> "Project"** -> import the
   repo from GitHub
3. Framework preset: choose **"Other"** (there's no framework here)
4. Build command: leave blank. Output directory: `.`
5. Click **Deploy**
6. From now on, every push to `main` auto-deploys

---

Either platform's free tier is plenty for a personal app like this one.

## Adding GT America

Once you have the licensed font files:
1. Drop them in a new `fonts/` folder here
2. In `styles.css`, add near the top:
   ```css
   @font-face{
     font-family:'GT America';
     src:url('fonts/GT-America-Regular.woff2') format('woff2');
     font-weight:400;
   }
   @font-face{
     font-family:'GT America';
     src:url('fonts/GT-America-Bold.woff2') format('woff2');
     font-weight:700;
   }
   ```
3. Replace `'Space Grotesk',sans-serif` with `'GT America',sans-serif` in the
   heading rules (`.view-title`, `.month-nav .month-label`, `.grid-weekdays div`, `.day-num`, `.day-label`)

Double-check your GT America license covers self-hosted web embedding on
whatever domain this ends up on.

## Data storage -- current state and the planned next step

Right now the app saves everything to the browser's `localStorage`, through a
small adapter at the top of `app.js`:

```js
const Storage = {
  async get(key){ ... },
  async set(key, value){ ... }
};
```

Every read/write in the app goes through `Storage.get` / `Storage.set` only --
nothing else touches localStorage directly. That's intentional: it means
adding real accounts and cross-device sync later is a matter of swapping the
*inside* of those two functions to call Supabase instead, without touching
any of the UI or feature code.

**Reminder for that step (not done yet):** the plan discussed earlier was
Supabase, with `events` / `tasks` / `notes` tables, row-level security so each
user only sees their own rows, and magic-link email login. Ping me when
you're ready to build that part and I'll wire it into this same `Storage`
adapter.

## Known limitations of this version
- No real push notifications (in-app only, while the tab is open)
- No cross-device sync yet (localStorage is per-browser, per-device)
- Auto-fetch of link titles isn't possible client-side (CORS); falls back to
  the URL's domain name if you leave the title blank
