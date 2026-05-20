import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isProduction,
  insecureDeployAllowed,
  productionGuardActive,
  productionConfigIssues,
} from "@/lib/config-guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isProduction", () => {
  it("reflects NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProduction()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(isProduction()).toBe(false);
  });
});

describe("productionGuardActive", () => {
  it("is active in production without the escape hatch", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "");
    expect(productionGuardActive()).toBe(true);
  });

  it("is disabled by ALLOW_INSECURE_DEPLOY=true", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "true");
    expect(insecureDeployAllowed()).toBe(true);
    expect(productionGuardActive()).toBe(false);
  });

  it("is inactive outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(productionGuardActive()).toBe(false);
  });

  it("is inactive during the Next.js build phase (static prerender)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    expect(productionGuardActive()).toBe(false);
  });
});

describe("productionConfigIssues", () => {
  it("reports no issues outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(productionConfigIssues()).toEqual([]);
  });

  it("flags missing auth in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_GOOGLE_ID", "");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    const issues = productionConfigIssues();
    expect(issues.some((i) => i.includes("認証"))).toBe(true);
  });

  it("flags a missing MCP allowlist when auth is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_GOOGLE_ID", "id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
    vi.stubEnv("MCP_ALLOWED_EMAILS", "");
    vi.stubEnv("MCP_ALLOWED_EMAIL_DOMAINS", "");
    expect(
      productionConfigIssues().some((i) => i.includes("allowlist")),
    ).toBe(true);
  });

  it("flags MCP_DEMO_MODE in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_GOOGLE_ID", "id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "secret");
    vi.stubEnv("MCP_ALLOWED_EMAILS", "a@example.com");
    vi.stubEnv("MCP_DEMO_MODE", "true");
    expect(
      productionConfigIssues().some((i) => i.includes("MCP_DEMO_MODE")),
    ).toBe(true);
  });

  it("notes when the escape hatch has disabled enforcement", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_GOOGLE_ID", "");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "true");
    expect(
      productionConfigIssues().some((i) =>
        i.includes("ALLOW_INSECURE_DEPLOY"),
      ),
    ).toBe(true);
  });
});
