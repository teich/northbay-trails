# Where the data comes from

All of the map's data comes from public sources. It's gathered and processed ahead of time with `npm run data`, so the app itself doesn't depend on those services being up.

| What | Source |
| --- | --- |
| Park outlines | OpenStreetMap. Moore Creek is hand-drawn around its signed bike trails, because OpenStreetMap has no outline for the park. PUC uses the outline of the college's forest. |
| Trails | OpenStreetMap, checked and filled in with California State Parks' Recreational Routes (CC-BY) in state parks |
| Other parks and preserves | OpenStreetMap, for naming the trails outside the seven main parks |
| Lakes, the Russian River, peaks, towns | OpenStreetMap |
| Terrain | AWS Terrain Tiles (USGS elevation data) |

## What counts as a trail

The goal is to show every trail a mountain biker or hiker could use in the region, not just the ones in the seven main parks. The map includes every **named** path, trail, bridleway, and fire road between the Russian River and Lake Hennessey.

The seven parks are where the map gives trails a home: a trail belongs to a park when at least half of it is inside the park, or close enough to its edge to count (trailheads and connectors often start just outside). How close counts differs by park:

| Park | Counts as part of the park |
| --- | --- |
| Monte Rio Redwoods | within 450 m of the preserve |
| Taylor Mountain | within 120 m |
| Trione-Annadel (with Spring Lake and Howarth parks) | within 120 m |
| Jack London | within 120 m |
| Hood Mountain (with the McCormick Ranch addition) | within 120 m |
| PUC forest | within 150 m |
| Moore Creek | within 150 m of the drawn outline |

Trails outside the seven parks are labeled with the named park or preserve they're in, like Sugarloaf Ridge State Park or Armstrong Redwoods, or listed under "Other trails". Outside the parks the map is choosier, so it doesn't fill up with farm roads and town paths:

- no paved paths
- dirt roads only when they're designated for trail use or named like a trail
- no stubs shorter than about 120 m

Everywhere, it leaves out:

- unnamed paths
- informal or private paths, and anything marked closed to access
- sidewalks and footpaths that aren't named as trails
- placeholder names like "dead end" and "overgrown"

Trails that run off the edge of the map are cut at the edge.

Pieces of a trail that share a name and connect are joined into one trail.

Monte Rio's wide margin pulls some trails on land next to the preserve into its list. A trail that mostly runs outside a park, like Hood Mountain's Goodspeed Trail climbing up from Sugarloaf, is listed with where most of it is instead. Both can be adjusted in `scripts/build-data.mjs`.

## State park trails

In state parks, California State Parks' own route inventory is matched against OpenStreetMap:

- OSM trails that match it are confirmed, and the trail card says so.
- Where OSM doesn't say whether bikes are allowed, the inventory decides. Where both say and disagree, OSM wins (it's often more current), and the build lists the disagreements.
- Trails in the inventory that OSM is missing are added.

## How bike access is decided

Bike access comes from OpenStreetMap's bicycle tags, including mountain bike difficulty ratings, when they're there, and in state parks from State Parks' inventory. When neither says, bikes are assumed allowed on trails and fire roads and not allowed on footpaths. Trail cards mark guessed access as "likely allowed". Guessing matters more at Hood Mountain and Jack London, which close many of their trails to bikes, so check those parks' rules.

## Trail ratings

The green circle, blue square, black diamond, and double black diamond come from OpenStreetMap:

- `mtb:scale:imba`, the IMBA trail difficulty rating, when it's mapped: easy is green, intermediate is blue, difficult is black, and extremely difficult is double black.
- Otherwise `mtb:scale`, the technical grade, converted: S0 is green, S1 is blue, S2 is black, and S3 and up is double black.

If a trail's pieces are rated differently, the hardest piece sets the rating. Only about 30 trails across these parks are rated in OpenStreetMap, mostly at Annadel and Moore Creek. The rest show no mark. Adding ratings to OpenStreetMap and running `npm run data` brings them onto the map.

## Limits

- **Simplified terrain.** Terrain is sampled every 35 meters and heights are exaggerated 3×, so slopes look steeper than they are. Climbing figures are estimates from that terrain.
- **Snapshots, not live data.** The map is only as current as the last time the data was refreshed. OpenStreetMap is updated by volunteers and can have gaps or errors.
- **Narrow rivers are faint.** The Russian River is only a couple of terrain samples wide, so it shows up as a thin, pale line.
- **Nicknames aren't searchable.** A trail is listed under the name it has in OpenStreetMap.

Always confirm access and conditions with the land manager before heading out.
