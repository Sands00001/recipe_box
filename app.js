/**
 * Recipe Box — app.js
 * Vanilla JS SPA, no build step, no framework — same pattern as the drawings app:
 * a single #app div re-rendered via innerHTML, driven by a `currentView` string.
 */

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MEAL_TYPES = ['breakfast', 'starter', 'main meal', 'side', 'dessert', 'snack', 'baking'];
const DIETS = ['none', 'vegetarian', 'vegan'];
const SOURCES = ['gousto', 'handwritten', 'book', 'magazine', 'website', 'other'];
const PHOTO_BUCKET = 'recipe-photos';
const PLAN_SLOTS = ['breakfast', 'lunch', 'dinner']; // the weekly planner's meal slots — starter/dessert are just extra dishes under lunch/dinner now that a slot can hold more than one

let state = {
  user: null,
  currentView: 'loading',
  viewParams: {},
  recipes: [],
  densityMap: {},
  filters: { search: '', mealType: '', mainIngredient: '', diet: '', source: '', favoritesOnly: false, minRating: '' },
  pantryItems: [],
  pantryMatches: null,
  cropper: null, // active Cropper.js instance while the crop modal is open
  photoQueue: [], // images picked in a multi-select that still need cropping, one at a time
  selectedRecipeIds: new Set(), // recipes ticked in Browse, for the shopping list
  shoppingListEntries: [], // [{ recipeId, scale }] actually fed into loadShoppingList — scale is usually 1
  shoppingList: null, // { recipeTitles, system, lines } once generated
  shoppingListSystem: 'metric',
  mealPicker: null // { dateISO, slot, recipes, filters, status } while the planner's meal picker modal is open
};

const app = document.getElementById('app');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  if (!state.user) return renderAuth();
  const shell = `
    <div class="topbar">
      <h1><i class="ti ti-tools-kitchen-2"></i> Recipe Box</h1>
      <nav>
        <button onclick="goTo('browse')"><i class="ti ti-list"></i> Browse</button>
        <button onclick="goTo('edit', {id:'new'})"><i class="ti ti-plus"></i> Add Recipe</button>
        <button onclick="goTo('planner')"><i class="ti ti-calendar-week"></i> Planner</button>
        <button onclick="goTo('pantry')"><i class="ti ti-shopping-cart"></i> What can I make?</button>
        <button onclick="signOut()"><i class="ti ti-logout"></i></button>
      </nav>
    </div>
    <div class="container" id="view-root"></div>
  `;
  app.innerHTML = shell;
  const root = document.getElementById('view-root');

  if (state.currentView === 'browse') renderBrowse(root);
  else if (state.currentView === 'detail') renderDetail(root);
  else if (state.currentView === 'edit') renderEdit(root);
  else if (state.currentView === 'pantry') renderPantry(root);
  else if (state.currentView === 'shopping-list') renderShoppingList(root);
  else if (state.currentView === 'planner') renderPlanner(root);
  else root.innerHTML = '<p>Loading…</p>';
}

async function goTo(view, params = {}) {
  state.currentView = view;
  state.viewParams = params;
  updateUrlForView(view, params);
  if (view === 'browse') await loadRecipes();
  if (view === 'detail') await loadRecipeDetail(params.id);
  if (view === 'edit') await loadEditForm(params.id);
  if (view === 'pantry') await loadPantry();
  if (view === 'shopping-list') { render(); await loadShoppingList(); return; } // render loading state first, list fetch is async
  if (view === 'planner') await loadPlanner(params.weekStart || formatDateISO(getMonday(new Date())));
  render();
}

// ---------------------------------------------------------------------------
// Deep linking — sharing a recipe (e.g. the phone's native Share icon on the
// detail page) previously just shared the site's bare root URL, since the
// app never reflected which recipe you were viewing in the address bar.
// Reopening that link then bounced to sign-in and landed on Browse instead
// of the recipe. Reflecting the current recipe as a URL hash (no server-side
// routing needed on static hosting) and re-reading it after sign-in fixes
// both halves of that.
// ---------------------------------------------------------------------------

function updateUrlForView(view, params) {
  const newHash = view === 'detail' && params.id ? `#/detail/${params.id}` : '';
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash || (location.pathname + location.search));
  }
}

function parseDeepLinkFromHash() {
  const m = location.hash.match(/^#\/detail\/([0-9a-f-]+)$/i);
  return m ? { view: 'detail', id: m[1] } : null;
}

// Captured once when the script first loads (i.e. from whatever URL the
// share/bookmark/link opened), then consumed the first time we successfully
// sign in — whether that's an existing session or a fresh sign-in submitted
// from the login screen.
let pendingDeepLink = parseDeepLinkFromHash();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function renderAuth() {
  app.innerHTML = `
    <div class="auth-box">
      <h2><i class="ti ti-tools-kitchen-2"></i> Recipe Box</h2>
      <div class="field"><label>Email</label><input id="auth-email" type="email" /></div>
      <div class="field"><label>Password</label><input id="auth-password" type="password" /></div>
      <div id="auth-error" class="error-text"></div>
      <div class="field-row">
        <button class="btn-primary" onclick="signIn()">Sign in</button>
        <button onclick="signUp()">Create account</button>
      </div>
    </div>
  `;
}

async function signIn() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) return showAuthError(error.message);
  await bootAfterAuth();
}

async function signUp() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const { error } = await supabaseClient.auth.signUp({ email, password });
  if (error) return showAuthError(error.message);
  showAuthError('Account created — check your email if confirmation is required, then sign in.');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  state.user = null;
  render();
}

async function bootAfterAuth() {
  const { data } = await supabaseClient.auth.getUser();
  state.user = data.user;
  const { data: densityRows } = await supabaseClient.from('ingredient_density_reference').select('*');
  state.densityMap = buildDensityMap(densityRows);
  if (pendingDeepLink) {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    goTo(link.view, { id: link.id });
  } else {
    goTo('browse');
  }
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

async function loadRecipes() {
  let query = supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').order('created_at', { ascending: false });
  if (state.filters.diet) query = query.eq('diet', state.filters.diet);
  if (state.filters.source) query = query.eq('source', state.filters.source);
  if (state.filters.search) query = query.ilike('title', `%${state.filters.search}%`);
  if (state.filters.favoritesOnly) query = query.eq('is_favorite', true);
  if (state.filters.minRating) query = query.gte('rating', state.filters.minRating);
  const { data, error } = await query;
  if (error) { console.error(error); state.recipes = []; return; }

  let recipes = data || [];
  if (state.filters.mealType) {
    recipes = recipes.filter((r) => r.recipe_tags.some((t) => t.tag_type === 'meal_type' && t.tag_value === state.filters.mealType));
  }
  if (state.filters.mainIngredient) {
    const needle = state.filters.mainIngredient.toLowerCase();
    recipes = recipes.filter((r) =>
      r.recipe_tags.some((t) => t.tag_type === 'main_ingredient' && t.tag_value.toLowerCase().includes(needle))
    );
  }
  state.recipes = recipes;
}

function renderBrowse(root) {
  const f = state.filters;
  root.innerHTML = `
    <div class="filters">
      <input id="filter-search" placeholder="Search title…" value="${escapeHtml(f.search)}" oninput="updateFilter('search', this.value)" />
      <select onchange="updateFilter('mealType', this.value)">
        <option value="">All meal types</option>
        ${MEAL_TYPES.map((m) => `<option value="${m}" ${f.mealType === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
      <input id="filter-main-ingredient" placeholder="Main ingredient…" value="${escapeHtml(f.mainIngredient)}" oninput="updateFilter('mainIngredient', this.value)" />
      <select onchange="updateFilter('diet', this.value)">
        <option value="">Any diet</option>
        ${DIETS.map((d) => `<option value="${d}" ${f.diet === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select>
      <select onchange="updateFilter('source', this.value)">
        <option value="">Any source</option>
        ${SOURCES.map((s) => `<option value="${s}" ${f.source === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <select onchange="updateFilter('minRating', this.value)">
        <option value="">Any rating</option>
        ${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${String(f.minRating) === String(n) ? 'selected' : ''}>${n}+ stars</option>`).join('')}
      </select>
      <label style="display:flex;align-items:center;gap:5px;width:auto;margin:0;white-space:nowrap">
        <input type="checkbox" style="width:auto;min-width:0" ${f.favoritesOnly ? 'checked' : ''} onchange="updateFilter('favoritesOnly', this.checked)" />
        <i class="ti ti-star"></i> Favourites only
      </label>
    </div>
    ${state.recipes.length === 0 ? '<div class="empty-state"><i class="ti ti-tools-kitchen-2" style="font-size:40px"></i><p>No recipes yet — add your first one.</p></div>' : ''}
    <div class="recipe-grid">
      ${state.recipes.map(renderRecipeCard).join('')}
    </div>
    ${renderSelectionBar()}
  `;
}

// Shared 1-5 star rating widget, used on both the Browse card and the
// recipe detail page — separate from the existing favourite on/off toggle.
// Interactive stars call back with the star number and the rating as it was
// before the click, so clicking the currently-set star clears the rating
// rather than being stuck unable to go below 1.
function renderStarRating(rating, { interactive = false, onClickFn = '', id = '', size = 20 } = {}) {
  // Always the same solid star glyph for every star, filled or not — only
  // the colour changes. Swapping between the outline and filled glyphs
  // (ti-star vs ti-star-filled) turned out not to render reliably at a
  // consistent size (and in some cases not to render at all), since the
  // two aren't guaranteed to be drawn identically in the icon font. Using
  // one glyph throughout and just changing colour sidesteps that entirely.
  //
  // Each star button explicitly clears the base button's border/background
  // (it would otherwise look like 5 separate tiny boxed buttons) and uses
  // real padding for a properly tappable target — 1px padding around a
  // 15px icon was too small to reliably hit, especially on a phone.
  const stars = [1, 2, 3, 4, 5].map((n) => {
    const filled = rating != null && n <= rating;
    const style = `font-size:${size}px;color:${filled ? '#d4a017' : '#d8d2c5'}`;
    return interactive
      ? `<button style="padding:6px;border:none;background:none" onclick="event.stopPropagation(); ${onClickFn}('${id}', ${n}, ${rating ?? 'null'})" title="${n} star${n === 1 ? '' : 's'}"><i class="ti ti-star-filled" style="${style}"></i></button>`
      : `<i class="ti ti-star-filled" style="${style}"></i>`;
  }).join('');
  return `<span style="display:inline-flex;flex-wrap:wrap;align-items:center">${stars}</span>`;
}

function renderRecipeCard(r) {
  const mealTags = r.recipe_tags.filter((t) => t.tag_type === 'meal_type').map((t) => t.tag_value);
  const ingTags = r.recipe_tags.filter((t) => t.tag_type === 'main_ingredient').map((t) => t.tag_value);
  const checked = state.selectedRecipeIds.has(r.id);
  return `
    <div class="recipe-card" onclick="goTo('detail', {id:'${r.id}'})">
      <label class="recipe-select-chk" onclick="event.stopPropagation()">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleRecipeSelection('${r.id}')" />
      </label>
      <button class="recipe-favorite-btn ${r.is_favorite ? 'is-favorite' : ''}" onclick="event.stopPropagation(); toggleFavorite('${r.id}')" title="${r.is_favorite ? 'Remove from favourites' : 'Add to favourites'}">
        <i class="${r.is_favorite ? 'ti ti-star-filled' : 'ti ti-star'}"></i>
      </button>
      ${r.image_url ? `<img src="${escapeHtml(r.image_url)}" alt="">` : `<div class="no-image"><i class="ti ti-tools-kitchen-2"></i></div>`}
      <div class="recipe-card-body">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="tag-row">
          ${mealTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${ingTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${r.diet !== 'none' ? `<span class="tag diet-${r.diet}">${r.diet}</span>` : ''}
        </div>
        <div onclick="event.stopPropagation()" style="margin-top:4px">${renderStarRating(r.rating, { interactive: true, onClickFn: 'setRecipeRating', id: r.id })}</div>
      </div>
    </div>
  `;
}

async function setRecipeRating(id, n, currentRating) {
  const nextRating = currentRating === n ? null : n;
  const recipe = state.recipes.find((r) => r.id === id);
  if (recipe) recipe.rating = nextRating;
  renderBrowse(document.getElementById('view-root'));
  const { error } = await supabaseClient.from('recipes').update({ rating: nextRating }).eq('id', id);
  if (error) {
    if (recipe) recipe.rating = currentRating;
    renderBrowse(document.getElementById('view-root'));
    alert(`Could not update rating: ${error.message}`);
  }
}

function renderSelectionBar() {
  const count = state.selectedRecipeIds.size;
  if (count === 0) return '';
  return `
    <div class="selection-bar">
      <span>${count} recipe${count === 1 ? '' : 's'} selected</span>
      <div class="field-row" style="margin:0">
        <button onclick="clearSelection()">Clear</button>
        <button class="btn-primary" onclick="goToShoppingListFromSelection()"><i class="ti ti-shopping-cart"></i> Create shopping list</button>
      </div>
    </div>
  `;
}

function toggleRecipeSelection(id) {
  if (state.selectedRecipeIds.has(id)) state.selectedRecipeIds.delete(id);
  else state.selectedRecipeIds.add(id);
  renderBrowse(document.getElementById('view-root'));
}

async function toggleFavorite(id) {
  const recipe = state.recipes.find((r) => r.id === id);
  if (!recipe) return;
  const next = !recipe.is_favorite;
  recipe.is_favorite = next; // optimistic update, re-render immediately
  renderBrowse(document.getElementById('view-root'));
  const { error } = await supabaseClient.from('recipes').update({ is_favorite: next }).eq('id', id);
  if (error) {
    recipe.is_favorite = !next; // revert on failure
    renderBrowse(document.getElementById('view-root'));
    alert(`Could not update favourite: ${error.message}`);
  }
}

function clearSelection() {
  state.selectedRecipeIds.clear();
  renderBrowse(document.getElementById('view-root'));
}

// Typing filters (search / main ingredient) re-render the whole filters bar
// on every keystroke, which recreates the <input> element and drops focus —
// debouncing avoids a query per keystroke, and restoring focus + cursor
// position afterwards means you can keep typing without re-clicking the box.
let filterDebounceTimer = null;
function updateFilter(key, value) {
  state.filters[key] = value;
  const active = document.activeElement;
  const activeId = active ? active.id : null;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    loadRecipes().then(() => {
      renderBrowse(document.getElementById('view-root'));
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
          el.focus();
          if (selStart != null && el.setSelectionRange) {
            try { el.setSelectionRange(selStart, selStart); } catch (e) {}
          }
        }
      }
    });
  }, 300);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function loadRecipeDetail(id) {
  const { data: recipe } = await supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').eq('id', id).single();
  const { data: ingredients } = await supabaseClient.from('ingredients').select('*').eq('recipe_id', id).order('sort_order');
  const { data: photos } = await supabaseClient.from('recipe_photos').select('*').eq('recipe_id', id).order('sort_order');
  state.viewParams = {
    id, recipe, ingredients: ingredients || [], photos: photos || [],
    displaySystem: recipe?.preferred_unit_system || 'metric',
    desiredServings: recipe?.servings || null // null when the recipe has no base servings count to scale from
  };
}

function renderDetail(root) {
  const { recipe, ingredients, photos, displaySystem, desiredServings } = state.viewParams;
  if (!recipe) { root.innerHTML = '<p>Recipe not found.</p>'; return; }
  // Scale ratio for displaying ingredient quantities for a different
  // headcount than the recipe's own base servings — purely a display
  // calculation, never written back to the saved recipe.
  const servingsScale = recipe.servings && desiredServings ? desiredServings / recipe.servings : 1;

  const mealTags = recipe.recipe_tags.filter((t) => t.tag_type === 'meal_type').map((t) => t.tag_value);
  const ingTags = recipe.recipe_tags.filter((t) => t.tag_type === 'main_ingredient').map((t) => t.tag_value);
  const otherPhotos = (photos || []).filter((p) => p.url !== recipe.image_url);

  root.innerHTML = `
    <button onclick="goTo('browse')"><i class="ti ti-arrow-left"></i> Back</button>
    <div class="recipe-detail-header" style="margin-top:14px">
      ${recipe.image_url ? `<img src="${escapeHtml(recipe.image_url)}">` : ''}
      <div style="flex:1; min-width:220px">
        <h2 style="margin:0 0 4px">${escapeHtml(recipe.title)}</h2>
        <div style="margin-bottom:8px">${renderStarRating(recipe.rating, { interactive: true, onClickFn: 'setRecipeRatingDetail', id: recipe.id, size: 19 })}</div>
        <div class="tag-row">
          ${mealTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${ingTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${recipe.diet !== 'none' ? `<span class="tag diet-${recipe.diet}">${recipe.diet}</span>` : ''}
          <span class="tag">${escapeHtml(recipe.source)}</span>
        </div>
        <div class="meta-row">
          ${recipe.servings ? `<span><i class="ti ti-users"></i> Servings:
              <input type="number" min="1" step="1" style="width:56px;padding:3px 6px" value="${desiredServings ?? recipe.servings}" onchange="setDesiredServings(this.value)" />
              ${desiredServings && desiredServings !== recipe.servings ? `<span class="tag" title="Ingredient amounts below are scaled from the recipe's normal ${recipe.servings} servings">scaled from ${recipe.servings}</span>` : ''}
            </span>` : ''}
          ${recipe.prep_time_minutes ? `<span><i class="ti ti-clock"></i> Prep ${recipe.prep_time_minutes} min</span>` : ''}
          ${recipe.cook_time_minutes ? `<span><i class="ti ti-flame"></i> Cook ${recipe.cook_time_minutes} min</span>` : ''}
          ${recipe.oven_temp_c ? `<span><i class="ti ti-temperature"></i> ${recipe.oven_temp_c}°C / ${recipe.oven_temp_f}°F / Gas ${recipe.oven_gas_mark}</span>` : ''}
        </div>
        ${otherPhotos.length ? `
          <div class="tag-row" style="margin-top:8px">
            ${otherPhotos.map((p) => isPdfUrl(p.url)
              ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" style="width:52px;height:52px;display:flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border);background:var(--accent-soft);color:var(--accent)"><i class="ti ti-file-type-pdf" style="font-size:22px"></i></a>`
              : `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.url)}" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border)"></a>`
            ).join('')}
          </div>` : ''}
        <div class="field-row" style="margin-top:10px">
          <button onclick="goTo('edit', {id:'${recipe.id}'})"><i class="ti ti-edit"></i> Edit</button>
          <button onclick="toggleFavoriteDetail('${recipe.id}')"><i class="${recipe.is_favorite ? 'ti ti-star-filled' : 'ti ti-star'}"></i> ${recipe.is_favorite ? 'Favourited' : 'Add to favourites'}</button>
          <button onclick="openAddToPlannerModal('${recipe.id}')"><i class="ti ti-calendar-plus"></i> Add to Planner</button>
          <button onclick="createShoppingListForRecipe('${recipe.id}', ${servingsScale})"><i class="ti ti-shopping-cart"></i> Create shopping list</button>
          <button onclick="openShareRecipeModal()"><i class="ti ti-share"></i> Share</button>
          <button class="btn-danger" onclick="deleteRecipe('${recipe.id}')"><i class="ti ti-trash"></i> Delete</button>
        </div>
      </div>
    </div>

    <h3>Ingredients</h3>
    <div class="unit-toggle" style="margin-bottom:10px">
      ${['metric', 'imperial', 'us_cups'].map(
        (sys) => `<button class="${displaySystem === sys ? 'active' : ''}" onclick="setDisplaySystem('${sys}')">${sys === 'us_cups' ? 'US cups' : sys}</button>`
      ).join('')}
    </div>
    <ul class="ingredient-list">
      ${ingredients.map((i) => renderIngredientLine(i, displaySystem, servingsScale)).join('')}
    </ul>

    <h3 style="margin-top:24px">Method</h3>
    <p style="white-space:pre-wrap">${escapeHtml(recipe.instructions)}</p>
    ${recipe.notes ? `<h3>Notes</h3><p style="white-space:pre-wrap">${escapeHtml(recipe.notes)}</p>` : ''}
  `;
}

function renderIngredientLine(ing, system, scale = 1) {
  const rawAmt = ing[`${system}_quantity`];
  const amt = rawAmt != null && scale !== 1 ? round(rawAmt * scale, 2) : rawAmt;
  const unit = ing[`${system}_unit`];
  const approx = system === 'us_cups' && rawAmt != null && ing.original_system && ing.original_system !== 'us_cups' && !state.densityMap[ing.name.toLowerCase()];
  const amountText = amt != null ? `${amt} ${unit === 'whole' ? '' : unit}` : '';
  return `<li><span>${escapeHtml(ing.name)}${ing.notes ? `, ${escapeHtml(ing.notes)}` : ''}</span>
    <span>${escapeHtml(amountText)}${approx ? ' <span class="approx-note">(approx.)</span>' : ''}</span></li>`;
}

function setDisplaySystem(sys) {
  state.viewParams.displaySystem = sys;
  renderDetail(document.getElementById('view-root'));
}

// Scaling ingredient amounts for a different headcount than the recipe's
// own base servings — display-only, never written back to the saved
// recipe. Resets to the base servings count if given something invalid.
function setDesiredServings(val) {
  const n = parseInt(val, 10);
  const recipe = state.viewParams.recipe;
  state.viewParams.desiredServings = (!isNaN(n) && n > 0) ? n : recipe.servings;
  renderDetail(document.getElementById('view-root'));
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe? This cannot be undone.')) return;
  await supabaseClient.from('recipes').delete().eq('id', id);
  goTo('browse');
}

async function setRecipeRatingDetail(id, n, currentRating) {
  const nextRating = currentRating === n ? null : n;
  const recipe = state.viewParams.recipe;
  recipe.rating = nextRating;
  renderDetail(document.getElementById('view-root'));
  const { error } = await supabaseClient.from('recipes').update({ rating: nextRating }).eq('id', id);
  if (error) {
    recipe.rating = currentRating;
    renderDetail(document.getElementById('view-root'));
    alert(`Could not update rating: ${error.message}`);
  }
}

// Rating control on the Edit form only shows for an already-saved recipe
// (id !== 'new'), since there's no row to update until the first save.
async function setRecipeRatingEdit(id, n, currentRating) {
  const nextRating = currentRating === n ? null : n;
  state.viewParams.recipe.rating = nextRating;
  renderEdit(document.getElementById('view-root'));
  const { error } = await supabaseClient.from('recipes').update({ rating: nextRating }).eq('id', id);
  if (error) {
    state.viewParams.recipe.rating = currentRating;
    renderEdit(document.getElementById('view-root'));
    alert(`Could not update rating: ${error.message}`);
  }
}

async function toggleFavoriteDetail(id) {
  const recipe = state.viewParams.recipe;
  const next = !recipe.is_favorite;
  recipe.is_favorite = next;
  renderDetail(document.getElementById('view-root'));
  const { error } = await supabaseClient.from('recipes').update({ is_favorite: next }).eq('id', id);
  if (error) {
    recipe.is_favorite = !next;
    renderDetail(document.getElementById('view-root'));
    alert(`Could not update favourite: ${error.message}`);
  }
}

// Quick single-recipe shopping list, straight from the detail page — reuses
// the same selection Set and shopping-list view as ticking cards in Browse.
function createShoppingListForRecipe(id, scale = 1) {
  state.selectedRecipeIds = new Set([id]);
  state.shoppingListEntries = [{ recipeId: id, scale }];
  goTo('shopping-list');
}

// Browse's tick-to-select flow — always at each recipe's normal quantities
// (scale 1), unlike the week/single-recipe flows which can carry a scale.
function goToShoppingListFromSelection() {
  state.shoppingListEntries = Array.from(state.selectedRecipeIds).map((recipeId) => ({ recipeId, scale: 1 }));
  goTo('shopping-list');
}

// ---------------------------------------------------------------------------
// Share a recipe — as plain text (native share sheet, falling back to
// clipboard copy) or as a generated PDF (native share sheet with a file
// attached where supported, falling back to a direct download otherwise).
// ---------------------------------------------------------------------------

function openShareRecipeModal() {
  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner" style="width:min(360px, 90vw)">
      <div class="field-row" style="justify-content:space-between;align-items:center;margin-bottom:2px">
        <h3 style="margin:0"><i class="ti ti-share"></i> Share recipe</h3>
        <button class="btn-icon" onclick="closeShareRecipeModal()"><i class="ti ti-x"></i></button>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">Choose a format to share.</p>
      <div class="field-row">
        <button class="btn-primary" style="flex:1;justify-content:center" onclick="shareRecipeAsText()"><i class="ti ti-file-text"></i> Share as text</button>
        <button style="flex:1;justify-content:center" onclick="shareRecipeAsPdf()"><i class="ti ti-file-type-pdf"></i> Share as PDF</button>
      </div>
      <div id="share-recipe-status" class="error-text" style="min-height:16px;margin-top:8px"></div>
    </div>
  `;
  document.body.appendChild(modal);
  state._shareRecipeModal = modal;
}

function closeShareRecipeModal() {
  if (state._shareRecipeModal) state._shareRecipeModal.remove();
  state._shareRecipeModal = null;
}

// Builds a plain-text version of the recipe using whichever unit system is
// currently selected on the detail page, matching what's on screen.
function buildRecipeShareText() {
  const { recipe, ingredients, displaySystem } = state.viewParams;
  const lines = [recipe.title, ''];

  const meta = [];
  if (recipe.servings) meta.push(`Servings: ${recipe.servings}`);
  if (recipe.prep_time_minutes) meta.push(`Prep: ${recipe.prep_time_minutes} min`);
  if (recipe.cook_time_minutes) meta.push(`Cook: ${recipe.cook_time_minutes} min`);
  if (recipe.oven_temp_c) meta.push(`Oven: ${recipe.oven_temp_c}°C / ${recipe.oven_temp_f}°F / Gas ${recipe.oven_gas_mark}`);
  if (meta.length) { lines.push(meta.join('  |  ')); lines.push(''); }

  lines.push('Ingredients:');
  ingredients.forEach((ing) => lines.push(`- ${formatShareIngredientLine(ing, displaySystem)}`));
  lines.push('');
  lines.push('Method:');
  lines.push(recipe.instructions || '');

  if (recipe.notes) { lines.push(''); lines.push('Notes:'); lines.push(recipe.notes); }
  return lines.join('\n');
}

function formatShareIngredientLine(ing, system) {
  const amt = ing[`${system}_quantity`];
  const unit = ing[`${system}_unit`];
  const amountText = amt != null ? `${amt} ${unit === 'whole' ? '' : unit}`.trim() : '';
  return `${amountText ? amountText + ' ' : ''}${ing.name}${ing.notes ? `, ${ing.notes}` : ''}`;
}

async function shareRecipeAsText() {
  const { recipe } = state.viewParams;
  const text = buildRecipeShareText();
  const statusEl = document.getElementById('share-recipe-status');
  if (navigator.share) {
    try {
      await navigator.share({ title: recipe.title, text });
      closeShareRecipeModal();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user backed out of the share sheet
      // otherwise fall through to the clipboard fallback below
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = 'Copied to clipboard.'; }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Could not share or copy: ${err.message || err}`;
  }
}

// Builds a simple, clean PDF client-side with jsPDF (loaded via CDN in
// index.html) — title, thumbnail photo (if any), meta info, ingredients in
// the currently-displayed unit system, method, and notes. Paginates plain
// text with jsPDF's splitTextToSize so longer methods/ingredient lists flow
// onto extra pages rather than running off the bottom.
async function buildRecipePdfBlob() {
  const { recipe, ingredients, displaySystem } = state.viewParams;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  if (recipe.image_url) {
    try {
      const resp = await fetch(recipe.image_url);
      const blob = await resp.blob();
      const dataUrl = await blobToDataUrl(blob);
      const imgEl = await loadImageElement(dataUrl);
      const maxImgW = 160, maxImgH = 140;
      const scale = Math.min(maxImgW / imgEl.naturalWidth, maxImgH / imgEl.naturalHeight, 1);
      const imgWidth = imgEl.naturalWidth * scale;
      const imgHeight = imgEl.naturalHeight * scale;
      const imgFormat = /png/i.test(blob.type) ? 'PNG' : 'JPEG';
      doc.addImage(dataUrl, imgFormat, margin, y, imgWidth, imgHeight);
      y += imgHeight + 16;
    } catch (err) {
      console.error('Could not embed thumbnail in PDF, continuing without it:', err);
    }
  }

  const ensureRoom = (needed) => { if (y + needed > pageHeight - margin) { doc.addPage(); y = margin; } };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  const titleLines = doc.splitTextToSize(recipe.title, maxWidth);
  ensureRoom(titleLines.length * 22);
  doc.text(titleLines, margin, y);
  y += titleLines.length * 22 + 8;

  const meta = [];
  if (recipe.servings) meta.push(`Servings: ${recipe.servings}`);
  if (recipe.prep_time_minutes) meta.push(`Prep: ${recipe.prep_time_minutes} min`);
  if (recipe.cook_time_minutes) meta.push(`Cook: ${recipe.cook_time_minutes} min`);
  if (recipe.oven_temp_c) meta.push(`Oven: ${recipe.oven_temp_c}°C / ${recipe.oven_temp_f}°F / Gas ${recipe.oven_gas_mark}`);
  if (meta.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    ensureRoom(16);
    doc.text(meta.join('   |   '), margin, y);
    y += 22;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  ensureRoom(18);
  doc.text('Ingredients', margin, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  ingredients.forEach((ing) => {
    const wrapped = doc.splitTextToSize(`• ${formatShareIngredientLine(ing, displaySystem)}`, maxWidth);
    ensureRoom(wrapped.length * 14);
    doc.text(wrapped, margin, y);
    y += wrapped.length * 14 + 2;
  });

  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  ensureRoom(18);
  doc.text('Method', margin, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.splitTextToSize(recipe.instructions || '', maxWidth).forEach((lineText) => {
    ensureRoom(14);
    doc.text(lineText, margin, y);
    y += 14;
  });

  if (recipe.notes) {
    y += 10;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    ensureRoom(18);
    doc.text('Notes', margin, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.splitTextToSize(recipe.notes, maxWidth).forEach((lineText) => {
      ensureRoom(14);
      doc.text(lineText, margin, y);
      y += 14;
    });
  }

  return doc.output('blob');
}

async function shareRecipeAsPdf() {
  const { recipe } = state.viewParams;
  const statusEl = document.getElementById('share-recipe-status');
  if (statusEl) { statusEl.style.color = ''; statusEl.textContent = 'Building PDF…'; }

  let blob;
  try {
    blob = await buildRecipePdfBlob();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Could not build PDF: ${err.message || err}`;
    return;
  }

  const fileName = `${(recipe.title || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'recipe'}.pdf`;
  const file = new File([blob], fileName, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: recipe.title });
      closeShareRecipeModal();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // otherwise fall through to the download fallback below
    }
  }

  // Fallback for browsers without Web Share API file support (most desktop
  // browsers) — download it directly so it can be shared manually.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = 'PDF downloaded — share it from your downloads/files.'; }
}

// "Add to Planner" from a recipe's detail page — a lighter-weight version of
// the planner's meal picker: the recipe is already chosen, so this just
// prompts for a date (any date, not only the currently-viewed planner week)
// and a meal slot. Deliberately doesn't reuse assignPlanEntry(), since that
// function reloads/re-renders the planner view, which would clobber the
// detail page we're actually standing on — this does its own upsert instead.
function openAddToPlannerModal(recipeId) {
  const recipe = state.viewParams.recipe;
  const title = recipe?.title || 'this recipe';
  const baseServings = recipe?.servings || null;
  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner" style="width:min(420px, 92vw)">
      <div class="field-row" style="justify-content:space-between;align-items:center;margin-bottom:2px">
        <h3 style="margin:0"><i class="ti ti-calendar-plus"></i> Add to Planner</h3>
        <button class="btn-icon" onclick="closeAddToPlannerModal()"><i class="ti ti-x"></i></button>
      </div>
      <p style="margin:0 0 10px;font-size:13px;color:var(--text-muted)">${escapeHtml(title)}</p>
      <div class="field-row">
        <div class="field"><label>Date</label><input type="date" id="atp-date" value="${formatDateISO(new Date())}" /></div>
        <div class="field"><label>Meal</label>
          <select id="atp-slot">${PLAN_SLOTS.map((s) => `<option value="${s}">${capitalizeFirst(s)}</option>`).join('')}</select>
        </div>
        ${baseServings ? `<div class="field"><label>Servings</label><input type="number" min="1" step="1" id="atp-servings" value="${baseServings}" /></div>` : ''}
      </div>
      <div id="atp-status" class="error-text" style="min-height:16px"></div>
      <div class="field-row" style="margin-top:6px">
        <button class="btn-primary" onclick="confirmAddToPlanner('${recipeId}')"><i class="ti ti-check"></i> Add to Planner</button>
        <button onclick="closeAddToPlannerModal()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  state._addToPlannerModal = modal;
}

function closeAddToPlannerModal() {
  if (state._addToPlannerModal) state._addToPlannerModal.remove();
  state._addToPlannerModal = null;
}

async function confirmAddToPlanner(recipeId) {
  const dateISO = document.getElementById('atp-date').value;
  const slot = document.getElementById('atp-slot').value;
  const statusEl = document.getElementById('atp-status');
  if (!dateISO) { if (statusEl) statusEl.textContent = 'Pick a date first.'; return; }
  // Only stored as an explicit override if it actually differs from the
  // recipe's own normal servings — otherwise leave it null (the default,
  // meaning "assume the recipe's normal servings").
  const servingsEl = document.getElementById('atp-servings');
  const baseServings = state.viewParams.recipe?.servings || null;
  const enteredServings = servingsEl ? numOrNull(servingsEl.value) : null;
  const servings = enteredServings != null && enteredServings !== baseServings ? enteredServings : null;
  // A plain insert, not an upsert — a slot can hold several dishes, so this
  // adds alongside whatever else is already assigned to that date/slot.
  const { error } = await supabaseClient.from('meal_plan_entries')
    .insert({ user_id: state.user.id, plan_date: dateISO, meal_slot: slot, recipe_id: recipeId, servings });
  if (statusEl) {
    if (error) {
      statusEl.style.color = '';
      statusEl.textContent = error.message;
    } else {
      statusEl.style.color = 'var(--success)';
      statusEl.textContent = `Added to ${capitalizeFirst(slot)} on ${formatDateShort(dateISO)} — pick another date/meal for this recipe, or close when done.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Add / Edit
// ---------------------------------------------------------------------------

async function loadEditForm(id) {
  if (id === 'new') {
    state.viewParams = {
      id: 'new',
      recipe: {
        title: '', source: 'other', diet: 'none', servings: '', prep_time_minutes: '', cook_time_minutes: '',
        oven_temp_c: '', oven_temp_f: '', oven_gas_mark: '', instructions: '', notes: '', preferred_unit_system: 'metric',
        image_url: '', original_image_url: ''
      },
      mealTypes: [], mainIngredients: '', ingredients: [emptyIngredientRow()],
      photos: [], originalPhotoIds: [], pasteText: ''
    };
    return;
  }
  const { data: recipe } = await supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').eq('id', id).single();
  const { data: ingredients } = await supabaseClient.from('ingredients').select('*').eq('recipe_id', id).order('sort_order');
  const { data: existingPhotos } = await supabaseClient.from('recipe_photos').select('*').eq('recipe_id', id).order('sort_order');
  const photos = (existingPhotos || []).map((p) => ({
    id: p.id, url: p.url, blob: null, mimeType: null, previewUrl: p.url, isThumbnail: p.is_thumbnail,
    // recipe_photos has no mime_type column — a PDF's stored URL always ends
    // in .pdf (upload-recipe-photo names files by extension), so that's
    // enough to tell it apart from an image without a migration.
    isPdf: isPdfUrl(p.url)
  }));
  state.viewParams = {
    id,
    recipe,
    mealTypes: recipe.recipe_tags.filter((t) => t.tag_type === 'meal_type').map((t) => t.tag_value),
    mainIngredients: recipe.recipe_tags.filter((t) => t.tag_type === 'main_ingredient').map((t) => t.tag_value).join(', '),
    ingredients: (ingredients && ingredients.length ? ingredients : [emptyIngredientRow()]).map((i) => ({
      name: i.name, quantity: i.original_quantity, unit: i.original_unit, notes: i.notes
    })),
    photos,
    originalPhotoIds: photos.map((p) => p.id),
    pasteText: ''
  };
}

function emptyIngredientRow() {
  return { name: '', quantity: '', unit: 'g', notes: '' };
}

function renderEdit(root) {
  const { recipe, mealTypes, mainIngredients, ingredients, photos, id, pasteText } = state.viewParams;
  root.innerHTML = `
    <button onclick="goTo('browse')"><i class="ti ti-arrow-left"></i> Back</button>
    <h2 style="margin-top:14px">${id === 'new' ? 'Add recipe' : 'Edit recipe'}</h2>

    <div class="field">
      <label>Photos or PDFs (front/back of a card, multiple pages, etc.)</label>
      <input type="file" accept="image/*,application/pdf" multiple onchange="handlePhotoSelected(event)" />
      <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0">You can select several files at once (e.g. everything in one folder) — each photo opens its own crop step in turn, PDFs are added straight away. A PDF can be included in an AI scan, but only a photo can be set as the thumbnail.</p>
      <div id="photo-list">${renderPhotoList(photos)}</div>

      <label style="margin-top:12px">Or paste recipe text (e.g. copied from a web page)</label>
      <textarea id="paste-text" rows="6" placeholder="Paste the ingredients and method here…" oninput="state.viewParams.pasteText = this.value">${escapeHtml(pasteText || '')}</textarea>

      <div class="field-row" style="margin-top:8px">
        <button id="scan-btn" onclick="scanWithAI()"><i class="ti ti-sparkles"></i> Scan photo(s) / pasted text with AI to prefill</button>
      </div>
      <div id="scan-status" class="error-text"></div>
    </div>

    <div class="field"><label>Title</label><input id="f-title" value="${escapeHtml(recipe.title)}" /></div>

    ${id !== 'new' ? `
      <div class="field">
        <label>Rating</label>
        ${renderStarRating(recipe.rating, { interactive: true, onClickFn: 'setRecipeRatingEdit', id, size: 20 })}
      </div>
    ` : ''}

    <div class="field-row">
      <div class="field"><label>Source</label>
        <select id="f-source">${SOURCES.map((s) => `<option value="${s}" ${recipe.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Diet</label>
        <select id="f-diet">${DIETS.map((d) => `<option value="${d}" ${recipe.diet === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Servings</label><input id="f-servings" type="number" value="${escapeHtml(recipe.servings)}" /></div>
    </div>

    <div class="field-row">
      <div class="field"><label>Prep time (min)</label><input id="f-prep" type="number" value="${escapeHtml(recipe.prep_time_minutes)}" /></div>
      <div class="field"><label>Cook time (min)</label><input id="f-cook" type="number" value="${escapeHtml(recipe.cook_time_minutes)}" /></div>
      <div class="field"><label>Oven temp °C</label><input id="f-oven-c" type="number" onchange="ovenTempChanged(this.value)" value="${escapeHtml(recipe.oven_temp_c)}" /></div>
      <div class="field"><label>Gas mark</label><input id="f-gas" type="number" step="0.25" value="${escapeHtml(recipe.oven_gas_mark)}" readonly /></div>
      <div class="field"><label>°F</label><input id="f-oven-f" type="number" value="${escapeHtml(recipe.oven_temp_f)}" readonly /></div>
    </div>

    <div class="field"><label>Meal type (select all that apply)</label>
      <div class="checkbox-row">
        ${MEAL_TYPES.map((m) => `<label>
            <input type="checkbox" value="${m}" class="meal-type-chk" ${mealTypes.includes(m) ? 'checked' : ''}/> ${m}
          </label>`).join('')}
      </div>
    </div>

    <div class="field"><label>Main ingredient(s), comma separated</label>
      <input id="f-main-ing" value="${escapeHtml(mainIngredients)}" placeholder="chicken, rice" />
    </div>

    <div class="field"><label>Default unit system for this recipe</label>
      <select id="f-preferred-system">
        ${['metric', 'imperial', 'us_cups'].map((s) => `<option value="${s}" ${recipe.preferred_unit_system === s ? 'selected' : ''}>${s === 'us_cups' ? 'US cups' : s}</option>`).join('')}
      </select>
    </div>

    <h3>Ingredients</h3>
    <div id="ingredient-rows">
      ${ingredients.map((ing, idx) => renderIngredientRow(ing, idx)).join('')}
    </div>
    <button onclick="addIngredientRow()"><i class="ti ti-plus"></i> Add ingredient</button>

    <div class="field" style="margin-top:18px"><label>Method</label><textarea id="f-instructions" rows="8">${escapeHtml(recipe.instructions)}</textarea></div>
    <div class="field"><label>Notes</label><textarea id="f-notes" rows="3">${escapeHtml(recipe.notes)}</textarea></div>

    <button class="btn-primary" onclick="saveRecipe()"><i class="ti ti-device-floppy"></i> Save recipe</button>
  `;
}

function renderIngredientRow(ing, idx) {
  return `
    <div class="ingredient-row" data-idx="${idx}">
      <input placeholder="Ingredient name" value="${escapeHtml(ing.name)}" data-field="name" />
      <input placeholder="Qty" type="number" step="any" value="${escapeHtml(ing.quantity)}" data-field="quantity" />
      <select data-field="unit">
        ${['g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'fl_oz', 'pint', 'cup', 'oz', 'lb', 'whole'].map(
          (u) => `<option value="${u}" ${ing.unit === u ? 'selected' : ''}>${u}</option>`
        ).join('')}
      </select>
      <input placeholder="Notes (e.g. sifted)" value="${escapeHtml(ing.notes)}" data-field="notes" />
      <button class="btn-icon btn-danger" onclick="removeIngredientRow(${idx})"><i class="ti ti-x"></i></button>
    </div>
  `;
}

function readIngredientRowsFromDom() {
  const rows = document.querySelectorAll('#ingredient-rows .ingredient-row');
  return Array.from(rows).map((row) => ({
    name: row.querySelector('[data-field="name"]').value.trim(),
    quantity: row.querySelector('[data-field="quantity"]').value,
    unit: row.querySelector('[data-field="unit"]').value,
    notes: row.querySelector('[data-field="notes"]').value.trim()
  })).filter((i) => i.name);
}

function addIngredientRow() {
  state.viewParams.ingredients = readIngredientRowsFromDom();
  state.viewParams.ingredients.push(emptyIngredientRow());
  renderEdit(document.getElementById('view-root'));
}

function removeIngredientRow(idx) {
  const rows = readIngredientRowsFromDom();
  rows.splice(idx, 1);
  state.viewParams.ingredients = rows.length ? rows : [emptyIngredientRow()];
  renderEdit(document.getElementById('view-root'));
}

function ovenTempChanged(cValue) {
  const c = parseFloat(cValue);
  if (isNaN(c)) return;
  const norm = normalizeOvenTemp({ c });
  document.getElementById('f-oven-f').value = norm.f ?? '';
  document.getElementById('f-gas').value = norm.gasMark ?? '';
}

// ---- photo capture / crop -------------------------------------------------

// recipe_photos has no mime_type column, so a PDF is identified by its
// stored URL ending in .pdf (upload-recipe-photo names the file after the
// mime type's extension) — good enough without a migration.
function isPdfUrl(url) {
  return !!url && url.toLowerCase().split('?')[0].endsWith('.pdf');
}

function renderPhotoList(photos) {
  if (!photos || photos.length === 0) return '<p style="font-size:13px;color:var(--text-muted);margin:8px 0 0">No photos yet — add one below.</p>';
  return `
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:10px">
      ${photos.map((p, idx) => `
        <div class="photo-card">
          ${p.isPdf
            ? `<div style="width:100%;height:100px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:var(--accent-soft);color:var(--accent);border-radius:6px">
                 <i class="ti ti-file-type-pdf" style="font-size:28px"></i>
                 <span style="font-size:11px">${escapeHtml(p.fileName || 'PDF')}</span>
               </div>`
            : `<img src="${escapeHtml(p.previewUrl)}">`
          }
          ${p.isPdf
            ? ''
            : `<label>
                 <input type="radio" name="thumbnail-radio" ${p.isThumbnail ? 'checked' : ''} onchange="setThumbnail(${idx})" /> Thumbnail
               </label>`
          }
          <label>
            <input type="checkbox" class="photo-scan-chk" data-idx="${idx}" ${(!p.id && p.includeInScanDefault !== false) ? 'checked' : ''} /> Include in scan
          </label>
          ${p.isPdf
            ? ''
            : `<button class="btn-icon" onclick="reCropPhoto(${idx})" title="Crop a different part of this same photo — e.g. just the picture, for the thumbnail"><i class="ti ti-crop"></i> Crop again</button>`
          }
          <button class="btn-icon btn-danger" onclick="removePhoto(${idx})"><i class="ti ti-x"></i> Remove</button>
        </div>
      `).join('')}
    </div>
  `;
}

function setThumbnail(idx) {
  if (state.viewParams.photos[idx].isPdf) return; // a PDF can't be the card/detail thumbnail
  state.viewParams.photos.forEach((p, i) => { p.isThumbnail = i === idx; });
}

function removePhoto(idx) {
  const photos = state.viewParams.photos;
  const wasThumbnail = photos[idx].isThumbnail;
  photos.splice(idx, 1);
  if (wasThumbnail && photos.length) photos[0].isThumbnail = true;
  document.getElementById('photo-list').innerHTML = renderPhotoList(photos);
  document.getElementById('scan-btn').disabled = photos.length === 0;
}

// Selecting multiple files at once (the picker has `multiple` set) stages
// every PDF immediately (no cropping needed) and queues every photo to be
// cropped one at a time — the crop tool is inherently a one-photo-at-a-time
// UI, so each queued photo opens its own crop modal right after the previous
// one is confirmed or cancelled, instead of forcing you back into the file
// picker for each one individually.
function handlePhotoSelected(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = ''; // allow re-selecting the same file(s) later
  if (files.length === 0) return;
  for (const file of files) {
    if (file.type === 'application/pdf') {
      stagePdfBlob(file);
    } else {
      state.photoQueue.push(file);
    }
  }
  processNextQueuedPhoto();
}

function processNextQueuedPhoto() {
  if (state._cropModal) return; // a crop is already open; it'll call this again once it's done
  const next = state.photoQueue.shift();
  if (!next) return;
  const reader = new FileReader();
  reader.onload = () => openCropModal(reader.result, next.type);
  reader.readAsDataURL(next);
}

function stagePdfBlob(file) {
  const photos = state.viewParams.photos;
  photos.push({
    id: null, url: null, blob: file, mimeType: 'application/pdf', previewUrl: null,
    isThumbnail: false, isPdf: true, fileName: file.name
  });
  document.getElementById('photo-list').innerHTML = renderPhotoList(photos);
  document.getElementById('scan-btn').disabled = false;
}

// extraOpts flows through to stagePhotoBlob once this crop is confirmed —
// used by reCropPhoto() to mark a second crop of the same source photo as
// the thumbnail and leave it out of the AI scan by default (see reCropPhoto).
function openCropModal(dataUrl, mimeType, extraOpts = {}) {
  const remaining = state.photoQueue.length;
  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner">
      <p style="margin-top:0;font-size:13px;color:var(--text-muted)">Drag the corners to crop and use the rotate buttons if it's sideways, then click <strong>Use this crop</strong> below — the photo isn't attached until you do.${remaining ? ` (${remaining} more photo${remaining === 1 ? '' : 's'} queued after this one.)` : ''}</p>
      <div class="crop-image-wrap"><img id="crop-target" src="${dataUrl}"></div>
      <div class="field-row">
        <button type="button" onclick="rotateCrop(-90)"><i class="ti ti-rotate"></i> Rotate left</button>
        <button type="button" onclick="rotateCrop(90)"><i class="ti ti-rotate-clockwise"></i> Rotate right</button>
      </div>
      <div class="field-row" style="margin-top:8px">
        <button class="btn-primary" onclick="confirmCrop('${mimeType}')"><i class="ti ti-crop"></i> Use this crop</button>
        <button onclick="cancelCrop()">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const img = document.getElementById('crop-target');
  state._cropModal = modal;
  state._originalDataUrl = dataUrl;
  state._cropExtraOpts = extraOpts;
  state._fallbackRotationDeg = 0;
  try {
    state.cropper = new Cropper(img, { viewMode: 1, autoCropArea: 1 });
  } catch (err) {
    // Cropper library failed to load (e.g. CDN blocked) — don't lose the
    // photo, just skip cropping and use it as-is (rotate still works via
    // the canvas fallback in confirmCrop).
    console.error('Cropper failed to initialize, using photo uncropped:', err);
    state.cropper = null;
  }
}

function rotateCrop(deg) {
  if (state.cropper) {
    state.cropper.rotate(deg);
    return;
  }
  state._fallbackRotationDeg = ((state._fallbackRotationDeg + deg) % 360 + 360) % 360;
  const img = document.getElementById('crop-target');
  if (img) img.style.transform = `rotate(${state._fallbackRotationDeg}deg)`;
}

function cancelCrop() {
  if (state.cropper) state.cropper.destroy();
  state._cropModal.remove();
  state._cropModal = null;
  state.cropper = null;
  processNextQueuedPhoto(); // move on to the next queued photo, if any
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// opts.originalDataUrl is kept on the photo so reCropPhoto() can later open
// the crop tool again on the same source image (e.g. to grab just the photo
// for the thumbnail, separate from the fuller crop used for the AI scan)
// without having to re-select the file from disk. opts.isThumbnail and
// opts.includeInScanDefault let a re-crop default sensibly (see reCropPhoto)
// instead of always behaving like a brand-new upload.
function stagePhotoBlob(blob, mimeType, opts = {}) {
  const previewUrl = URL.createObjectURL(blob);
  const photos = state.viewParams.photos;
  const makeThumbnail = opts.isThumbnail || photos.length === 0;
  if (makeThumbnail) photos.forEach((p) => { p.isThumbnail = false; });
  photos.push({
    id: null, url: null, blob, mimeType: mimeType || 'image/jpeg', previewUrl,
    isThumbnail: makeThumbnail, isPdf: false,
    originalDataUrl: opts.originalDataUrl || null,
    includeInScanDefault: opts.includeInScanDefault !== false
  });
  cancelCrop();
  document.getElementById('photo-list').innerHTML = renderPhotoList(photos);
  document.getElementById('scan-btn').disabled = false;
}

async function confirmCrop(mimeType) {
  const opts = { ...(state._cropExtraOpts || {}), originalDataUrl: state._originalDataUrl };
  if (state.cropper) {
    const canvas = state.cropper.getCroppedCanvas({ maxWidth: 1400, maxHeight: 1400 });
    canvas.toBlob((blob) => stagePhotoBlob(blob, mimeType, opts), mimeType || 'image/jpeg', 0.9);
    return;
  }
  // No cropper available — still apply any rotation the user picked, via canvas.
  const deg = state._fallbackRotationDeg || 0;
  const img = await loadImageElement(state._originalDataUrl);
  const canvas = document.createElement('canvas');
  const swap = deg === 90 || deg === 270;
  canvas.width = swap ? img.height : img.width;
  canvas.height = swap ? img.width : img.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  canvas.toBlob((blob) => stagePhotoBlob(blob, mimeType, opts), mimeType || 'image/jpeg', 0.9);
}

// Lets the same uploaded photo be cropped a second time for a different
// purpose — e.g. a page that has both instructions and a picture on it: the
// first crop (done on selection) keeps the whole useful area for the AI
// scan, and "Crop again" reopens the tool on that same original image so
// you can crop tight to just the picture for the thumbnail, without having
// to pick the file from disk a second time. Falls back to re-fetching the
// already-saved image when there's no in-memory original (a photo loaded
// from a previously-saved recipe) — that still works, it just starts from
// what's already stored rather than the very first upload.
async function reCropPhoto(idx) {
  const photo = state.viewParams.photos[idx];
  if (!photo || photo.isPdf) return;
  let dataUrl = photo.originalDataUrl;
  if (!dataUrl && photo.url) {
    try {
      const resp = await fetch(photo.url);
      const blob = await resp.blob();
      dataUrl = await blobToDataUrl(blob);
    } catch (err) {
      alert(`Could not load this photo to crop again: ${err.message || err}`);
      return;
    }
  }
  if (!dataUrl) return;
  openCropModal(dataUrl, photo.mimeType || 'image/jpeg', { isThumbnail: true, includeInScanDefault: false });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Downscale a photo before sending it to the AI scan — the saved/thumbnail
// photo keeps its full quality, but a scan of 2-3 full-resolution crops as
// base64 is a large enough payload that it can time out before ever reaching
// the edge function. 1024px is still plenty legible for OCR-style reading.
async function resizeImageForScan(blob, maxDim = 1024, quality = 0.7) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(objectUrl);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function scanWithAI() {
  const photos = state.viewParams.photos;
  const checkedIdx = Array.from(document.querySelectorAll('.photo-scan-chk:checked')).map((c) => Number(c.dataset.idx));
  const pasteText = (document.getElementById('paste-text')?.value || '').trim();
  if (checkedIdx.length === 0 && !pasteText) {
    alert('Tick "Include in scan" on at least one photo, or paste some recipe text, first.');
    return;
  }

  const statusEl = document.getElementById('scan-status');
  statusEl.textContent = 'Reading recipe with AI…';
  try {
    const images = [];
    for (const idx of checkedIdx) {
      const p = photos[idx];
      if (!p.blob) {
        // Already-saved photo/PDF — only has a URL so far, fetch it once and cache the blob.
        const resp = await fetch(p.url);
        p.blob = await resp.blob();
        p.mimeType = p.blob.type || (p.isPdf ? 'application/pdf' : 'image/jpeg');
      }
      if (p.isPdf) {
        // Claude reads PDFs directly — no resizing/downscaling applies here.
        images.push({ imageBase64: await blobToBase64(p.blob), mimeType: 'application/pdf' });
      } else {
        const scanBlob = await resizeImageForScan(p.blob);
        images.push({ imageBase64: await blobToBase64(scanBlob), mimeType: 'image/jpeg' });
      }
    }
    const { data, error } = await supabaseClient.functions.invoke('extract-recipe', {
      body: { images, text: pasteText || undefined }
    });
    if (error) throw await describeFunctionError(error);
    applyExtractedRecipe(data.data);
    statusEl.textContent = 'Prefilled — please check the details before saving.';
  } catch (err) {
    const hint = /send a request/i.test(err.message || '')
      ? ' (the request didn\'t reach the server — check your connection, or try scanning fewer photos at once)'
      : '';
    statusEl.textContent = `Could not read the recipe: ${err.message || err}${hint}`;
  }
}

// supabase-js only gives a generic "Edge Function returned a non-2xx status
// code" for FunctionsHttpError — the actual reason (from our edge function's
// { error: "..." } JSON body) is on error.context, a raw Response object we
// have to read ourselves to get anything useful on screen.
async function describeFunctionError(error) {
  if (error && error.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.clone().json();
      if (body && body.error) return new Error(body.error);
    } catch {
      // response body wasn't JSON — fall through to the generic message
    }
  }
  return error;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function applyExtractedRecipe(extracted) {
  if (!extracted) return;
  const r = state.viewParams.recipe;
  if (extracted.title) r.title = extracted.title;
  if (extracted.servings != null) r.servings = extracted.servings;
  if (extracted.prep_time_minutes != null) r.prep_time_minutes = extracted.prep_time_minutes;
  if (extracted.cook_time_minutes != null) r.cook_time_minutes = extracted.cook_time_minutes;
  if (extracted.oven_temp_c != null) r.oven_temp_c = extracted.oven_temp_c;
  if (extracted.oven_temp_f != null) r.oven_temp_f = extracted.oven_temp_f;
  if (extracted.oven_gas_mark != null) r.oven_gas_mark = extracted.oven_gas_mark;
  if (extracted.instructions) r.instructions = extracted.instructions;
  if (extracted.diet_guess) r.diet = extracted.diet_guess;
  if (Array.isArray(extracted.ingredients) && extracted.ingredients.length) {
    state.viewParams.ingredients = extracted.ingredients.map((i) => ({
      name: capitalizeFirst(i.name), quantity: i.quantity ?? '', unit: i.unit || 'g', notes: i.notes || ''
    }));
  }
  if (extracted.meal_type_guess) state.viewParams.mealTypes = [extracted.meal_type_guess];
  if (Array.isArray(extracted.main_ingredient_guess)) state.viewParams.mainIngredients = extracted.main_ingredient_guess.join(', ');
  renderEdit(document.getElementById('view-root'));
}

// ---- save ------------------------------------------------------------

async function uploadOnePhoto(blob, mimeType, recipeId) {
  // Uploaded via an edge function (using the service role key server-side)
  // rather than directly from the browser — the storage-js client wasn't
  // attaching the user's session token to Storage API requests specifically,
  // which made direct client-side uploads fail RLS. Routing through a
  // function that verifies the caller's JWT itself sidesteps that.
  const base64 = await blobToBase64(blob);
  const { data, error } = await supabaseClient.functions.invoke('upload-recipe-photo', {
    body: { imageBase64: base64, mimeType: mimeType || 'image/jpeg', recipeId }
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data.url;
}

// Persists every photo currently in the edit form: uploads any brand-new
// ones and inserts their recipe_photos row, keeps existing ones' thumbnail
// flag/order up to date, removes rows for any photo taken out of the list
// during this edit, and mirrors whichever photo is the thumbnail onto
// recipes.image_url so Browse/detail keep working without a join.
async function savePhotos(recipeId) {
  const photos = state.viewParams.photos;
  const originalIds = state.viewParams.originalPhotoIds || [];
  const failures = [];

  for (let idx = 0; idx < photos.length; idx++) {
    const p = photos[idx];
    try {
      if (!p.id) {
        const url = await uploadOnePhoto(p.blob, p.mimeType, recipeId);
        const { data, error } = await supabaseClient.from('recipe_photos')
          .insert({ recipe_id: recipeId, url, is_thumbnail: !!p.isThumbnail, sort_order: idx })
          .select().single();
        if (error) throw error;
        p.id = data.id;
        p.url = url;
      } else {
        await supabaseClient.from('recipe_photos')
          .update({ is_thumbnail: !!p.isThumbnail, sort_order: idx })
          .eq('id', p.id);
      }
    } catch (err) {
      failures.push(err.message || String(err));
    }
  }

  const currentIds = photos.filter((p) => p.id).map((p) => p.id);
  const removedIds = originalIds.filter((pid) => !currentIds.includes(pid));
  if (removedIds.length) {
    await supabaseClient.from('recipe_photos').delete().in('id', removedIds);
  }

  // Fall back to the first non-PDF photo if nothing's explicitly flagged as
  // the thumbnail — a PDF can never end up as recipes.image_url, since that
  // field is rendered as an <img> on cards/detail.
  const thumbnail = photos.find((p) => p.isThumbnail) || photos.find((p) => !p.isPdf) || null;
  await supabaseClient.from('recipes')
    .update({ image_url: thumbnail ? thumbnail.url : null, original_image_url: thumbnail ? thumbnail.url : null })
    .eq('id', recipeId);

  if (failures.length) {
    alert(`The recipe saved, but ${failures.length} photo(s) failed to upload:\n${failures.join('\n')}\nTry editing the recipe and adding them again.`);
  }
}

async function saveRecipe() {
  const { id } = state.viewParams;
  const payload = {
    title: document.getElementById('f-title').value.trim(),
    source: document.getElementById('f-source').value,
    diet: document.getElementById('f-diet').value,
    servings: numOrNull(document.getElementById('f-servings').value),
    prep_time_minutes: numOrNull(document.getElementById('f-prep').value),
    cook_time_minutes: numOrNull(document.getElementById('f-cook').value),
    oven_temp_c: numOrNull(document.getElementById('f-oven-c').value),
    oven_temp_f: numOrNull(document.getElementById('f-oven-f').value),
    oven_gas_mark: numOrNull(document.getElementById('f-gas').value),
    preferred_unit_system: document.getElementById('f-preferred-system').value,
    instructions: document.getElementById('f-instructions').value,
    notes: document.getElementById('f-notes').value,
    user_id: state.user.id
  };

  if (!payload.title) { alert('Please give the recipe a title.'); return; }

  let recipeId = id;
  if (id === 'new') {
    const { data, error } = await supabaseClient.from('recipes').insert(payload).select().single();
    if (error) { alert(error.message); return; }
    recipeId = data.id;
  } else {
    const { error } = await supabaseClient.from('recipes').update(payload).eq('id', id);
    if (error) { alert(error.message); return; }
  }

  await savePhotos(recipeId);

  await saveTags(recipeId);
  await saveIngredients(recipeId);

  goTo('detail', { id: recipeId });
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function saveTags(recipeId) {
  await supabaseClient.from('recipe_tags').delete().eq('recipe_id', recipeId);
  const mealTypes = Array.from(document.querySelectorAll('.meal-type-chk:checked')).map((c) => c.value);
  const mainIngredients = document.getElementById('f-main-ing').value.split(',').map((s) => s.trim()).filter(Boolean);
  const rows = [
    ...mealTypes.map((v) => ({ recipe_id: recipeId, tag_type: 'meal_type', tag_value: v })),
    ...mainIngredients.map((v) => ({ recipe_id: recipeId, tag_type: 'main_ingredient', tag_value: v }))
  ];
  if (rows.length) await supabaseClient.from('recipe_tags').insert(rows);
}

async function saveIngredients(recipeId) {
  await supabaseClient.from('ingredients').delete().eq('recipe_id', recipeId);
  const rows = readIngredientRowsFromDom();
  const inserts = rows.map((ing, idx) => {
    const qty = ing.quantity === '' ? null : Number(ing.quantity);
    const conv = qty != null ? convertIngredientAmount(qty, ing.unit, ing.name, state.densityMap) : null;
    const originalSystem = ['g', 'kg'].includes(ing.unit) || ['ml', 'l'].includes(ing.unit)
      ? 'metric'
      : ['oz', 'lb', 'fl_oz', 'pint'].includes(ing.unit)
      ? 'imperial'
      : ['cup', 'tbsp', 'tsp'].includes(ing.unit)
      ? 'us_cups'
      : null;
    return {
      recipe_id: recipeId,
      sort_order: idx,
      name: ing.name,
      notes: ing.notes || null,
      original_quantity: qty,
      original_unit: ing.unit,
      original_system: originalSystem,
      metric_quantity: conv?.metric?.quantity ?? qty,
      metric_unit: conv?.metric?.unit ?? ing.unit,
      imperial_quantity: conv?.imperial?.quantity ?? qty,
      imperial_unit: conv?.imperial?.unit ?? ing.unit,
      us_cups_quantity: conv?.us_cups?.quantity ?? qty,
      us_cups_unit: conv?.us_cups?.unit ?? ing.unit
    };
  });
  if (inserts.length) await supabaseClient.from('ingredients').insert(inserts);
}

// ---------------------------------------------------------------------------
// Pantry / "what can I make?"
// ---------------------------------------------------------------------------

async function loadPantry() {
  const { data } = await supabaseClient.from('pantry_items').select('*').order('name');
  state.pantryItems = data || [];
  state.pantryMatches = null;
}

function renderPantry(root) {
  root.innerHTML = `
    <h2>What can I make?</h2>
    <p>List what you've got in and I'll rank your recipes by how many ingredients you already have.</p>
    <ul class="pantry-list" id="pantry-list">
      ${state.pantryItems.map((p) => `
        <li>
          <input value="${escapeHtml(p.name)}" data-id="${p.id}" data-field="name" onchange="updatePantryItem(this)" />
          <input value="${escapeHtml(p.quantity ?? '')}" type="number" style="max-width:90px" data-id="${p.id}" data-field="quantity" onchange="updatePantryItem(this)" />
          <input value="${escapeHtml(p.unit ?? '')}" style="max-width:80px" data-id="${p.id}" data-field="unit" onchange="updatePantryItem(this)" />
          <button class="btn-icon btn-danger" onclick="removePantryItem('${p.id}')"><i class="ti ti-x"></i></button>
        </li>
      `).join('')}
    </ul>
    <div class="field-row">
      <input id="new-pantry-name" placeholder="Add ingredient you have…" />
      <button onclick="addPantryItem()"><i class="ti ti-plus"></i> Add</button>
    </div>
    <button class="btn-primary" style="margin-top:16px" onclick="findRecipes()"><i class="ti ti-search"></i> Find recipes</button>

    <div id="pantry-matches" style="margin-top:20px">
      ${state.pantryMatches ? renderPantryMatches() : ''}
    </div>
  `;
}

async function addPantryItem() {
  const nameEl = document.getElementById('new-pantry-name');
  const name = nameEl.value.trim();
  if (!name) return;
  await supabaseClient.from('pantry_items').insert({ name, user_id: state.user.id });
  await loadPantry();
  renderPantry(document.getElementById('view-root'));
}

async function updatePantryItem(inputEl) {
  const id = inputEl.dataset.id;
  const field = inputEl.dataset.field;
  const value = field === 'quantity' ? numOrNull(inputEl.value) : inputEl.value;
  await supabaseClient.from('pantry_items').update({ [field]: value }).eq('id', id);
}

async function removePantryItem(id) {
  await supabaseClient.from('pantry_items').delete().eq('id', id);
  await loadPantry();
  renderPantry(document.getElementById('view-root'));
}

async function findRecipes() {
  const { data, error } = await supabaseClient.rpc('match_recipes_by_pantry', { p_user_id: state.user.id });
  if (error) { alert(error.message); return; }
  state.pantryMatches = data || [];
  document.getElementById('pantry-matches').innerHTML = renderPantryMatches();
}

function renderPantryMatches() {
  // A recipe with 0 matched ingredients isn't a match worth showing — it
  // just clutters the list with "0 of X ingredients on hand" entries.
  const matches = (state.pantryMatches || []).filter((m) => m.matched_ingredients > 0);
  if (matches.length === 0) return '<p>No matches yet — add a few pantry items and try again.</p>';
  return matches.map((m) => `
    <div class="match-result" onclick="goTo('detail', {id:'${m.recipe_id}'})" style="cursor:pointer">
      <div>
        <strong>${escapeHtml(m.title)}</strong>
        <div style="font-size:12px;color:var(--text-muted)">${m.matched_ingredients} of ${m.total_ingredients} ingredients on hand</div>
      </div>
      <div class="match-bar"><div class="match-bar-fill" style="width:${Math.round((m.match_ratio || 0) * 100)}%"></div></div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Shopping list — combine ingredients from selected recipes
// ---------------------------------------------------------------------------

// state.shoppingListEntries is a list of { recipeId, scale } — usually
// scale 1, but the planner's weekly shopping list and a single recipe's
// "Create shopping list" button (respecting its on-screen servings control)
// can carry a different scale per entry. If the same recipe shows up more
// than once with different scales (e.g. planned twice in a week at
// different headcounts), each occurrence contributes its own scaled amount
// rather than one overwriting the other.
async function loadShoppingList() {
  const entries = state.shoppingListEntries || [];
  if (entries.length === 0) { state.shoppingList = { recipeTitles: [], lines: [] }; return; }

  const recipeIds = [...new Set(entries.map((e) => e.recipeId))];
  const { data: recipes } = await supabaseClient.from('recipes').select('id, title').in('id', recipeIds);
  const { data: allIngredients, error } = await supabaseClient.from('ingredients').select('*').in('recipe_id', recipeIds);
  if (error) { console.error(error); state.shoppingList = { recipeTitles: [], lines: [] }; render(); return; }

  const scaledRows = [];
  for (const entry of entries) {
    const scale = entry.scale || 1;
    for (const row of (allIngredients || []).filter((i) => i.recipe_id === entry.recipeId)) {
      scaledRows.push(
        scale === 1 || row.original_quantity == null
          ? row
          : { ...row, original_quantity: row.original_quantity * scale }
      );
    }
  }

  const lines = aggregateIngredientsForShoppingList(scaledRows, state.shoppingListSystem, state.densityMap);
  state.shoppingList = {
    recipeTitles: (recipes || []).map((r) => r.title),
    lines
  };
  render();
}

function renderShoppingList(root) {
  const list = state.shoppingList;
  root.innerHTML = `
    <button onclick="goTo('browse')"><i class="ti ti-arrow-left"></i> Back to browse</button>
    <h2 style="margin-top:14px"><i class="ti ti-shopping-cart"></i> Shopping list</h2>
    ${!list ? '<p>Combining ingredients…</p>' : renderShoppingListBody(list)}
  `;
}

function renderShoppingListBody(list) {
  if (list.lines.length === 0) {
    return '<div class="empty-state"><p>No ingredients found for the selected recipes.</p></div>';
  }
  const plainText = shoppingListAsText(list);
  return `
    <p style="color:var(--text-muted);font-size:14px">
      From: ${list.recipeTitles.map(escapeHtml).join(', ')}
    </p>
    <div class="unit-toggle" style="margin-bottom:14px">
      ${['metric', 'imperial', 'us_cups'].map(
        (sys) => `<button class="${state.shoppingListSystem === sys ? 'active' : ''}" onclick="setShoppingListSystem('${sys}')">${sys === 'us_cups' ? 'US cups' : sys}</button>`
      ).join('')}
    </div>

    <ul class="ingredient-list">
      ${list.lines.map((line) => `<li><label style="display:flex;gap:8px;align-items:center;cursor:pointer;width:100%">
          <input type="checkbox" style="flex-shrink:0" onchange="this.parentElement.parentElement.classList.toggle('checked-off', this.checked)" />
          <span style="flex:1;min-width:0;text-align:left">${escapeHtml(formatShoppingListLine(line))}</span>
        </label></li>`).join('')}
    </ul>

    <div class="field" style="margin-top:18px">
      <label>Plain text (copy this into Reminders, Notes, or any to-do app)</label>
      <textarea id="shopping-list-text" rows="${Math.min(list.lines.length + 1, 16)}" readonly>${escapeHtml(plainText)}</textarea>
    </div>

    <div class="field-row">
      <button class="btn-primary" onclick="copyShoppingList()"><i class="ti ti-copy"></i> Copy to clipboard</button>
      <button onclick="shareShoppingList()"><i class="ti ti-share"></i> Share…</button>
    </div>
    <div id="shopping-list-status" class="error-text"></div>
  `;
}

function shoppingListAsText(list) {
  return list.lines.map(formatShoppingListLine).join('\n');
}

function setShoppingListSystem(sys) {
  state.shoppingListSystem = sys;
  loadShoppingList();
}

async function copyShoppingList() {
  const text = shoppingListAsText(state.shoppingList);
  const statusEl = document.getElementById('shopping-list-status');
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = 'Copied — paste it into Reminders, Notes, or your to-do app.';
    statusEl.style.color = 'var(--success)';
  } catch (err) {
    // clipboard API can be blocked in some contexts — fall back to manual select
    const textarea = document.getElementById('shopping-list-text');
    textarea.select();
    statusEl.textContent = 'Could not auto-copy — the text is selected, use Cmd/Ctrl+C.';
    statusEl.style.color = '';
  }
}

async function shareShoppingList() {
  const text = shoppingListAsText(state.shoppingList);
  const statusEl = document.getElementById('shopping-list-status');
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Shopping list', text });
    } catch (err) {
      // user cancelled the share sheet — nothing to report
    }
  } else {
    statusEl.textContent = 'Sharing isn\'t supported in this browser — use Copy to clipboard instead (on iPhone, Safari supports Share).';
  }
}

// ---------------------------------------------------------------------------
// Planner — weekly meal-slot grid, ties into the shopping list
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }
function formatDateISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function parseISODate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function getMonday(d) {
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = addDays(d, diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function formatDateShort(dateISO) {
  return parseISODate(dateISO).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

async function loadPlanner(weekStartISO) {
  const startDate = parseISODate(weekStartISO);
  const weekDates = Array.from({ length: 7 }, (_, i) => formatDateISO(addDays(startDate, i)));

  const { data: entries, error } = await supabaseClient
    .from('meal_plan_entries')
    .select('id, plan_date, meal_slot, recipe_id, servings, recipes(title, servings)')
    .gte('plan_date', weekDates[0])
    .lte('plan_date', weekDates[6]);
  if (error) console.error(error);

  // Each (date, slot) can now hold more than one dish (a main plus sides,
  // a starter, dessert, etc. all under the same meal occasion), so entryMap
  // holds an array of entries per key rather than a single one. `servings`
  // is an optional per-entry override (null = assume the recipe's own
  // normal servings, kept alongside as `recipeServings` for comparison and
  // for scaling the weekly shopping list).
  const entryMap = {};
  (entries || []).forEach((e) => {
    const key = `${e.plan_date}|${e.meal_slot}`;
    if (!entryMap[key]) entryMap[key] = [];
    entryMap[key].push({
      id: e.id, recipeId: e.recipe_id, title: e.recipes?.title || '(deleted recipe)',
      servings: e.servings, recipeServings: e.recipes?.servings ?? null
    });
  });

  state.viewParams = { weekStart: weekStartISO, weekDates, entryMap };
}

function renderPlanner(root) {
  const { weekDates, entryMap } = state.viewParams;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const distinctRecipeIds = new Set(Object.values(entryMap).flat().map((e) => e.recipeId));

  root.innerHTML = `
    <div class="field-row" style="align-items:center;justify-content:space-between">
      <h2 style="margin:0"><i class="ti ti-calendar-week"></i> Meal Planner</h2>
      <div class="field-row" style="margin:0">
        <button onclick="goToWeek(-1)"><i class="ti ti-chevron-left"></i></button>
        <button onclick="goToWeek(0)">This week</button>
        <button onclick="goToWeek(1)"><i class="ti ti-chevron-right"></i></button>
      </div>
    </div>
    <p style="color:var(--text-muted);font-size:13px;margin:6px 0 14px">${formatDateShort(weekDates[0])} – ${formatDateShort(weekDates[6])}</p>

    <div class="planner-scroll">
      <div class="planner-table">
        <div class="planner-cell planner-header"></div>
        ${weekDates.map((d, i) => `<div class="planner-cell planner-header">${dayNames[i]}<br>${formatDateShort(d)}</div>`).join('')}
        ${PLAN_SLOTS.map((slot) => `
          <div class="planner-cell planner-slot-label">${capitalizeFirst(slot)}</div>
          ${weekDates.map((d) => renderPlannerCell(d, slot, entryMap[`${d}|${slot}`] || [])).join('')}
        `).join('')}
      </div>
    </div>

    <div class="field-row" style="margin-top:16px">
      <button onclick="openMealPicker()"><i class="ti ti-plus"></i> Add a meal</button>
      <button class="btn-primary" onclick="createShoppingListFromWeek()" ${distinctRecipeIds.size ? '' : 'disabled'}>
        <i class="ti ti-shopping-cart"></i> Create shopping list from this week
      </button>
    </div>
  `;
}

// A slot can hold any number of dishes (main, sides, starter, dessert on a
// bigger occasion) rather than just one, so this always lists every entry
// for that date/slot and keeps an "+ Add" button available underneath to
// add another, rather than replacing it with a picker only when empty.
function renderPlannerCell(dateISO, slot, entries) {
  const dishesHtml = entries.map((entry) => {
    // An override only counts as one if it actually differs from the
    // recipe's own normal servings — otherwise there's nothing to flag.
    const overridden = entry.servings != null && entry.servings !== entry.recipeServings;
    return `
    <div class="planner-dish">
      <a href="#" onclick="goTo('detail', {id:'${entry.recipeId}'}); return false;">${escapeHtml(entry.title)}</a>
      <button class="btn-icon" onclick="openEditPlanEntryServingsModal('${entry.id}')" title="${overridden ? `Serving ${entry.servings} (normally ${entry.recipeServings})` : 'Set servings for this meal'}">${overridden ? `×${entry.servings}` : '<i class="ti ti-users" style="font-size:12px"></i>'}</button>
      <button class="btn-icon btn-danger" onclick="removePlanEntry('${entry.id}')" title="Remove"><i class="ti ti-x"></i></button>
    </div>
  `;
  }).join('');
  return `
    <div class="planner-cell planner-day-cell">
      ${dishesHtml}
      <button style="justify-content:center" onclick="openMealPicker('${dateISO}','${slot}')"><i class="ti ti-plus"></i> Add</button>
    </div>
  `;
}

async function assignPlanEntry(dateISO, slot, recipeId) {
  if (!recipeId) return;
  // A plain insert, not an upsert — a slot can hold several dishes now, so
  // adding a second (or third) recipe to the same date/slot should add
  // alongside what's already there instead of replacing it.
  const { error } = await supabaseClient.from('meal_plan_entries')
    .insert({ user_id: state.user.id, plan_date: dateISO, meal_slot: slot, recipe_id: recipeId });
  if (error) { alert(error.message); return; }
  await loadPlanner(state.viewParams.weekStart);
  renderPlanner(document.getElementById('view-root'));
}

async function removePlanEntry(entryId) {
  await supabaseClient.from('meal_plan_entries').delete().eq('id', entryId);
  await loadPlanner(state.viewParams.weekStart);
  renderPlanner(document.getElementById('view-root'));
}

// Per-dish servings override — lets a specific planned meal (e.g. Saturday's
// dinner) be made for a different headcount than the recipe's own normal
// servings, without changing the recipe itself. Feeds into the weekly
// shopping list via createShoppingListFromWeek's scaling.
function openEditPlanEntryServingsModal(entryId) {
  const entry = Object.values(state.viewParams.entryMap).flat().find((e) => e.id === entryId);
  if (!entry) return;
  const current = entry.servings ?? entry.recipeServings ?? '';
  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner" style="width:min(320px, 90vw)">
      <div class="field-row" style="justify-content:space-between;align-items:center;margin-bottom:2px">
        <h3 style="margin:0"><i class="ti ti-users"></i> Servings</h3>
        <button class="btn-icon" onclick="closeEditPlanEntryServingsModal()"><i class="ti ti-x"></i></button>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 10px">${escapeHtml(entry.title)}${entry.recipeServings ? ` — normally serves ${entry.recipeServings}` : ''}</p>
      <div class="field"><label>Servings for this meal</label><input type="number" min="1" step="1" id="eps-servings" value="${current}" /></div>
      <div class="field-row" style="margin-top:6px">
        <button class="btn-primary" onclick="saveEditPlanEntryServings('${entryId}')"><i class="ti ti-check"></i> Save</button>
        ${entry.servings != null ? `<button onclick="saveEditPlanEntryServings('${entryId}', true)">Reset to normal</button>` : ''}
        <button onclick="closeEditPlanEntryServingsModal()">Cancel</button>
      </div>
      <div id="eps-status" class="error-text" style="min-height:16px"></div>
    </div>
  `;
  document.body.appendChild(modal);
  state._editPlanEntryServingsModal = modal;
}

function closeEditPlanEntryServingsModal() {
  if (state._editPlanEntryServingsModal) state._editPlanEntryServingsModal.remove();
  state._editPlanEntryServingsModal = null;
}

async function saveEditPlanEntryServings(entryId, reset = false) {
  const statusEl = document.getElementById('eps-status');
  const servings = reset ? null : numOrNull(document.getElementById('eps-servings').value);
  const { error } = await supabaseClient.from('meal_plan_entries').update({ servings }).eq('id', entryId);
  if (error) { if (statusEl) statusEl.textContent = error.message; return; }
  closeEditPlanEntryServingsModal();
  await loadPlanner(state.viewParams.weekStart);
  renderPlanner(document.getElementById('view-root'));
}

function goToWeek(delta) {
  if (delta === 0) { goTo('planner', {}); return; }
  const newStart = formatDateISO(addDays(parseISODate(state.viewParams.weekStart), delta * 7));
  goTo('planner', { weekStart: newStart });
}

// Reuses the existing shopping-list feature (built for ticking recipes in
// Browse) by populating the same selection Set from this week's distinct
// planned recipes instead.
function createShoppingListFromWeek() {
  const allEntries = Object.values(state.viewParams.entryMap).flat();
  if (allEntries.length === 0) { alert('No meals planned for this week yet.'); return; }
  state.selectedRecipeIds = new Set(allEntries.map((e) => e.recipeId));
  // Each planned dish contributes its own scale — if a recipe is servings-
  // overridden for one occasion but not another (or planned twice with
  // different headcounts), each occurrence is scaled and summed separately
  // rather than one scale overwriting the other.
  state.shoppingListEntries = allEntries.map((e) => ({
    recipeId: e.recipeId,
    scale: (e.servings && e.recipeServings) ? e.servings / e.recipeServings : 1
  }));
  goTo('shopping-list');
}

// ---------------------------------------------------------------------------
// Meal picker — a filterable recipe picker for the planner, replacing what
// used to be a single <select> listing every recipe alphabetically (which
// gets unwieldy fast as the recipe count grows). Opens as a modal appended
// to <body> (same pattern as the crop tool) so it survives the planner grid
// behind it being re-rendered after each pick, and stays open so several
// meals can be added in one sitting instead of reopening it per cell.
// ---------------------------------------------------------------------------

async function openMealPicker(dateISO, slot) {
  const { weekDates } = state.viewParams;
  const { data: recipes, error } = await supabaseClient
    .from('recipes')
    .select('id, title, diet, recipe_tags(tag_type, tag_value)')
    .order('title');
  if (error) { alert(`Could not load recipes: ${error.message}`); return; }

  state.mealPicker = {
    dateISO: dateISO || weekDates[0],
    slot: slot || PLAN_SLOTS[0],
    recipes: recipes || [],
    // Opening from a specific cell (e.g. the Dessert column) defaults the
    // meal-type filter to match, since that's almost always what you want —
    // the filter is a normal visible dropdown, so it's one click to clear.
    filters: { mealType: slot && MEAL_TYPES.includes(slot) ? slot : '', mainIngredient: '', diet: '' }
  };
  renderMealPickerModal();
}

function closeMealPicker() {
  if (state._mealPickerModal) state._mealPickerModal.remove();
  state._mealPickerModal = null;
  state.mealPicker = null;
}

function renderMealPickerModal() {
  if (state._mealPickerModal) state._mealPickerModal.remove();
  const { weekDates } = state.viewParams;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const mp = state.mealPicker;

  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner" style="width:min(560px, 94vw)">
      <div class="field-row" style="justify-content:space-between;align-items:center;margin-bottom:2px">
        <h3 style="margin:0"><i class="ti ti-calendar-plus"></i> Add a meal</h3>
        <button class="btn-icon" onclick="closeMealPicker()"><i class="ti ti-x"></i></button>
      </div>
      <div class="field-row">
        <div class="field"><label>Day</label>
          <select id="mp-day">
            ${weekDates.map((d, i) => `<option value="${d}" ${d === mp.dateISO ? 'selected' : ''}>${dayNames[i]} ${formatDateShort(d)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Meal</label>
          <select id="mp-slot">
            ${PLAN_SLOTS.map((s) => `<option value="${s}" ${s === mp.slot ? 'selected' : ''}>${capitalizeFirst(s)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Meal type</label>
          <select onchange="updateMealPickerFilter('mealType', this.value)">
            <option value="">All meal types</option>
            ${MEAL_TYPES.map((m) => `<option value="${m}" ${mp.filters.mealType === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Main ingredient</label>
          <input placeholder="e.g. chicken" oninput="updateMealPickerFilter('mainIngredient', this.value)" />
        </div>
        <div class="field"><label>Diet</label>
          <select onchange="updateMealPickerFilter('diet', this.value)">
            <option value="">Any diet</option>
            ${DIETS.map((d) => `<option value="${d}" ${mp.filters.diet === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="meal-picker-status" class="error-text" style="min-height:16px"></div>
      <div id="meal-picker-results" style="max-height:320px;overflow-y:auto;border-top:1px solid var(--border);margin-top:4px"></div>
    </div>
  `;
  document.body.appendChild(modal);
  state._mealPickerModal = modal;
  renderMealPickerResults();
}

function filterMealPickerRecipes() {
  const { recipes, filters } = state.mealPicker;
  const needle = filters.mainIngredient.trim().toLowerCase();
  return recipes.filter((r) => {
    if (filters.mealType && !r.recipe_tags.some((t) => t.tag_type === 'meal_type' && t.tag_value === filters.mealType)) return false;
    if (filters.diet && r.diet !== filters.diet) return false;
    if (needle && !r.recipe_tags.some((t) => t.tag_type === 'main_ingredient' && t.tag_value.toLowerCase().includes(needle))) return false;
    return true;
  });
}

// Only rebuilds the results list, not the whole modal — the filter inputs
// above are left alone so typing in "Main ingredient" doesn't lose focus
// the same way the old Browse search box used to (see updateFilter).
function updateMealPickerFilter(key, value) {
  state.mealPicker.filters[key] = value;
  renderMealPickerResults();
}

function renderMealPickerResults() {
  const results = document.getElementById('meal-picker-results');
  if (!results) return;
  const matches = filterMealPickerRecipes();
  results.innerHTML = matches.length
    ? matches.map((r) => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--border);cursor:pointer" ondblclick="pickMealPickerRecipe('${r.id}')">
          <span>${escapeHtml(r.title)}${r.diet !== 'none' ? ` <span class="tag diet-${r.diet}">${r.diet}</span>` : ''}</span>
          <button onclick="pickMealPickerRecipe('${r.id}')">Add</button>
        </div>
      `).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:10px 2px">No recipes match those filters.</p>';
}

async function pickMealPickerRecipe(recipeId) {
  const dateISO = document.getElementById('mp-day').value;
  const slot = document.getElementById('mp-slot').value;
  const recipe = state.mealPicker.recipes.find((r) => r.id === recipeId);
  await assignPlanEntry(dateISO, slot, recipeId);
  const statusEl = document.getElementById('meal-picker-status');
  if (statusEl) {
    statusEl.textContent = `Added "${recipe?.title || 'recipe'}" to ${capitalizeFirst(slot)} on ${formatDateShort(dateISO)}. Pick another, or close when done.`;
    statusEl.style.color = 'var(--success)';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    await bootAfterAuth();
  } else {
    render();
  }
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (!session) { state.user = null; render(); }
  });
})();
