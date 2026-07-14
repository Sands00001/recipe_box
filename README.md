# Recipe Box

A home for every recipe — Gousto cards, handwritten notes, and well-used cookbook
pages — in one place, with ingredients converted between metric, imperial and
US cups, plus AI-assisted scanning and a "what can I make?" pantry search.

Built the same way as the drawings app: plain HTML/CSS/JS with no framework and
no build step, Supabase for auth/database/storage, Netlify for static hosting.

## What's here

```
recipe-box/
  index.html                        entry point
  style.css                         theme + layout
  app.js                            the whole SPA (views, auth, CRUD, pantry search)
  units.js                          metric/imperial/US-cups conversion engine
  config.example.js                 copy to config.js and fill in your Supabase keys
  supabase/
    migrations/0001_init.sql        full schema, RLS policies, pantry-match SQL function
    functions/extract-recipe/       edge function that reads a photo with Claude and
                                     returns structured recipe data
```

## 1. Create the Supabase project

I started connecting to your Supabase account via the connector in this chat,
but wasn't able to actually run the project-creation step from here in this
session — the connector showed as connected but its tools weren't reachable
yet. Easiest is to do this part yourself (5 minutes), then tell me and I can
pick back up for anything else:

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a
   **new project** (recommended: a separate project from the drawings app,
   e.g. named `recipe-box`).
2. Once it's provisioned, open the **SQL Editor** and paste in the contents of
   `supabase/migrations/0001_init.sql`, then run it. This creates all tables,
   indexes, RLS policies, the seed ingredient-density data, and the
   `match_recipes_by_pantry` search function.
3. Go to **Storage** and create a new bucket called `recipe-photos`. Make it
   **public** (same as the drawings app's `photos` bucket) so recipe images
   can be displayed directly by URL.
4. Go to **Authentication > Providers** and confirm email/password sign-in is
   enabled (it is by default).
5. Go to **Project Settings > API** and copy the **Project URL** and **anon
   public key** — you'll need them in step 3 below.

## 2. Set the AI extraction secret

The "Scan with AI" feature calls Claude's API from a Supabase Edge Function,
server-side, so your API key is never exposed in the browser.

1. Get an API key from [console.anthropic.com](https://console.anthropic.com)
   if you don't already have one.
2. Deploy the function and set the secret (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)):
   ```
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase functions deploy extract-recipe
   ```
   Each scan costs a small amount of API usage (a few cents per photo) — there's
   no way around that cost since it's genuinely calling the model.

## 3. Configure and run locally

1. `cp config.example.js config.js`
2. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` from step 1.5 above.
3. Open `index.html` directly in a browser, or serve the folder with any static
   file server (e.g. `npx serve .`) — no build step needed.
4. Create your account on the sign-in screen and start adding recipes.

## 4. GitHub + Netlify (when you're ready)

1. Create a new GitHub repo (e.g. `recipe-box`) and push this folder to it.
   `config.js` is gitignored on purpose — don't commit your Supabase keys.
2. In Netlify, "Add new site > Import from Git", point it at the repo, no
   build command needed (publish directory = `/`).
3. Since `config.js` is gitignored, add its two values as a small inline
   script in Netlify's site settings, or simplest: just commit `config.js`
   anyway — the anon key is safe to expose publicly (it only has the access
   your RLS policies grant it), same as the drawings app does.
4. You mentioned Netlify build limits are currently tight — this site has no
   build step at all (it's static files), so it should use effectively zero
   build minutes; it'll just be a new site alongside the drawings one.

## Using it across your devices

Since it's just a website (no app-store install), any device with a modern
browser can use it — Mac, Windows, iPhone, iPad, Android — once it's deployed
and you're signed in. All your recipes live in Supabase, not on any one
device, so everything you add from one device shows up on the others
immediately.

A few practical notes:
- **Add to Home Screen** works on iPhone/iPad (Safari: Share > Add to Home
  Screen) and Android (Chrome: menu > Add to Home screen/Install app) — it'll
  get its own icon and open full-screen like an app, no browser chrome. I
  added a manifest + icon for this.
- **Camera capture** on the add/edit form opens your camera directly on
  phones; on a desktop/laptop it just opens a normal file picker, so you'd
  upload a photo you've already taken or a scan instead.
- **Layout** is responsive — I added phone-width breakpoints so the filters,
  ingredient rows, and recipe grid stack sensibly on a small screen rather
  than the desktop 3-4-column layout.
- **Share to Reminders/Notes** (from the shopping list) uses the native share
  sheet, which exists on iOS/iPadOS Safari and Android Chrome; on desktop
  browsers that don't support it, the Copy to clipboard button is the
  fallback and always works.
- It needs an internet connection — there's no offline mode. Everything reads
  and writes to Supabase live.

## How the pieces work

**Categorisation.** Each recipe gets a `diet` (none/vegetarian/vegan) and a
`source` (Gousto/handwritten/book/etc.) directly on the record, plus free-form
`meal_type` (main meal, dessert, side…) and `main_ingredient` (chicken, beef…)
tags in a separate table, so a recipe can carry several of each.

**Unit conversion.** Every ingredient is stored once, in whatever unit you
entered it in, and `units.js` pre-computes all three representations (metric,
imperial, US cups) at save time. Weight↔weight and volume↔volume conversions
are exact maths. Converting a solid between weight and cups needs a *density*
(how many grams a cup of flour vs. sugar vs. butter weighs) — the migration
seeds `ingredient_density_reference` with common baking ingredients; anything
not in that table falls back to a weight-based estimate flagged "(approx.)"
in the ingredient list, and you can always hand-edit any of the three values.
Each recipe also has its own `preferred_unit_system` so the detail view opens
showing the units you actually want for that recipe, with a toggle to switch.

**Photo capture, cropping and rotation.** The file input accepts a live camera
capture or an existing photo (or several at once — selecting multiple files
from the same folder queues each photo for its own crop step, one after the
other, and adds any PDFs straight away), then opens a crop tool (Cropper.js)
with rotate left/right buttons before it's attached — handy for a photo taken
sideways. If a page has both instructions and a picture on it and you want a
tighter/different crop of just the picture for the thumbnail, use "Crop
again" on that photo's card — it reopens the crop tool on the same original
image (defaulting the new crop to become the thumbnail) instead of making
you select the file from disk a second time. A recipe can have any number of
photos (e.g. front and back of a Gousto card, or two cookbook pages): each
one shows in a small list on the edit form where
you pick which single photo is the **thumbnail** (shown on cards and the
detail header) and tick which photo(s) to **include in the next AI scan** —
the thumbnail and the scan photos don't have to be the same picture, and a
scan can use more than one photo at once (e.g. ingredients on one page,
method on another) so the two get combined into one recipe.

**Shopping list.** Tick the checkbox on any number of recipe cards in Browse
and a "Create shopping list" bar appears; it combines every ingredient across
the selected recipes, summing quantities (weight-with-weight, volume-with-
volume, and weight-with-volume for the same ingredient if a density is known,
e.g. "200g flour" + "1 cup flour" → one combined total) into a single unit
system you can toggle between metric/imperial/US cups. You get a checkable
on-screen list plus a plain-text version with a Copy button and a Share
button (uses the iOS/Safari share sheet — pick Reminders, Notes, Messages,
or whatever you have installed) so it's easy to get onto your iPhone's to-do
app.

**AI scanning.** "Scan with AI" sends the selected photo(s) and/or PDF(s) to
the `extract-recipe` edge function, which asks Claude to transcribe title,
ingredients with quantities/units, prep/cook time, oven temperature
(°C/°F/gas mark), method, and best-guess meal type / main ingredients / diet.
The file picker on the edit form also accepts PDFs (e.g. an exported recipe
or a scanned document) — a PDF can be ticked for scanning like a photo, but
can't be the card thumbnail, since there's no single image to show. There's
also a "paste recipe text" box on the same form — handy for a recipe you've
found on a web page: copy the text and paste it in instead of taking a
screenshot or saving a PDF, and Scan with AI reads that too (you can combine
pasted text with photos in the same scan if you want). Everything it fills in
is editable before you save — it's a first draft, not the final word,
especially on handwriting.

**Meal planner.** The Planner view is a Monday–Sunday grid with a
breakfast/starter/lunch/dinner/dessert row per day. Each slot can hold more
than one dish — handy for a bigger occasion with a starter, a main, one or
two sides, and a dessert all under the same meal. Clicking "+ Add" on any
slot — or the general "Add a meal" button above the grid — opens a
filterable picker instead of a long alphabetical list: narrow by meal type,
main ingredient, or diet (using the same tags you already add to recipes),
then click Add (or double-click) on the recipe you want. The picker stays
open after each pick so you can plan several meals in one sitting, and its
Day/Meal dropdowns let you redirect each pick to a different slot without
reopening it. Remove any one dish from a slot with its × button — the rest
stay put. Use the arrows to flip to the previous/next week. A "Create
shopping list from this week" button feeds every distinct recipe assigned
that week straight into the same shopping-list feature described above. You
can also add a recipe to the plan straight from its detail page — the "Add
to Planner" button there prompts for any date and meal slot, no need to go
find it in the grid first. (Sending the plan to your phone's calendar isn't
built yet — that's a separate piece for later if you want it.)

**Pantry search.** The "What can I make?" view lets you list what you've got
on hand; `match_recipes_by_pantry` (a Postgres function using fuzzy text
matching via `pg_trgm`) ranks your recipes by what fraction of their
ingredients you already have.

## Known limitations / next steps

- Ingredient name matching (for both density lookup and pantry search) is
  simple fuzzy text matching, not a real food-ontology — "chicken breast" and
  "chicken thighs" won't automatically know they're both "chicken". Good
  enough for a personal recipe box, but worth knowing.
- The density reference table only covers common baking ingredients. Add more
  rows to `ingredient_density_reference` any time you hit an "(approx.)" you'd
  like to be exact.
- AI extraction quality on handwritten cards will vary more than on printed
  Gousto cards — always worth a quick proofread pass.
