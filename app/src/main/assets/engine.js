/*
 * PlateEngine — pure logic for offline recognition (no DOM, testable in Node).
 *
 * Embeddings are L2-normalised Float32Arrays from the on-device image model.
 * Dishes are matched by cosine similarity to their text embeddings, plus any
 * photos the user has confirmed before ("learned examples").
 */
(function (root) {
  "use strict";

  const EX_FLOOR = 0.65;     // image-to-image similarity below this gives no bonus
  const EX_WEIGHT = 40;      // logit bonus per unit of similarity above the floor
  const MAX_DISHES = 4;
  const MAX_EXAMPLES = 6;
  const SAME_DISH = 0.85;    // text embeddings closer than this count as the same dish
  const MAX_GRID = 5;
  const FULL_SHARE = 0.8;    // normal servings together cover about 80% of the plate
  const PORTION_MIN = 0.5, PORTION_MAX = 1.5;
  const FRAMING_DIFF = 0.4;  // plate area differing by more than 40% between photos -> warn

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  }

  function mean(vectors) {
    const out = new Float32Array(vectors[0].length);
    for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
    return normalize(out);
  }

  function softmax(logits) {
    const m = Math.max(...logits);
    const e = logits.map(x => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map(x => x / s);
  }

  // ---- float32 <-> base64, for storing learned examples compactly ----
  function f32ToB64(arr) {
    const bytes = new Uint8Array(new Float32Array(arr).buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return (typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64"));
  }
  function b64ToF32(b64) {
    const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  /**
   * Builds the class list.
   * labels:  parsed labels.json  {scale, foods:[{zh,kcal,g,emb}], nonfood:[{id,emb}]}
   * learned: {name: {kcal, g, ex:[base64 float32, ...]}}  (user-confirmed photos)
   * mine:    {name: {k, g}}  the user's own calories / typical serving for a dish
   */
  function buildClasses(labels, learned, mine) {
    learned = learned || {};
    mine = mine || {};
    const classes = [];
    const seen = new Set();
    for (const f of labels.foods) {
      const l = learned[f.zh];
      const m = mine[f.zh] || {};
      classes.push({ name: f.zh, food: true, kcal: m.k || f.kcal, g: m.g || f.g, text: Float32Array.from(f.emb),
                     ex: l && l.ex ? l.ex.map(b64ToF32) : [] });
      seen.add(f.zh);
    }
    for (const [name, l] of Object.entries(learned)) {
      if (seen.has(name) || !l || !l.ex || !l.ex.length) continue;
      const m = mine[name] || {};
      classes.push({ name, food: true, kcal: m.k || l.kcal, g: m.g || l.g, text: null, ex: l.ex.map(b64ToF32), custom: true });
    }
    for (const n of labels.nonfood) {
      classes.push({ name: n.id, food: false, kind: n.id, text: Float32Array.from(n.emb), ex: [] });
    }
    return { scale: labels.scale || 100, list: classes };
  }

  /** Logit of every class for one embedding. */
  function logits(classes, emb) {
    const raw = classes.list.map(c => (c.text ? classes.scale * dot(emb, c.text) : null));
    const textVals = raw.filter((v, i) => v !== null && classes.list[i].food);
    const neutral = textVals.reduce((a, b) => a + b, 0) / Math.max(1, textVals.length);
    return classes.list.map((c, i) => {
      let x = raw[i] === null ? neutral : raw[i];
      if (c.ex.length) {
        let best = -1;
        for (const e of c.ex) best = Math.max(best, dot(emb, e));
        x += EX_WEIGHT * Math.max(0, best - EX_FLOOR);
      }
      return x;
    });
  }

  /** Probability of every class, optionally restricted to a subset of class indexes. */
  function probs(classes, emb, allowed) {
    const lg = logits(classes, emb);
    if (!allowed) return softmax(lg);
    const sub = softmax(allowed.map(i => lg[i]));
    const out = new Array(lg.length).fill(0);
    allowed.forEach((ci, k) => { out[ci] = sub[k]; });
    return out;
  }

  const argmax = arr => arr.reduce((bi, v, i) => (v > arr[bi] ? i : bi), 0);

  /**
   * Analyses one meal.
   * before: {full: emb, tiles: [emb]}   after: same shape, or null (= all eaten)
   * Returns {items:[{name,kcal,g,before,after,conf,alts:[name],emb}], note}
   */
  function analyse(classes, before, after) {
    const L = classes.list;
    const foodIdx = L.map((c, i) => (c.food ? i : -1)).filter(i => i >= 0);
    const nonIdx = L.map((c, i) => (c.food ? -1 : i)).filter(i => i >= 0);

    // 1. What is on the plate: whole photo + every tile, all classes.
    const fullP = probs(classes, before.full);
    const tileP = before.tiles.map(t => probs(classes, t));
    const tileTop = tileP.map(argmax);
    const foodTiles = tileTop.filter(ci => L[ci].food).length;

    const score = new Map();   // class index -> evidence
    const count = new Map();
    tileTop.forEach((ci, t) => {
      if (!L[ci].food) return;
      count.set(ci, (count.get(ci) || 0) + 1);
      score.set(ci, (score.get(ci) || 0) + tileP[t][ci]);
    });
    for (const ci of foodIdx) {
      if (fullP[ci] >= 0.2) score.set(ci, (score.get(ci) || 0) + 3 * fullP[ci]);
    }
    // Nothing on the photo looks like food, and the whole photo is a plate/table -> say so.
    const bestFull = foodIdx.reduce((bi, ci) => (fullP[ci] > fullP[bi] ? ci : bi), foodIdx[0]);
    if (foodTiles === 0 && !L[argmax(fullP)].food) return { items: [], noFood: true };

    const minTiles = Math.max(1, Math.round(foodTiles * 0.12));
    const avgP = ci => (score.get(ci) || 0) / Math.max(1, count.get(ci) || 0);
    const candidates = [...score.entries()]
      .filter(([ci]) => {
        const n = count.get(ci) || 0;
        if (fullP[ci] >= 0.2) return true;
        if (n < minTiles) return false;
        return n >= 2 || avgP(ci) >= 0.4;   // a single tile must be a confident match
      })
      .sort((a, b) => b[1] - a[1])
      .map(([ci]) => ci);
    // Look-alike dishes (白飯 / 糙米飯 / 五穀飯) are one dish, not several: keep the strongest.
    let picked = [];
    for (const ci of candidates) {
      if (picked.length >= MAX_DISHES) break;
      const dup = picked.some(pi => L[pi].text && L[ci].text && dot(L[pi].text, L[ci].text) > SAME_DISH);
      if (!dup) picked.push(ci);
    }
    if (!picked.length) picked = [bestFull];

    // 2. Re-label tiles using only the picked dishes + plate/table, so every food tile
    //    belongs to one of the dishes we show.
    const allowed = picked.concat(nonIdx);
    const relabel = tiles => tiles.map(t => {
      const p = probs(classes, t, allowed);
      return { ci: argmax(p), p };
    });
    const bTiles = relabel(before.tiles);
    const aTiles = after ? relabel(after.tiles) : null;

    // Share of the "plate area" (food + empty dish tiles) each dish covers.
    const plateArea = rows => rows.filter(r => L[r.ci].food || L[r.ci].kind === "container").length;
    const share = (rows, ci) => {
      const area = plateArea(rows);
      return area ? rows.filter(r => r.ci === ci).length / area : 0;
    };
    const foodShare = rows => {
      const area = plateArea(rows);
      return area ? rows.filter(r => L[r.ci].food).length / area : 0;
    };

    let afterFull = null;
    if (after) afterFull = probs(classes, after.full, allowed);

    // Photos taken from very different distances make the leftover share unreliable.
    let framing = false;
    if (after) {
      const pa = plateArea(bTiles), pb = plateArea(aTiles);
      framing = pa >= 3 && Math.abs(pb - pa) / pa > FRAMING_DIFF;  // incl. plate barely visible after
    }
    const beforeArea = plateArea(bTiles);
    // Expected share of each dish: split FULL_SHARE by typical serving size (rice > egg)
    // Only dishes that own tiles count; one picked from the whole photo alone has no area.
    const sumG = picked.filter(pi => share(bTiles, pi) > 0).reduce((s, pi) => s + (L[pi].g || 100), 0) || 1;

    const items = picked.map(ci => {
      const c = L[ci];
      // portion: scale the typical serving by how much of the plate this dish covers
      const sbShare = share(bTiles, ci);
      let portion = 1;
      if (beforeArea >= 3 && sbShare > 0) {
        const expected = FULL_SHARE * (c.g || 100) / sumG;
        portion = Math.min(PORTION_MAX, Math.max(PORTION_MIN, sbShare / expected));
      }
      const grams = Math.max(10, Math.round(c.g * portion / 10) * 10);
      // leftover ratio
      let left = 0;
      if (after) {
        const sb = share(bTiles, ci);
        const sa = share(aTiles, ci);
        if (sb > 0) left = Math.min(1, sa / sb);
        else {
          const fb = foodShare(bTiles);
          left = fb > 0 ? Math.min(1, foodShare(aTiles) / fb) : 0;
        }
        // Whole "after" photo is clearly an empty dish -> nothing left.
        const emptyP = nonIdx.reduce((s, ni) => s + afterFull[ni], 0);
        if (emptyP > 0.85 && sa < 0.15) left = 0;
        left = Math.round(left * 4) / 4;  // quarters: matches the quick buttons, avoids false precision
      }

      // confidence + alternatives from the tiles that belong to this dish
      const mine = bTiles.map((r, t) => (r.ci === ci ? t : -1)).filter(t => t >= 0);
      const agg = new Array(L.length).fill(0);
      const src = mine.length ? mine.map(t => tileP[t]) : [fullP];
      for (const p of src) for (let k = 0; k < L.length; k++) agg[k] += p[k];
      for (let k = 0; k < L.length; k++) agg[k] += fullP[k];
      // Confidence counts plate/table too, so a dish guessed from a mostly empty photo scores low.
      const total = agg.reduce((s, v) => s + v, 0) || 1;
      const conf = agg[ci] / total;
      const alts = foodIdx.filter(fi => fi !== ci && !picked.includes(fi))
        .sort((a, b) => agg[b] - agg[a]).slice(0, 3).map(fi => L[fi].name);

      // What to remember for learning: this dish's own tiles. If it has none and the plate holds
      // several dishes, the whole photo would teach the wrong look, so remember nothing.
      let emb = null;
      if (mine.length) emb = picked.length === 1 ? mean([before.full].concat(mine.map(t => before.tiles[t]))) : mean(mine.map(t => before.tiles[t]));
      else if (picked.length === 1) emb = before.full;
      return {
        name: c.name, kcal: c.kcal, g: c.g,
        before: grams, after: Math.round(grams * left), portion,
        conf: conf >= 0.45 ? "high" : conf >= 0.22 ? "mid" : "low",
        alts,
        emb,
      };
    });

    return { items, framing };
  }

  /**
   * For dishes named by someone else (Claude API mode): which part of the photo is each dish?
   * Returns one embedding (or null) per name, so API results can teach the offline model too.
   */
  function embedFor(classes, before, names) {
    const L = classes.list;
    const nonIdx = L.map((c, i) => (c.food ? -1 : i)).filter(i => i >= 0);
    const idx = names.map(n => L.findIndex(c => c.food && c.name === n));
    if (names.length === 1) {
      const foodT = before.tiles.filter(t => L[argmax(probs(classes, t))].food);
      return [mean([before.full].concat(foodT))];
    }
    const known = [...new Set(idx.filter(i => i >= 0))];
    if (!known.length) return names.map(() => null);
    const allowed = known.concat(nonIdx);
    const labels = before.tiles.map(t => argmax(probs(classes, t, allowed)));
    // Also require the unrestricted best match to agree, so tiles of a dish whose name we
    // don't know are not forced onto a known dish.
    // A tile counts only if it clearly shows the dish: its best match is the dish, and the dish
    // together with its look-alikes (白飯 / 糙米飯 …) holds at least 30% of the probability.
    const group = ci => L.map((c, k) => (c.food && (k === ci || (c.text && L[ci].text && dot(c.text, L[ci].text) > SAME_DISH)) ? k : -1)).filter(k => k >= 0);
    const free = before.tiles.map(t => {
      const p = probs(classes, t), top = argmax(p);
      if (!L[top].food) return -1;
      return group(top).reduce((sum, k) => sum + p[k], 0) >= 0.3 ? top : -1;
    });
    return idx.map(ci => {
      if (ci < 0) return null;
      const mineT = before.tiles.filter((t, k) => labels[k] === ci && free[k] === ci);
      return mineT.length ? mean(mineT) : null;
    });
  }

  /** Adds a confirmed photo embedding to the user's learned examples (mutates and returns learned). */
  function learn(learned, name, kcal, g, emb) {
    const entry = learned[name] || { kcal, g, ex: [] };
    entry.kcal = kcal;
    entry.g = g;
    entry.ex.push(f32ToB64(emb));
    if (entry.ex.length > MAX_EXAMPLES) entry.ex.splice(0, entry.ex.length - MAX_EXAMPLES);
    learned[name] = entry;
    return learned;
  }

  /**
   * Where to cut tiles in a w x h image: the whole image (centre square) plus a grid of
   * squares about a third of the short side, covering the photo edge to edge.
   */
  function cropBoxes(w, h) {
    const s = Math.min(w, h);
    const boxes = [{ x: (w - s) / 2, y: (h - s) / 2, s }];
    const side = s / 3;
    // Long panoramas would need many tiles; cap the grid so memory stays small on 4GB phones.
    const cols = Math.min(MAX_GRID, Math.max(3, Math.round(w / side)));
    const rows = Math.min(MAX_GRID, Math.max(3, Math.round(h / side)));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        boxes.push({ x: (c * (w - side)) / (cols - 1), y: (r * (h - side)) / (rows - 1), s: side });
      }
    }
    return boxes;
  }

  /** RGBA pixels (ImageData.data) -> packed RGB bytes. */
  function rgbaToRgb(rgba, out, offset) {
    for (let i = 0, j = offset; i < rgba.length; i += 4, j += 3) {
      out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2];
    }
    return out;
  }

  const api = { buildClasses, analyse, embedFor, learn, cropBoxes, rgbaToRgb, f32ToB64, b64ToF32, normalize, mean, probs };
  root.PlateEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
