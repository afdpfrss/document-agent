import { describe, it, expect, afterEach, vi } from "vitest";

// edit-tool.ts pulls in the GitHub / corpus layers at import time. The marker
// helpers under test don't touch them, so stub them out to keep the test pure.
vi.mock("@/lib/github", () => ({
  addPullRequestLabels: vi.fn(),
  isGithubConfigured: () => false,
  proposeEdit: vi.fn(),
  proposeEditMulti: vi.fn(),
}));
vi.mock("@/lib/document-utils", () => ({
  loadIndex: vi.fn(async () => []),
}));

import {
  buildProposerMarker,
  parseProposerMarker,
  isDemoMode,
  isSoloApproverMode,
  prDecoration,
} from "@/lib/mcp/edit-tool";

describe("proposer marker (separation-of-duties)", () => {
  it("round-trips a proposer email", () => {
    const marker = buildProposerMarker("alice@example.com");
    expect(parseProposerMarker(marker)).toBe("alice@example.com");
  });

  it("returns null when no marker is present", () => {
    expect(parseProposerMarker("just a normal PR body")).toBeNull();
    expect(parseProposerMarker(null)).toBeNull();
    expect(parseProposerMarker(undefined)).toBeNull();
  });

  it("returns the first marker occurrence", () => {
    // prDecoration appends the authoritative marker; parse picks the first
    // match, and user free-text is HTML-comment-sanitized before the markers.
    const body = `${buildProposerMarker("real@example.com")}\ncontext\n${buildProposerMarker("other@example.com")}`;
    expect(parseProposerMarker(body)).toBe("real@example.com");
  });
});

describe("isDemoMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true when MCP_DEMO_MODE=true outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MCP_DEMO_MODE", "true");
    expect(isDemoMode()).toBe(true);
  });

  it("is forced false in production (SoD must not be bypassable there)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "");
    vi.stubEnv("MCP_DEMO_MODE", "true");
    expect(isDemoMode()).toBe(false);
  });

  it("can still be enabled in production via the escape hatch", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "true");
    vi.stubEnv("MCP_DEMO_MODE", "true");
    expect(isDemoMode()).toBe(true);
  });
});

describe("isSoloApproverMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true when MCP_SOLO_APPROVER_MODE=true", () => {
    vi.stubEnv("MCP_SOLO_APPROVER_MODE", "true");
    expect(isSoloApproverMode()).toBe(true);
  });

  it("is false when unset", () => {
    vi.stubEnv("MCP_SOLO_APPROVER_MODE", "");
    expect(isSoloApproverMode()).toBe(false);
  });

  it("stays enabled in production — it is the legitimate micro-business mode, not force-disabled like demo mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_INSECURE_DEPLOY", "");
    vi.stubEnv("MCP_SOLO_APPROVER_MODE", "true");
    expect(isSoloApproverMode()).toBe(true);
  });
});

describe("prDecoration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds only the proposer marker when no special mode is set", () => {
    vi.stubEnv("MCP_DEMO_MODE", "");
    vi.stubEnv("MCP_SOLO_APPROVER_MODE", "");
    const deco = prDecoration("規程を更新", "alice@example.com");
    expect(deco.title).toBe("規程を更新");
    expect(deco.labels).toEqual(["proposer:alice-example.com"]);
    expect(deco.markerLines.some((l) => l.includes("solo-approver"))).toBe(
      false,
    );
  });

  it("adds the solo-approver marker and label without a [DEMO] title prefix", () => {
    vi.stubEnv("MCP_DEMO_MODE", "");
    vi.stubEnv("MCP_SOLO_APPROVER_MODE", "true");
    const deco = prDecoration("規程を更新", "alice@example.com");
    // 単独運用モードは正規の編集 PR なのでタイトルは素のまま。
    expect(deco.title).toBe("規程を更新");
    expect(deco.labels).toContain("solo-approver");
    expect(deco.markerLines).toContain("<!-- poka-yoke:solo-approver -->");
  });
});
