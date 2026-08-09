// Static ore data for Forged Space, transcribed from the in-game ore tables.
//
// Each entry: [name, tier, law, valueCr, batch, refinedQ, [output1, output2, output3]]
//
// refinedQ is how much of EACH output a full batch of that raw ore refines
// into (observed as ~20% of batch across all four tiers: 300->60, 200->40,
// 100->20, 50->10).

export const RAW_ORE_DATA = [
  // --- Common (batch 300, refinedQ 60) ---
  ["Thracium", "Common", 15, 8, 300, 60, ["Iron Ore", "Jasper Ore", "Refined Ore"]],
  ["Feltonite", "Common", 15, 9, 300, 60, ["Jasper Ore", "Refined Ore", "Iron Ore"]],
  ["Kelsalt", "Common", 15, 11, 300, 60, ["Iron Ore", "Copper Ore", "Isotopes"]],
  ["Novastone", "Common", 15, 13, 300, 60, ["Refined Ore", "Alucite Ore", "Refined Metal"]],
  ["Abaron", "Common", 15, 19, 300, 60, ["Copper Ore", "Isotopes", "Jasper Ore"]],
  ["Nylonite", "Common", 14, 32, 300, 60, ["Refined Metal", "Kallycite Ore", "Alucite Ore"]],

  // --- Uncommon (batch 200, refinedQ 40) ---
  ["Porphyrogen", "Uncommon", 14, 28, 200, 40, ["Alucite Ore", "Sinistronite", "Rubidium"]],
  ["Xanthomite", "Uncommon", 13, 44, 200, 40, ["Rubidium", "Turbocite", "Sinistronite"]],
  ["Niobenium", "Uncommon", 13, 51, 200, 40, ["Inert Gas", "Reactive Gas", "Traylon Gas"]],
  ["Ravenrock", "Uncommon", 12, 59, 200, 40, ["Traylon Gas", "Technesium", "Tessarine Gas"]],
  ["Malifinum", "Uncommon", 11, 59, 200, 40, ["Tessarine Gas", "Gravimite", "Randium Gas"]],
  ["Rare Earth Elements", "Uncommon", 11, 60, 200, 40, ["Randium Gas", "Helanium", "Gravimite"]],
  ["Ostrinite", "Uncommon", 10, 79, 200, 40, ["Tessarine Ore", "Zirconium", "Helanium"]],
  ["Metallocite", "Uncommon", 10, 138, 200, 40, ["Argonight Ore", "Exotic Osmite", "Dyterium Ore"]],
  ["Gelon", "Uncommon", 9, 162, 200, 40, ["Exotic Osmite", "Titanium", "Tungsten"]],
  ["Quasar", "Uncommon", 9, 168, 200, 40, ["Argonight Ore", "Exotic Osmite", "Dyterium Ore"]],

  // --- Rare (batch 100, refinedQ 20) ---
  ["Hikarite", "Rare", 5, 8, 100, 20, ["Copper Ore", "Isotopes", "Jasper Ore"]],
  ["Pryavlon", "Rare", 7, 57, 100, 20, ["Traylon Gas", "Technesium", "Tessarine Gas"]],
  ["Rhodium", "Rare", 6, 121, 100, 20, ["Exotic Osmite", "Argonight Ore", "Dyterium Ore"]],
  ["Blissar", "Rare", 5, 141, 100, 20, ["Titanium", "Tungsten", "Zirconium"]],
  ["Rawk", "Rare", 4, 157, 100, 20, ["Dyterium Ore", "Tryonite Ore", "Argonight Ore"]],
  ["Xenon Crystal", "Rare", 7, 172, 100, 20, ["Tungsten", "Titanium", "Exotic Osmite"]],
  ["Cabalite", "Rare", 8, 179, 100, 20, ["Tryonite Ore", "Tungsten", "Titanium"]],
  ["Eranite", "Rare", 5, 182, 100, 20, ["Tessarine Ore", "Titanium", "Zirconium"]],
  ["Amaranthine", "Rare", 4, 186, 100, 20, ["Helanium", "Tungsten", "Tessarine Ore"]],
  ["Denzite", "Rare", 5, 191, 100, 20, ["Zirconium", "Dyterium Ore", "Helanium"]],
  ["Quazitron", "Rare", 3, 197, 100, 20, ["Titanium", "Tessarine Ore", "Tungsten"]],
  ["Vextril", "Rare", 3, 199, 100, 20, ["Tungsten", "Zirconium", "Dyterium Ore"]],

  // --- Exotic (batch 50, refinedQ 10) ---
  ["Cryzen", "Exotic", 2, 205, 50, 10, ["Dyterium Ore", "Titanium", "Tessarine Ore"]],
  ["Kelvolrite", "Exotic", 1, 211, 50, 10, ["Helanium", "Tryonite Ore", "Titanium"]],
];

export const TIER_ORDER = ["Common", "Uncommon", "Rare", "Exotic"];
