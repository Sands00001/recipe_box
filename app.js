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

let state = {
  user: null,
  currentView: 'loading',
  viewParams: {},
  recipes: [],
  densityMap: {},
  filters: { search: '', mealType: '', mainIngredient: '', diet: '', source: '' },
  pantryItems: [],
  pantryMatches: null,
  cropper: null, // active Cropper.js instance while the crop modal is open
  selectedRecipeIds: new Set(), // recipes ticked in Browse, for the shopping list
  shoppingList: null, // { recipeTitles, system, lines } once generated
  shoppingListSystem: 'metric'
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
  else root.innerHTML = '<p>Loading…</p>';
}

async function goTo(view, params = {}) {
  state.currentView = view;
  state.viewParams = params;
  if (view === 'browse') await loadRecipes();
  if (view === 'detail') await loadRecipeDetail(params.id);
  if (view === 'edit') await loadEditForm(params.id);
  if (view === 'pantry') await loadPantry();
  if (view === 'shopping-list') { render(); await loadShoppingList(); return; } // render loading state first, list fetch is async
  render();
}

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
  goTo('browse');
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

async function loadRecipes() {
  let query = supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').order('created_at', { ascending: false });
  if (state.filters.diet) query = query.eq('diet', state.filters.diet);
  if (state.filters.source) query = query.eq('source', state.filters.source);
  if (state.filters.search) query = query.ilike('title', `%${state.filters.search}%`);
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
      <input placeholder="Search title…" value="${escapeHtml(f.search)}" oninput="updateFilter('search', this.value)" />
      <select onchange="updateFilter('mealType', this.value)">
        <option value="">All meal types</option>
        ${MEAL_TYPES.map((m) => `<option value="${m}" ${f.mealType === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
      <input placeholder="Main ingredient…" value="${escapeHtml(f.mainIngredient)}" oninput="updateFilter('mainIngredient', this.value)" />
      <select onchange="updateFilter('diet', this.value)">
        <option value="">Any diet</option>
        ${DIETS.map((d) => `<option value="${d}" ${f.diet === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select>
      <select onchange="updateFilter('source', this.value)">
        <option value="">Any source</option>
        ${SOURCES.map((s) => `<option value="${s}" ${f.source === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    ${state.recipes.length === 0 ? '<div class="empty-state"><i class="ti ti-tools-kitchen-2" style="font-size:40px"></i><p>No recipes yet — add your first one.</p></div>' : ''}
    <div class="recipe-grid">
      ${state.recipes.map(renderRecipeCard).join('')}
    </div>
    ${renderSelectionBar()}
  `;
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
      ${r.image_url ? `<img src="${escapeHtml(r.image_url)}" alt="">` : `<div class="no-image"><i class="ti ti-tools-kitchen-2"></i></div>`}
      <div class="recipe-card-body">
        <h3>${escapeHtml(r.title)}</h3>
        <div class="tag-row">
          ${mealTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${ingTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${r.diet !== 'none' ? `<span class="tag diet-${r.diet}">${r.diet}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderSelectionBar() {
  const count = state.selectedRecipeIds.size;
  if (count === 0) return '';
  return `
    <div class="selection-bar">
      <span>${count} recipe${count === 1 ? '' : 's'} selected</span>
      <div class="field-row" style="margin:0">
        <button onclick="clearSelection()">Clear</button>
        <button class="btn-primary" onclick="goTo('shopping-list')"><i class="ti ti-shopping-cart"></i> Create shopping list</button>
      </div>
    </div>
  `;
}

function toggleRecipeSelection(id) {
  if (state.selectedRecipeIds.has(id)) state.selectedRecipeIds.delete(id);
  else state.selectedRecipeIds.add(id);
  renderBrowse(document.getElementById('view-root'));
}

function clearSelection() {
  state.selectedRecipeIds.clear();
  renderBrowse(document.getElementById('view-root'));
}

function updateFilter(key, value) {
  state.filters[key] = value;
  loadRecipes().then(() => renderBrowse(document.getElementById('view-root')));
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

async function loadRecipeDetail(id) {
  const { data: recipe } = await supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').eq('id', id).single();
  const { data: ingredients } = await supabaseClient.from('ingredients').select('*').eq('recipe_id', id).order('sort_order');
  const { data: photos } = await supabaseClient.from('recipe_photos').select('*').eq('recipe_id', id).order('sort_order');
  state.viewParams = { id, recipe, ingredients: ingredients || [], photos: photos || [], displaySystem: recipe?.preferred_unit_system || 'metric' };
}

function renderDetail(root) {
  const { recipe, ingredients, photos, displaySystem } = state.viewParams;
  if (!recipe) { root.innerHTML = '<p>Recipe not found.</p>'; return; }

  const mealTags = recipe.recipe_tags.filter((t) => t.tag_type === 'meal_type').map((t) => t.tag_value);
  const ingTags = recipe.recipe_tags.filter((t) => t.tag_type === 'main_ingredient').map((t) => t.tag_value);
  const otherPhotos = (photos || []).filter((p) => p.url !== recipe.image_url);

  root.innerHTML = `
    <button onclick="goTo('browse')"><i class="ti ti-arrow-left"></i> Back</button>
    <div class="recipe-detail-header" style="margin-top:14px">
      ${recipe.image_url ? `<img src="${escapeHtml(recipe.image_url)}">` : ''}
      <div style="flex:1; min-width:220px">
        <h2 style="margin:0 0 8px">${escapeHtml(recipe.title)}</h2>
        <div class="tag-row">
          ${mealTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${ingTags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          ${recipe.diet !== 'none' ? `<span class="tag diet-${recipe.diet}">${recipe.diet}</span>` : ''}
          <span class="tag">${escapeHtml(recipe.source)}</span>
        </div>
        <div class="meta-row">
          ${recipe.servings ? `<span><i class="ti ti-users"></i> ${recipe.servings} servings</span>` : ''}
          ${recipe.prep_time_minutes ? `<span><i class="ti ti-clock"></i> Prep ${recipe.prep_time_minutes} min</span>` : ''}
          ${recipe.cook_time_minutes ? `<span><i class="ti ti-flame"></i> Cook ${recipe.cook_time_minutes} min</span>` : ''}
          ${recipe.oven_temp_c ? `<span><i class="ti ti-temperature"></i> ${recipe.oven_temp_c}°C / ${recipe.oven_temp_f}°F / Gas ${recipe.oven_gas_mark}</span>` : ''}
        </div>
        ${otherPhotos.length ? `
          <div class="tag-row" style="margin-top:8px">
            ${otherPhotos.map((p) => `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.url)}" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border)"></a>`).join('')}
          </div>` : ''}
        <div class="field-row" style="margin-top:10px">
          <button onclick="goTo('edit', {id:'${recipe.id}'})"><i class="ti ti-edit"></i> Edit</button>
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
      ${ingredients.map((i) => renderIngredientLine(i, displaySystem)).join('')}
    </ul>

    <h3 style="margin-top:24px">Method</h3>
    <p style="white-space:pre-wrap">${escapeHtml(recipe.instructions)}</p>
    ${recipe.notes ? `<h3>Notes</h3><p style="white-space:pre-wrap">${escapeHtml(recipe.notes)}</p>` : ''}
  `;
}

function renderIngredientLine(ing, system) {
  const amt = ing[`${system}_quantity`];
  const unit = ing[`${system}_unit`];
  const approx = system === 'us_cups' && amt != null && ing.original_system && ing.original_system !== 'us_cups' && !state.densityMap[ing.name.toLowerCase()];
  const amountText = amt != null ? `${amt} ${unit === 'whole' ? '' : unit}` : '';
  return `<li><span>${escapeHtml(ing.name)}${ing.notes ? `, ${escapeHtml(ing.notes)}` : ''}</span>
    <span>${escapeHtml(amountText)}${approx ? ' <span class="approx-note">(approx.)</span>' : ''}</span></li>`;
}

function setDisplaySystem(sys) {
  state.viewParams.displaySystem = sys;
  renderDetail(document.getElementById('view-root'));
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe? This cannot be undone.')) return;
  await supabaseClient.from('recipes').delete().eq('id', id);
  goTo('browse');
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
      photos: [], originalPhotoIds: []
    };
    return;
  }
  const { data: recipe } = await supabaseClient.from('recipes').select('*, recipe_tags(tag_type, tag_value)').eq('id', id).single();
  const { data: ingredients } = await supabaseClient.from('ingredients').select('*').eq('recipe_id', id).order('sort_order');
  const { data: existingPhotos } = await supabaseClient.from('recipe_photos').select('*').eq('recipe_id', id).order('sort_order');
  const photos = (existingPhotos || []).map((p) => ({
    id: p.id, url: p.url, blob: null, mimeType: null, previewUrl: p.url, isThumbnail: p.is_thumbnail
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
    originalPhotoIds: photos.map((p) => p.id)
  };
}

function emptyIngredientRow() {
  return { name: '', quantity: '', unit: 'g', notes: '' };
}

function renderEdit(root) {
  const { recipe, mealTypes, mainIngredients, ingredients, photos, id } = state.viewParams;
  root.innerHTML = `
    <button onclick="goTo('browse')"><i class="ti ti-arrow-left"></i> Back</button>
    <h2 style="margin-top:14px">${id === 'new' ? 'Add recipe' : 'Edit recipe'}</h2>

    <div class="field">
      <label>Photos (front/back of a card, multiple pages, etc.)</label>
      <input type="file" accept="image/*" capture="environment" onchange="handlePhotoSelected(event)" />
      <div id="photo-list">${renderPhotoList(photos)}</div>
      <div class="field-row" style="margin-top:8px">
        <button id="scan-btn" onclick="scanWithAI()" ${photos.length ? '' : 'disabled'}><i class="ti ti-sparkles"></i> Scan selected photo(s) with AI to prefill</button>
      </div>
      <div id="scan-status" class="error-text"></div>
    </div>

    <div class="field"><label>Title</label><input id="f-title" value="${escapeHtml(recipe.title)}" /></div>

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

function renderPhotoList(photos) {
  if (!photos || photos.length === 0) return '<p style="font-size:13px;color:var(--text-muted);margin:8px 0 0">No photos yet — add one below.</p>';
  return `
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:10px">
      ${photos.map((p, idx) => `
        <div class="photo-card">
          <img src="${escapeHtml(p.previewUrl)}">
          <label>
            <input type="radio" name="thumbnail-radio" ${p.isThumbnail ? 'checked' : ''} onchange="setThumbnail(${idx})" /> Thumbnail
          </label>
          <label>
            <input type="checkbox" class="photo-scan-chk" data-idx="${idx}" ${p.id ? '' : 'checked'} /> Include in scan
          </label>
          <button class="btn-icon btn-danger" onclick="removePhoto(${idx})"><i class="ti ti-x"></i> Remove</button>
        </div>
      `).join('')}
    </div>
  `;
}

function setThumbnail(idx) {
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

function handlePhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => openCropModal(reader.result, file.type);
  reader.readAsDataURL(file);
  event.target.value = ''; // allow re-selecting the same file later
}

function openCropModal(dataUrl, mimeType) {
  const modal = document.createElement('div');
  modal.className = 'crop-modal';
  modal.innerHTML = `
    <div class="crop-modal-inner">
      <p style="margin-top:0;font-size:13px;color:var(--text-muted)">Drag the corners to crop and use the rotate buttons if it's sideways, then click <strong>Use this crop</strong> below — the photo isn't attached until you do.</p>
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
  state.cropper = null;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function stagePhotoBlob(blob, mimeType) {
  const previewUrl = URL.createObjectURL(blob);
  const photos = state.viewParams.photos;
  photos.push({
    id: null, url: null, blob, mimeType: mimeType || 'image/jpeg', previewUrl,
    isThumbnail: photos.length === 0
  });
  cancelCrop();
  document.getElementById('photo-list').innerHTML = renderPhotoList(photos);
  document.getElementById('scan-btn').disabled = false;
}

async function confirmCrop(mimeType) {
  if (state.cropper) {
    const canvas = state.cropper.getCroppedCanvas({ maxWidth: 1400, maxHeight: 1400 });
    canvas.toBlob((blob) => stagePhotoBlob(blob, mimeType), mimeType || 'image/jpeg', 0.9);
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
  canvas.toBlob((blob) => stagePhotoBlob(blob, mimeType), mimeType || 'image/jpeg', 0.9);
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
  if (checkedIdx.length === 0) { alert('Tick "Include in scan" on at least one photo first.'); return; }

  const statusEl = document.getElementById('scan-status');
  statusEl.textContent = 'Reading recipe with AI…';
  try {
    const images = [];
    for (const idx of checkedIdx) {
      const p = photos[idx];
      if (!p.blob) {
        // Already-saved photo — only has a URL so far, fetch it once and cache the blob.
        const resp = await fetch(p.url);
        p.blob = await resp.blob();
        p.mimeType = p.blob.type || 'image/jpeg';
      }
      const scanBlob = await resizeImageForScan(p.blob);
      images.push({ imageBase64: await blobToBase64(scanBlob), mimeType: 'image/jpeg' });
    }
    const { data, error } = await supabaseClient.functions.invoke('extract-recipe', { body: { images } });
    if (error) throw error;
    applyExtractedRecipe(data.data);
    statusEl.textContent = 'Prefilled — please check the details before saving.';
  } catch (err) {
    const hint = /send a request/i.test(err.message || '')
      ? ' (the request didn\'t reach the server — check your connection, or try scanning fewer photos at once)'
      : '';
    statusEl.textContent = `Could not read the photo(s): ${err.message || err}${hint}`;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
      name: i.name, quantity: i.quantity ?? '', unit: i.unit || 'g', notes: i.notes || ''
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

  const thumbnail = photos.find((p) => p.isThumbnail) || photos[0] || null;
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
  if (!state.pantryMatches || state.pantryMatches.length === 0) return '<p>No matches yet — add a few pantry items and try again.</p>';
  return state.pantryMatches.map((m) => `
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

async function loadShoppingList() {
  const ids = Array.from(state.selectedRecipeIds);
  if (ids.length === 0) { state.shoppingList = { recipeTitles: [], lines: [] }; return; }

  const { data: recipes } = await supabaseClient.from('recipes').select('id, title').in('id', ids);
  const { data: ingredients, error } = await supabaseClient.from('ingredients').select('*').in('recipe_id', ids);
  if (error) { console.error(error); state.shoppingList = { recipeTitles: [], lines: [] }; render(); return; }

  const lines = aggregateIngredientsForShoppingList(ingredients, state.shoppingListSystem, state.densityMap);
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
      ${list.lines.map((line) => `<li><label style="display:flex;gap:8px;align-items:center;cursor:pointer">
          <input type="checkbox" onchange="this.parentElement.parentElement.classList.toggle('checked-off', this.checked)" />
          <span>${escapeHtml(formatShoppingListLine(line))}</span>
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
