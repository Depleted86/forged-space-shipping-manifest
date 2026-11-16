// The steps of the in-game "Manifest Setup" window (js/overlay-setup.js):
// every screen the extension learns from, each done once that screen's data
// has been saved. Required steps are what planning needs; optional ones only
// matter to some players (research, new planet types, corp orders).

import * as storage from "./storage.js";

// "1 plan", "2 plans"
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Storage keys whose changes can tick a step off.
export const SETUP_WATCHED_KEYS = [
  "builds",
  "inventorySyncMeta",
  "settings",
  "blueprints",
  "assemblyPlans",
  "harvesters",
  "harvesterSyncMeta",
  "activeBuildName",
  "manifestSelection",
  "planetSyncMeta",
  "corpInventory",
  "gettingStarted",
];

export async function loadSetupState() {
  const settings = await storage.loadSettings();
  const maxHarvesters = Number(settings.max_harvesters || 4);
  const [sync, blueprints, assemblyPlans, slots, builds, activeBuild, selection, planetSync, corp, progress, harvesterSync] = await Promise.all([
    storage.loadInventorySyncStatus(),
    storage.loadBlueprints(),
    storage.loadAssemblyPlans(),
    storage.loadHarvesterSlots(maxHarvesters),
    storage.loadBuilds(),
    storage.loadActiveBuildName(),
    storage.loadManifestSelection(),
    storage.loadPlanetSyncStatus(),
    storage.loadCorpInventory(),
    storage.loadGettingStarted(),
    storage.loadHarvesterSyncStatus(),
  ]);
  return { settings, maxHarvesters, sync, blueprints, assemblyPlans, slots, builds, activeBuild, selection, planetSync, corp, progress, harvesterSync };
}

// Each step: title, where to do it, whether it's done, an optional detail
// line once there's something to show, and `tab`/`tabLabel` for steps done
// on the dashboard itself.
export function buildSetupSteps(s) {
  const blueprints = Object.values(s.blueprints);
  const withMaterials = blueprints.filter((bp) => bp.hasRecipe()).length;
  const plans = Object.values(s.assemblyPlans);
  const knownPlans = plans.filter((plan) => plan.hasRecipe()).length;
  // Recipes with this player's own rate, not the Exchange's base one.
  const ownRates = plans.filter((plan) => plan.hasRecipe() && !plan.rateIsBase).length;
  const researched = plans.filter((plan) => plan.research).length;
  const assigned = s.slots.filter((slot) => slot && slot.resource).length;
  const assemblersBusy = Object.values(s.settings.assembler_counts || {}).reduce((sum, n) => sum + n, 0);
  const skills = [
    s.settings.manufacturing_skill != null ? `Manufacturing ${s.settings.manufacturing_skill}` : null,
    s.settings.engineering_skill != null ? `Engineering ${s.settings.engineering_skill}` : null,
  ].filter(Boolean);
  const corpItems = Object.keys(s.corp || {}).length;
  // Plan a Build makes an empty "Build 1" on its own, so a selected build
  // only counts once something's been added to it.
  const buildEntries = (s.activeBuild != null && s.builds[s.activeBuild]) || [];
  return {
    required: [
      {
        title: "Sync your storage",
        where: "In the game: dock, then open Commercial Storage.",
        done: !!s.sync?.syncedAt,
        detail: s.sync?.syncedAt ? `Last synced ${new Date(s.sync.syncedAt).toLocaleString()}` : null,
      },
      {
        title: "Read your skills",
        where: "In the game: the Skills button (graduation cap), Ship Skills tab.",
        done: skills.length > 0,
        detail: skills.join(", ") || null,
      },
      {
        title: "Save your blueprints",
        where: "In the game: open any Blueprint Store and click each blueprint you build.",
        done: withMaterials > 0,
        detail: blueprints.length ? `${withMaterials} of ${blueprints.length} have their materials saved` : null,
      },
      {
        title: "Load every assembly recipe",
        where: "In the game: Galactic Exchange, then Assembler Plans → All Plans.",
        done: !!s.settings.exchange_plans_read,
        detail: knownPlans ? `${count(knownPlans, "recipe")} saved` : null,
      },
      {
        title: "Load your assembly rates",
        where: "In the game: Assembly Facility, then Configure Production. The Exchange only shows base rates; this reads your R&D-boosted ones.",
        done: ownRates > 0,
        detail: ownRates ? `${count(ownRates, "plan")} at your own rate` : null,
      },
      {
        title: "Read your harvesters",
        where: "In the game: Info (the ⓘ button), then the Harvesters tab - your harvesters fill in by themselves. Or set them by hand on the Planets tab.",
        tab: "planets",
        tabLabel: "Planets",
        done: !!s.harvesterSync || assigned > 0,
        detail: `${assigned} of ${s.maxHarvesters} slots assigned`,
      },
      {
        title: "Read your assemblers",
        where: "In the game: Info, then the Assemblers tab - shows which items your assemblers are making, for the Manifest's Asm counts.",
        done: !!s.settings.assembler_counts_read,
        detail: s.settings.assembler_counts_read ? `${count(assemblersBusy, "assembler")} making something` : null,
      },
      {
        title: "Read your refining",
        where: "In the game: Info, then the Refining tab - counts the jobs at every refinery, so batches already refining go toward your builds.",
        done: !!s.settings.refining_read,
      },
      {
        title: "Pick something to build",
        where: "On the Plan a Build tab, or in the Manifest overlay's dropdown.",
        tab: "plan",
        tabLabel: "Plan a Build",
        done: buildEntries.length > 0 || s.selection != null,
        detail: buildEntries.length ? `${count(buildEntries.length, "item")} in your build` : null,
      },
      {
        title: "Open the Manifest overlay",
        where: "In the game: click the Manifest handle at the edge of the game screen.",
        // A saved overlay selection means it's been used, for anyone who
        // opened it before this was recorded.
        done: s.progress.overlayOpened || s.selection != null,
      },
    ],
    optional: [
      {
        title: "R&D research levels",
        where: "In the game: R&D Office, Research plans tab.",
        done: researched > 0,
        detail: researched ? `${count(researched, "research plan")} read` : null,
      },
      {
        title: "Latest planet types",
        where: "In the game: Systems Lexicon, Manufacturing, expand Planet Types & Resources. The built-in list works without it.",
        done: !!s.planetSync,
      },
      {
        title: "Corp Store",
        where: "In the game: Offices, then Store. Only needed for tracking corp orders.",
        done: corpItems > 0,
        detail: corpItems ? `${count(corpItems, "item")} read` : null,
      },
    ],
  };
}
