# Changelog

## [0.7.1](https://github.com/dryvist/homelab-wall/compare/v0.7.0...v0.7.1) (2026-09-26)


### Bug Fixes

* **wall:** purge N/A/placeholder text, 8-model MC3 satellites, remove redundant legend ([#47](https://github.com/dryvist/homelab-wall/issues/47)) ([d198a77](https://github.com/dryvist/homelab-wall/commit/d198a777b0d1c3eac559af2bca61a579b295b498))

## [0.7.0](https://github.com/dryvist/homelab-wall/compare/v0.6.0...v0.7.0) (2026-09-26)


### Features

* **wall:** full-viewport hero scenes on MC2, MC3, MC4 ([#43](https://github.com/dryvist/homelab-wall/issues/43)) ([6c01873](https://github.com/dryvist/homelab-wall/commit/6c0187374a1ebcf3c47c471a1503dcd36eb6c1dc))


### Bug Fixes

* **wall:** adaptive render quality for the hero-scene canvases ([#45](https://github.com/dryvist/homelab-wall/issues/45)) ([18456dd](https://github.com/dryvist/homelab-wall/commit/18456dd78e39a65b9a32900905d9a6134e6ec4d3))

## [0.6.0](https://github.com/dryvist/homelab-wall/compare/v0.5.0...v0.6.0) (2026-09-26)


### Features

* **mc3:** AI Core revamp — hero geometries, hub streams, dense stats ([#37](https://github.com/dryvist/homelab-wall/issues/37)) ([ff21048](https://github.com/dryvist/homelab-wall/commit/ff210484abb71913c68f7b6c6bbd966e60dbe5da))
* **mc4:** dense acquisition/library panels, nested tori, solid black bg ([#40](https://github.com/dryvist/homelab-wall/issues/40)) ([9d2ddb7](https://github.com/dryvist/homelab-wall/commit/9d2ddb7b243eafb649e54d4f501616d31ae4463d))
* **rotator:** reload the wall every 30 minutes ([#39](https://github.com/dryvist/homelab-wall/issues/39)) ([a072c5b](https://github.com/dryvist/homelab-wall/commit/a072c5be91bc0f2da4f8d8ec6487ed1eb6f7608f))

## [0.5.0](https://github.com/dryvist/homelab-wall/compare/v0.4.1...v0.5.0) (2026-09-26)


### Features

* **mc2:** real land-mask globe, glowing arcs, and a live blocked-feed panel ([#35](https://github.com/dryvist/homelab-wall/issues/35)) ([161bbd0](https://github.com/dryvist/homelab-wall/commit/161bbd029974b957555062230f59012d4d648d27))
* **render:** three.js hero scenes, VLAN panel, and rotator re-probe ([#33](https://github.com/dryvist/homelab-wall/issues/33)) ([5b5f835](https://github.com/dryvist/homelab-wall/commit/5b5f835460bfba5074f3f197e34a5f7b02f001d9))


### Bug Fixes

* **wall:** render stand-in data instead of non-production placeholders ([#34](https://github.com/dryvist/homelab-wall/issues/34)) ([b65c8df](https://github.com/dryvist/homelab-wall/commit/b65c8df35034423a931959dc34f781c587bc9e3f))

## [0.4.1](https://github.com/dryvist/homelab-wall/compare/v0.4.0...v0.4.1) (2026-09-26)


### Bug Fixes

* **render:** pause/dispose page render loops and persist rotator iframes ([#30](https://github.com/dryvist/homelab-wall/issues/30)) ([dbd3812](https://github.com/dryvist/homelab-wall/commit/dbd3812e0837a37bd6c2fbbab9c5dd681180d9b1))

## [0.4.0](https://github.com/dryvist/homelab-wall/compare/v0.3.1...v0.4.0) (2026-09-26)


### Features

* **mc:** rescale app health to a 0-10 scale and show SAMPLE DATA on empty panels ([0dcecf3](https://github.com/dryvist/homelab-wall/commit/0dcecf31883e05988bef8702d5e36dc018df06d3))

## [0.3.1](https://github.com/dryvist/homelab-wall/compare/v0.3.0...v0.3.1) (2026-09-26)


### Bug Fixes

* **mc1:** decouple the service-health summary from the canvas animation frame ([#21](https://github.com/dryvist/homelab-wall/issues/21)) ([8f2b8f5](https://github.com/dryvist/homelab-wall/commit/8f2b8f57554e95bd785ac418e1703d55ee2c0019))
* **mc1:** stop double-counting storage across nodes ([#18](https://github.com/dryvist/homelab-wall/issues/18)) ([118dd75](https://github.com/dryvist/homelab-wall/commit/118dd75b27e2653657950559f0dce1e7fa36ba47))

## [0.3.0](https://github.com/dryvist/homelab-wall/compare/v0.2.1...v0.3.0) (2026-09-25)


### Features

* **mc3:** add AI Core mission control page ([#10](https://github.com/dryvist/homelab-wall/issues/10)) ([e2e9d88](https://github.com/dryvist/homelab-wall/commit/e2e9d88cb78d5b66a55892cd7e9fed9f8bd8d006))
* **mc5:** add pipeline/GitOps mission control page ([#13](https://github.com/dryvist/homelab-wall/issues/13)) ([481633f](https://github.com/dryvist/homelab-wall/commit/481633f8f6c491fa18f0c0f439bce25dc8e6d59d))
* mission control 2, edge threat map page ([#11](https://github.com/dryvist/homelab-wall/issues/11)) ([573c780](https://github.com/dryvist/homelab-wall/commit/573c7805421e18a5ae1d9ece0ec35516010d045f))
* mission control 4 media acquisition page ([#12](https://github.com/dryvist/homelab-wall/issues/12)) ([d96ab6d](https://github.com/dryvist/homelab-wall/commit/d96ab6de17176939afdfba0d4fd8995c5c15eb6c))
* **rotator:** add crossfading slide rotator at the wall root ([#14](https://github.com/dryvist/homelab-wall/issues/14)) ([d430382](https://github.com/dryvist/homelab-wall/commit/d4303829b54601c2507733663bd68a60b9248bfd))


### Bug Fixes

* decouple mc1 panel canvases from their own rendered size ([#9](https://github.com/dryvist/homelab-wall/issues/9)) ([8355f64](https://github.com/dryvist/homelab-wall/commit/8355f64857338881f65ad77b93f3251f3c5ba9e1))
* **mc1:** keep node cards when a poll drops a node's series ([#17](https://github.com/dryvist/homelab-wall/issues/17)) ([a69359a](https://github.com/dryvist/homelab-wall/commit/a69359aab1ca16cdb57a19bb3e694bf77380a74b))

## [0.2.1](https://github.com/dryvist/homelab-wall/compare/v0.2.0...v0.2.1) (2026-09-25)


### Bug Fixes

* **release:** attach assets to a draft release, then publish ([#4](https://github.com/dryvist/homelab-wall/issues/4)) ([4a76e2a](https://github.com/dryvist/homelab-wall/commit/4a76e2ab178ab29e6ac273d37eb7c37561ae88d7))

## [0.2.0](https://github.com/dryvist/homelab-wall/compare/v0.1.0...v0.2.0) (2026-09-25)


### Features

* mission control 1 live page on Prometheus data ([#1](https://github.com/dryvist/homelab-wall/issues/1)) ([0bbf590](https://github.com/dryvist/homelab-wall/commit/0bbf590f52f901e74a35cb1d0ea83b9d314d665b))
