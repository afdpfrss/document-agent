// OpenNext configuration for the Cloudflare Workers deployment.
//
// Kept intentionally minimal: no R2 incremental cache override, so a bucket
// is not required to build or deploy. ISR/data-cache entries fall back to the
// in-Worker default. Add `incrementalCache: r2IncrementalCache` here (and the
// matching r2_buckets binding in wrangler.jsonc) once persistent caching is
// needed. See https://opennext.js.org/cloudflare/caching
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
