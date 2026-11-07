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
  "activeBuildName",
  "manifestSelection",
  "planetSyncMeta",
  "corpInventory",
  "gettingStarted",
];

export async function loadSetupState() {
  const settings = await storage.loadSettings();
  const maxHarvesters = Number(settings.max_harvesters || 4);
  const [sync, blueprints, assemblyPlans, slots, builds, activeBuild, selection, planetSync, corp, progress] = await Promise.all([
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
  ]);
  return { settings, maxHarvesters, sync, blueprints, assemblyPlans, slots, builds, activeBuild, selection, planetSync, corp, progress };
}

// Each step: title, where to do it, whether it's done, an optional detail
// line once there's something to show, and `tab`/`tabLabel` for steps done
// on the dashboard itself.
export function buildSetupSteps(s) {
  const blueprints = Object.values(s.blueprints);
  const withMaterials = blueprints.filter((bp) => bp.hasRecipe()).length;
  const plans = Object.values(s.assemblyPlans);
  const knownPlans = plans.filter((plan) => plan.hasRecipe()).length;
  const researched = plans.filter((plan) => plan.research).length;
  const assigned = s.slots.filter((slot) => slot && slot.resource).length;
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
        title: "Load your assembly plans",
        where: "In the game: Assembly Facility, then Configure Production.",
        done: knownPlans > 0,
        detail: knownPlans ? `${count(knownPlans, "plan")} saved` : null,
      },
      {
        title: "Set up your harvesters",
        where: "On the Planets tab: set Harvester slots owned, then each harvester's resource and rate.",
        tab: "planets",
        tabLabel: "Planets",
        done: assigned > 0,
        detail: `${assigned} of ${s.maxHarvesters} slots assigned`,
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
        where: "In the game: R&D Office, then an empty slot's Select Plan.",
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
