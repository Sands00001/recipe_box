// Supabase Edge Function: extract-recipe
//
// Takes a photo of a recipe card/page (base64) and asks Claude's vision
// model to read it and return structured recipe data. Runs server-side so
// the Anthropic API key never reaches the browser.
//
// Deploy:   supabase functions deploy extract-recipe
// Secret:   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// Call from client:
//   const { data, error } = await supabase.functions.invoke('extract-recipe', {
//     body: { imageBase64, mimeType: 'image/jpeg' }
//   });

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const EXTRACTION_PROMPT = `You are reading a photograph or scan of a recipe (it may be a printed \
Gousto-style recipe card, a handwritten card, or a page from a cookbook). \
Transcribe it into structured JSON only, no other text, matching exactly this shape:

{
  "title": string,
  "servings": number | null,
  "prep_time_minutes": number | null,
  "cook_time_minutes": number | null,
  "oven_temp_c": number | null,
  "oven_temp_f": number | null,
  "oven_gas_mark": number | null,
  "ingredients": [
    { "name": string, "quantity": number | null, "unit": string | null, "notes": string | null }
  ],
  "instructions": string,
  "meal_type_guess": string | null,
  "main_ingredient_guess": string[] | null,
  "diet_guess": "none" | "vegetarian" | "vegan" | null
}

Rules:
- unit must be one of: g, kg, ml, l, tsp, tbsp, fl_oz, pint, cup, oz, lb, or "whole" for count items (e.g. "2 whole onions" -> quantity 2, unit "whole").
- If the card gives oven temperature in only one scale, convert to fill the others as best you can, but prefer the card's own stated numbers when more than one is given.
- instructions should be the numbered/step method as plain text with steps separated by newlines.
- If a field truly isn't present on the card, use null. Do not invent values.
- Respond with ONLY the JSON object, no markdown fences, no commentary.`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY secret is not set on this Supabase project.');
    }

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) throw new Error('imageBase64 is required');

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType || 'image/jpeg',
                  data: imageBase64
                }
              },
              { type: 'text', text: EXTRACTION_PROMPT }
            ]
          }
        ]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Anthropic API error (${anthropicRes.status}): ${errText}`);
    }

    const anthropicJson = await anthropicRes.json();
    const rawText = anthropicJson.content?.[0]?.text ?? '';

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // model occasionally wraps in fences despite instructions — strip and retry
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    }

    return new Response(JSON.stringify({ data: parsed }), {
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' }
    });
  }
});
