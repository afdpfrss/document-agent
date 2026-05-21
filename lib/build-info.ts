// Build identifier surfaced in the UI footer so the deployed build is
// verifiable at a glance. The values are AUTO-GENERATED at build time by
// scripts/build-corpus.mjs (runs on postinstall / cf:build) into
// lib/generated/build-info.ts. BUILD_NUMBER is the git commit count.
export { BUILD_NUMBER, BUILD_DATE } from "./generated/build-info";
