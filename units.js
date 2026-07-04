/**
 * units.js — conversion engine for Recipe Box.
 *
 * Three ingredient unit systems, matching how the recipe cards actually
 * write things out:
 *   metric   — g / kg / ml / l
 *   imperial — oz / lb / fl oz / pint   (UK imperial, e.g. 1 fl oz = 28.4131ml)
 *   us_cups  — cup / tbsp / tsp / oz    (US customary, e.g. 1 cup = 236.588ml)
 *
 * Weight <-> volume (e.g. "125g flour" <-> "1 cup flour") needs a *density*,
 * not just a fixed factor — that's what ingredient_density_reference is for.
 * Without a density match, we fall back to the closest sensible unit and
 * flag the amount as approximate so the user can correct it by hand.
 *
 * No build step / no dependencies — plain script, loaded via <script src="units.js">
 * before app.js, same as the rest of this app.
 */

const WEIGHT_TO_GRAMS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_TO_ML = {
  ml: 1,
  l: 1000,
  tsp: 5,          // practical rounding, used the same in UK & US recipes
  tbsp: 15,
  fl_oz: 28.4131,  // UK imperial fluid ounce
  pint: 568.261,   // UK imperial pint
  cup: 236.588,    // US cup
  us_tbsp: 14.7868,
  us_tsp: 4.92892
};

const WEIGHT_UNITS = new Set(['g', 'kg', 'oz', 'lb']);
const VOLUME_UNITS = new Set(['ml', 'l', 'tsp', 'tbsp', 'fl_oz', 'pint', 'cup', 'us_tbsp', 'us_tsp']);

function classifyUnit(unit) {
  const u = (unit || '').toLowerCase().trim();
  if (WEIGHT_UNITS.has(u)) return 'weight';
  if (VOLUME_UNITS.has(u)) return 'volume';
  return 'count'; // e.g. "clove", "whole", "slice", "pinch" — passed through unchanged
}

function round(n, dp = 1) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// ---- weight ----------------------------------------------------------

function toGrams(qty, unit) {
  const factor = WEIGHT_TO_GRAMS[unit.toLowerCase()];
  if (!factor) throw new Error(`Unknown weight unit: ${unit}`);
  return qty * factor;
}

function formatWeightMetric(grams) {
  if (grams >= 1000) return { quantity: round(grams / 1000, 2), unit: 'kg' };
  return { quantity: round(grams, 0), unit: 'g' };
}

function formatWeightImperial(grams) {
  const oz = grams / WEIGHT_TO_GRAMS.oz;
  if (oz >= 16) return { quantity: round(oz / 16, 2), unit: 'lb' };
  return { quantity: round(oz, 1), unit: 'oz' };
}

// Solid ingredient by weight -> best US-cup-ish representation.
// Needs a density (g per US cup). Falls back to oz if we don't have one.
function gramsToUsMeasure(grams, ingredientName, densityMap) {
  const density = lookupDensity(ingredientName, densityMap);
  if (density) {
    const cups = grams / density;
    if (cups < 0.06) return { quantity: round(grams / WEIGHT_TO_GRAMS.oz, 1), unit: 'oz', approximate: false };
    return { quantity: round(cups, 2), unit: 'cup', approximate: false };
  }
  // no density data — show oz and flag it so the UI can offer a note
  return { quantity: round(grams / WEIGHT_TO_GRAMS.oz, 1), unit: 'oz', approximate: true };
}

// ---- volume ------------------------------------------------------------

function toMl(qty, unit) {
  const factor = VOLUME_TO_ML[unit.toLowerCase()];
  if (!factor) throw new Error(`Unknown volume unit: ${unit}`);
  return qty * factor;
}

function formatVolumeMetric(ml) {
  if (ml >= 1000) return { quantity: round(ml / 1000, 2), unit: 'l' };
  return { quantity: round(ml, 0), unit: 'ml' };
}

function formatVolumeImperial(ml) {
  const flOz = ml / VOLUME_TO_ML.fl_oz;
  if (flOz >= 20) return { quantity: round(ml / VOLUME_TO_ML.pint, 2), unit: 'pint' };
  return { quantity: round(flOz, 1), unit: 'fl_oz' };
}

function formatVolumeUsCups(ml) {
  const cups = ml / VOLUME_TO_ML.cup;
  if (cups >= 0.24) return { quantity: round(cups, 2), unit: 'cup' };
  const tbsp = ml / VOLUME_TO_ML.us_tbsp;
  if (tbsp >= 1) return { quantity: round(tbsp, 1), unit: 'tbsp' };
  return { quantity: round(ml / VOLUME_TO_ML.us_tsp, 1), unit: 'tsp' };
}

// ---- density lookup ------------------------------------------------------

function lookupDensity(ingredientName, densityMap) {
  if (!ingredientName || !densityMap) return null;
  const key = ingredientName.toLowerCase().trim();
  if (densityMap[key]) return densityMap[key];
  // loose partial match, e.g. "plain flour" ~ "flour, plain"
  const match = Object.keys(densityMap).find(
    (k) => key.includes(k.split(',')[0]) || k.includes(key)
  );
  return match ? densityMap[match] : null;
}

// ---- public entry point --------------------------------------------------

/**
 * Convert a single ingredient amount into all three unit systems.
 *
 * @param {number} quantity
 * @param {string} unit            e.g. 'g', 'cup', 'tbsp', 'oz', 'whole'
 * @param {string} ingredientName  used for density lookup on weight<->cup conversions
 * @param {object} densityMap      { 'flour, plain': 125, ... } grams per US cup
 * @returns {{metric: object, imperial: object, us_cups: object, kind: string}}
 */
function convertIngredientAmount(quantity, unit, ingredientName, densityMap) {
  const kind = classifyUnit(unit);

  if (kind === 'count' || quantity == null || unit == null) {
    const passthrough = { quantity, unit };
    return { kind: 'count', metric: passthrough, imperial: passthrough, us_cups: passthrough };
  }

  if (kind === 'weight') {
    const grams = toGrams(quantity, unit);
    return {
      kind,
      metric: formatWeightMetric(grams),
      imperial: formatWeightImperial(grams),
      us_cups: gramsToUsMeasure(grams, ingredientName, densityMap)
    };
  }

  // volume
  const ml = toMl(quantity, unit);
  return {
    kind,
    metric: formatVolumeMetric(ml),
    imperial: formatVolumeImperial(ml),
    us_cups: formatVolumeUsCups(ml)
  };
}

// ---- oven temperature (recipe-level, not per-ingredient) -----------------

const GAS_MARK_TABLE = [
  { gasMark: 0.25, c: 110, f: 225 },
  { gasMark: 0.5, c: 120, f: 250 },
  { gasMark: 1, c: 140, f: 275 },
  { gasMark: 2, c: 150, f: 300 },
  { gasMark: 3, c: 160, f: 325 },
  { gasMark: 4, c: 180, f: 350 },
  { gasMark: 5, c: 190, f: 375 },
  { gasMark: 6, c: 200, f: 400 },
  { gasMark: 7, c: 220, f: 425 },
  { gasMark: 8, c: 230, f: 450 },
  { gasMark: 9, c: 240, f: 475 }
];

function celsiusToFahrenheit(c) {
  return round((c * 9) / 5 + 32, 0);
}

function fahrenheitToCelsius(f) {
  return round(((f - 32) * 5) / 9, 0);
}

function celsiusToGasMark(c) {
  let closest = GAS_MARK_TABLE[0];
  for (const row of GAS_MARK_TABLE) {
    if (Math.abs(row.c - c) < Math.abs(closest.c - c)) closest = row;
  }
  return closest.gasMark;
}

function gasMarkToCelsius(gasMark) {
  const row = GAS_MARK_TABLE.find((r) => r.gasMark === gasMark);
  return row ? row.c : null;
}

/** Given any one of {c, f, gasMark}, fill in the other two. */
function normalizeOvenTemp({ c, f, gasMark }) {
  if (c != null) return { c, f: celsiusToFahrenheit(c), gasMark: celsiusToGasMark(c) };
  if (f != null) {
    const derivedC = fahrenheitToCelsius(f);
    return { c: derivedC, f, gasMark: celsiusToGasMark(derivedC) };
  }
  if (gasMark != null) {
    const derivedC = gasMarkToCelsius(gasMark);
    return { c: derivedC, f: derivedC != null ? celsiusToFahrenheit(derivedC) : null, gasMark };
  }
  return { c: null, f: null, gasMark: null };
}

// Build a plain lookup object from the ingredient_density_reference rows
// fetched from Supabase: [{ingredient_name, grams_per_us_cup}, ...] -> {name: grams}
function buildDensityMap(rows) {
  const map = {};
  for (const row of rows || []) {
    map[row.ingredient_name.toLowerCase()] = row.grams_per_us_cup;
  }
  return map;
}

// ---- shopping list: combine ingredients across several recipes ----------

/**
 * Merge ingredient rows from multiple recipes into one shopping list,
 * summing quantities per ingredient name and re-expressing the total in a
 * single target unit system. Weight and volume are summed on a common base
 * unit (grams / ml) so e.g. "200g flour" + "1kg flour" adds correctly even
 * though they were entered in different units; count-style units (e.g.
 * "whole", "clove") are summed per distinct unit label since they can't be
 * converted into one another.
 *
 * @param {Array} ingredientRows  rows from the `ingredients` table (needs
 *   name, original_quantity, original_unit) across all selected recipes
 * @param {string} targetSystem   'metric' | 'imperial' | 'us_cups'
 * @param {object} densityMap     from buildDensityMap()
 * @returns {Array<{name, quantity, unit, approximate}>} sorted by name
 */
function aggregateIngredientsForShoppingList(ingredientRows, targetSystem, densityMap) {
  const groups = {};

  for (const row of ingredientRows || []) {
    if (!row.name) continue;
    const key = row.name.trim().toLowerCase();
    if (!groups[key]) {
      groups[key] = { name: row.name.trim(), weightGrams: 0, volumeMl: 0, counts: {}, hasWeight: false, hasVolume: false };
    }
    const g = groups[key];
    const qty = row.original_quantity;
    if (qty == null || row.original_unit == null) continue;

    const kind = classifyUnit(row.original_unit);
    if (kind === 'weight') {
      g.weightGrams += toGrams(qty, row.original_unit);
      g.hasWeight = true;
    } else if (kind === 'volume') {
      g.volumeMl += toMl(qty, row.original_unit);
      g.hasVolume = true;
    } else {
      const label = row.original_unit || 'whole';
      g.counts[label] = (g.counts[label] || 0) + qty;
    }
  }

  const lines = [];
  for (const key in groups) {
    const g = groups[key];

    // If an ingredient was measured by weight in one recipe and by volume
    // (e.g. cups) in another, they need a density to be combined into one
    // total at all — e.g. "200g flour" + "1 cup flour" only add up once we
    // know grams-per-cup for flour.
    if (g.hasWeight && g.hasVolume) {
      const density = lookupDensity(g.name, densityMap);
      if (density) {
        const cupsEquivalent = g.volumeMl / VOLUME_TO_ML.cup;
        g.weightGrams += cupsEquivalent * density;
        g.hasVolume = false; // folded into weight, now a single combined total
      }
      // no density match: fall through and report both totals separately,
      // each flagged, so the person notices they need to add these by hand.
    }

    if (g.hasWeight) {
      const formatted =
        targetSystem === 'metric' ? formatWeightMetric(g.weightGrams)
        : targetSystem === 'imperial' ? formatWeightImperial(g.weightGrams)
        : gramsToUsMeasure(g.weightGrams, g.name, densityMap);
      const stillSplit = g.hasVolume; // density lookup failed above
      lines.push({ name: g.name, quantity: formatted.quantity, unit: formatted.unit, approximate: !!formatted.approximate || stillSplit });
    }
    if (g.hasVolume) {
      const formatted =
        targetSystem === 'metric' ? formatVolumeMetric(g.volumeMl)
        : targetSystem === 'imperial' ? formatVolumeImperial(g.volumeMl)
        : formatVolumeUsCups(g.volumeMl);
      lines.push({ name: g.name, quantity: formatted.quantity, unit: formatted.unit, approximate: g.hasWeight });
    }
    for (const label in g.counts) {
      lines.push({ name: g.name, quantity: round(g.counts[label], 2), unit: label === 'whole' ? '' : label, approximate: false });
    }
  }

  lines.sort((a, b) => a.name.localeCompare(b.name));
  return lines;
}

const UNIT_DISPLAY_NAMES = {
  g: 'g', kg: 'kg', ml: 'ml', l: 'l', oz: 'oz', lb: 'lb',
  fl_oz: 'fl oz', pint: 'pint', cup: 'cup', tbsp: 'tbsp', tsp: 'tsp'
};

/** Format one aggregated line as plain text, e.g. "250g flour" or "3 tbsp honey". */
function formatShoppingListLine(line) {
  const spacedUnits = new Set(['tbsp', 'tsp', 'fl_oz', 'pint', 'cup', 'lb']);
  let qtyUnit = '';
  if (line.unit) {
    const label = UNIT_DISPLAY_NAMES[line.unit] || line.unit;
    const pluralLabel = line.quantity !== 1 && line.unit === 'cup' ? 'cups' : label;
    qtyUnit = spacedUnits.has(line.unit) ? `${line.quantity} ${pluralLabel}` : `${line.quantity}${label}`;
  } else if (line.quantity != null) {
    qtyUnit = `${line.quantity}`;
  }
  const base = `${qtyUnit} ${line.name}`.replace(/\s+/g, ' ').trim();
  return line.approximate ? `${base} (approx.)` : base;
}
