/**
 * Normalize line items to canonical {desc, qty, rate, total} format.
 * Handles any input shape: {description, amount}, {name, price}, {desc, rate, total}, etc.
 */
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  // Strip currency symbols and commas before parsing (e.g. "$1,500.00" → "1500.00")
  const cleaned = typeof v === "string" ? v.replace(/[$,]/g, "").trim() : v;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function normalizeItem(i) {
  if (typeof i === "string") return { desc: i, qty: 1, rate: 0, total: 0 };
  if (!i) return { desc: "", qty: 1, rate: 0, total: 0 };

  const desc = i.desc || i.description || i.name || i.label || i.service || "";
  const qty = Math.max(1, parseInt(i.qty || i.quantity, 10) || 1);

  const nRate = num(i.rate);
  const nAmount = num(i.amount);
  const nTotal = num(i.total);
  const nPrice = num(i.price);

  const total =
    (nTotal != null && nTotal > 0) ? nTotal :
    (nAmount != null && nAmount > 0) ? nAmount :
    (nPrice != null && nPrice > 0) ? nPrice :
    (nRate != null && nRate > 0) ? nRate * qty : 0;

  const rate =
    (nRate != null && nRate > 0) ? nRate :
    (nAmount != null && nAmount > 0) ? nAmount :
    (nPrice != null && nPrice > 0) ? nPrice :
    (total > 0) ? total / qty : 0;

  return { desc, qty, rate, total };
}

function normalizeItems(items) {
  return (items || []).map(normalizeItem);
}

/**
 * If all items have $0 totals but docTotal > 0, distribute evenly.
 */
function fixZeroItems(items, docTotal) {
  const sum = items.reduce((s, i) => s + i.total, 0);
  if (sum === 0 && docTotal > 0 && items.length > 0) {
    const share = docTotal / items.length;
    for (const item of items) {
      item.total = share;
      item.rate = share / item.qty;
    }
  }
  return items;
}

module.exports = { normalizeItem, normalizeItems, fixZeroItems };
