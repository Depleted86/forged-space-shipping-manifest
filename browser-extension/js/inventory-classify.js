// Classifies a flat { itemName: quantity } snapshot (from either a scraped
// storage screen or any other source) against a Catalog and overwrites an
// Inventory's rawOre/refined/other wholesale. JS port of
// inventory_import.py's apply_items_to_inventory - kept as the single shared
// classification path so an item classifies the same way regardless of
// where the snapshot came from.

export function applyItemsToInventory(catalog, inventory, items) {
  const newRawOre = new Map();
  const newRefined = new Map();
  const newOther = {};
  let matched = 0;

  for (const [name, qty] of Object.entries(items)) {
    const ore = catalog.findOre(name);
    const material = ore ? null : catalog.findMaterial(name);
    if (ore) {
      newRawOre.set(ore, qty);
      matched += 1;
    } else if (material) {
      newRefined.set(material, qty);
      matched += 1;
    } else {
      newOther[name] = qty;
    }
  }

  inventory.rawOre = newRawOre;
  inventory.refined = newRefined;
  inventory.other = newOther;
  return { matched, unmatched: Object.keys(newOther).length };
}
