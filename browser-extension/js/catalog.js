// Object model for the Forged Space mining planner - JS port of models.py.
//
// Ore and Material are linked bidirectionally (Ore.outputs <-> Material.sources)
// so the planner can answer "what ores can I mine to get material X" and
// "what materials come along for free when I mine ore Y" from either side.
// PlanetType and PlanetResource are linked the same way, for the separate
// planetary-harvesting resource chain (rate-per-hour, not batch mining).
//
// A Catalog is rebuilt fresh (from RAW_ORE_DATA/PLANET_TYPES) in every
// execution context that needs one (dashboard, background) - it creates
// exactly one Ore/Material/PlanetType/PlanetResource instance per name, so
// object-identity equality (used as Map keys throughout calc-engine.js) is
// safe as long as all lookups go through the SAME Catalog instance, exactly
// mirroring how Python's Catalog() is rebuilt fresh per app launch and its
// dict keys rely on Ore/Material's by-name __hash__/__eq__.

import { RAW_ORE_DATA } from "./ores-data.js";
import { PLANET_TYPES } from "./planets-data.js";

export class Material {
  constructor(name) {
    this.name = name;
    this.sources = []; // Ore[] that produce this material
  }
}

export class Ore {
  constructor(name, tier, law, value, batch, refinedQ) {
    this.name = name;
    this.tier = tier;
    this.law = law;
    this.value = value;
    this.batch = batch;
    this.refinedQ = refinedQ;
    this.outputs = []; // Material[]
  }

  // Refined units produced per raw ore unit mined, for each output.
  get yieldRatio() {
    return this.refinedQ / this.batch;
  }

  // Raw ore units required to refine at least `refinedAmount` of ANY one of
  // this ore's outputs (mining also yields that same amount of the other
  // two outputs as a byproduct).
  rawNeededFor(refinedAmount) {
    return refinedAmount / this.yieldRatio;
  }
}

export class PlanetType {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.resources = []; // PlanetResource[]
  }
}

export class PlanetResource {
  constructor(name) {
    this.name = name;
    this.planetTypes = []; // PlanetType[] that offer this resource
  }
}

export class Catalog {
  constructor(rawData = RAW_ORE_DATA, planetData = PLANET_TYPES) {
    this.ores = new Map(); // name -> Ore
    this.materials = new Map(); // name -> Material
    for (const [name, tier, law, value, batch, refinedQ, outputs] of rawData) {
      const ore = new Ore(name, tier, law, value, batch, refinedQ);
      this.ores.set(name, ore);
      for (const outName of outputs) {
        let material = this.materials.get(outName);
        if (!material) {
          material = new Material(outName);
          this.materials.set(outName, material);
        }
        material.sources.push(ore);
        ore.outputs.push(material);
      }
    }

    this.planetTypes = new Map(); // name -> PlanetType
    this.planetResources = new Map(); // name -> PlanetResource
    for (const [name, description, resources] of planetData) {
      const planetType = new PlanetType(name, description);
      this.planetTypes.set(name, planetType);
      for (const resName of resources) {
        let resource = this.planetResources.get(resName);
        if (!resource) {
          resource = new PlanetResource(resName);
          this.planetResources.set(resName, resource);
        }
        resource.planetTypes.push(planetType);
        planetType.resources.push(resource);
      }
    }
  }

  // Overlays scraped Systems Lexicon planet-type data (see content.js's
  // checkLexiconPlanets()) onto an already-built Catalog - additive only,
  // never removes an existing PlanetType/PlanetResource or a link between
  // them, since a single scrape isn't guaranteed to see every entry that's
  // ever existed. `scraped` is { [name]: { description, resources: [name,
  // ...] } }, the storable shape of storage.js's scrapedPlanetTypes key.
  // The static PLANET_TYPES import (this Catalog's construction-time
  // default) stays the guaranteed baseline - this only ever adds to or
  // refreshes it, so the app works correctly even for a player who's never
  // opened the Lexicon.
  applyScrapedPlanetTypes(scraped) {
    for (const [name, { description, resources }] of Object.entries(scraped || {})) {
      let planetType = this.planetTypes.get(name);
      if (!planetType) {
        planetType = new PlanetType(name, description);
        this.planetTypes.set(name, planetType);
      } else {
        planetType.description = description;
      }
      for (const resName of resources) {
        if (planetType.resources.some((r) => r.name === resName)) continue;
        let resource = this.planetResources.get(resName);
        if (!resource) {
          resource = new PlanetResource(resName);
          this.planetResources.set(resName, resource);
        }
        resource.planetTypes.push(planetType);
        planetType.resources.push(resource);
      }
    }
  }

  findOre(name) {
    return this.ores.get(name) || null;
  }

  findMaterial(name) {
    return this.materials.get(name) || null;
  }

  findPlanetResource(name) {
    return this.planetResources.get(name) || null;
  }

  materialNames() {
    return [...this.materials.keys()].sort();
  }

  oreNames() {
    return [...this.ores.keys()].sort();
  }

  planetResourceNames() {
    return [...this.planetResources.keys()].sort();
  }

  allItemNames() {
    const names = new Set([...this.materials.keys(), ...this.ores.keys(), ...this.planetResources.keys()]);
    return [...names].sort();
  }

  // Returns ["material", Material] | ["ore", Ore] | ["planet_resource", PlanetResource] | ["unknown", name]
  classify(name) {
    const material = this.materials.get(name);
    if (material) return ["material", material];
    const ore = this.ores.get(name);
    if (ore) return ["ore", ore];
    const planetResource = this.planetResources.get(name);
    if (planetResource) return ["planet_resource", planetResource];
    return ["unknown", name];
  }
}
