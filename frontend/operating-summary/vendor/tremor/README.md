# Tremor chart sources

Official copy-and-paste components from https://github.com/tremorlabs/tremor at commit ca4d588f47820ff3d514d37fa4ee08a4222dec11 (2026-10-06 retrieval). See provenance.json for upstream SHA-256 hashes and LICENSE for Apache-2.0 terms.

AreaChart, LineChart and ComboChart plus their five helpers were copied from upstream. Local extension: optional curveType (linear or monotoneX) is forwarded to visible curves and their hit targets; the operating summary opts into monotoneX. Local extension: optional syncId is forwarded to the Recharts chart so the three operating charts share one hover cursor. Bars and data values remain unchanged. Product styling is scoped in ../../styles.css. Runtime dependencies are pinned in the repository package-lock.json. Recharts 2.15.4 follows this official Tremor snapshot's 2.x dependency; upgrading to 3.x requires a separate compatibility review.

The app renders actual Tremor components, not the earlier D3 design mock. No upstream website assets or demo data are used in production.
