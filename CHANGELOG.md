# Changelog

## [0.3.0](https://github.com/kontourai/lookout/compare/v0.2.0...v0.3.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* createSurveyEmitter (and its SurveyEmitter/EmitSurveyInput/ EmissionResult types) are replaced by createDriftEmitter/DriftEmitter/ EmitDriftInput/DriftResult; DriftResult has no surveyInput field; the @kontourai/survey dependency and the `emit-survey` CLI command are removed (`emit-drift` emits neutral drift). Consumers author trust records themselves via @kontourai/surface.

### Features

* neutral drift emission — decouple lookout from the trust product layer ([#15](https://github.com/kontourai/lookout/issues/15)) ([c9c03eb](https://github.com/kontourai/lookout/commit/c9c03ebf120ef37df0bfdf8ac5d5baa29380e8a8))
* SSRF-guard registered-source fetches via forage egress (lookout[#12](https://github.com/kontourai/lookout/issues/12)) ([#13](https://github.com/kontourai/lookout/issues/13)) ([e4b78a4](https://github.com/kontourai/lookout/commit/e4b78a403cf917e613b79f7735b3f5578da940c5))
* static schema-coverage drift check (checkSchemaCoverage) ([#14](https://github.com/kontourai/lookout/issues/14)) ([ba1f936](https://github.com/kontourai/lookout/commit/ba1f936ef6f3e9b8e969dee491aa41426a16e63f))


### Documentation

* positioning parity — tagline, why-different table, four-verb layering ([ed9a65c](https://github.com/kontourai/lookout/commit/ed9a65cb2038aa2b85d87e62bacd879d5edc64a6))

## [0.2.0](https://github.com/kontourai/lookout/compare/v0.1.0...v0.2.0) (2026-07-11)


### Features

* L1 — LookoutSource registry, drift-check runner, lookout CLI ([#1](https://github.com/kontourai/lookout/issues/1)) ([#6](https://github.com/kontourai/lookout/issues/6)) ([2297b44](https://github.com/kontourai/lookout/commit/2297b44ae6ee2779107e8a685059c86936171ad5))
* L2 — deterministic diff kernel and proposal-set events ([#2](https://github.com/kontourai/lookout/issues/2)) ([#7](https://github.com/kontourai/lookout/issues/7)) ([6525528](https://github.com/kontourai/lookout/commit/65255281175d6f1273407c4077795461ae6ab907))
* L3 — SurveyInput emission over observation diffs ([#3](https://github.com/kontourai/lookout/issues/3)) ([#8](https://github.com/kontourai/lookout/issues/8)) ([ef89335](https://github.com/kontourai/lookout/commit/ef893353717cc972f03e32f1f4052bddd63668b5))


### Documentation

* record 2026-07-06 capture audit in shaping artifact ([b0bc5b6](https://github.com/kontourai/lookout/commit/b0bc5b683ae42fd084c4cd2de011584cf0dd77d1))
* shaping artifact + verified API references for v0.1 backlog ([#1](https://github.com/kontourai/lookout/issues/1)-[#4](https://github.com/kontourai/lookout/issues/4)) ([b001198](https://github.com/kontourai/lookout/commit/b0011980ec6d1f7e734e1efce3d2e1b564678c47))
