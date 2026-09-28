import { describe, it, expect } from "vitest";
import { resolveJiraConfig } from "../../src/app/config";
import { isKeyInProject } from "../../src/domain/ids/jiraLink";

const full = {
  WIRE_TEAM_BOT_JIRA_BASE_URL: "https://api.atlassian.com/ex/jira/cloud-id/",
  WIRE_TEAM_BOT_JIRA_SITE_URL: "https://example.atlassian.net",
  WIRE_TEAM_BOT_JIRA_API_TOKEN: "synthetic-token",
  WIRE_TEAM_BOT_JIRA_PROJECT_KEY: "ds",
  WIRE_TEAM_BOT_JIRA_SERVICE_DESK_ID: "184",
  WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "fault=11808",
};

describe("resolveJiraConfig", () => {
  it("leaves the integration off when no Jira keys are set", () => {
    expect(resolveJiraConfig({})).toBeUndefined();
  });

  it("resolves a complete configuration with Bearer auth by default", () => {
    const cfg = resolveJiraConfig(full)!;
    expect(cfg.baseUrl).toBe("https://api.atlassian.com/ex/jira/cloud-id");
    expect(cfg.projectKey).toBe("DS");
    expect(cfg.email).toBeUndefined();
    expect(cfg.timeoutMs).toBe(15_000);
  });

  it("fails at startup when only some required keys are set", () => {
    expect(() => resolveJiraConfig({ WIRE_TEAM_BOT_JIRA_API_TOKEN: "t" })).toThrow(/partially configured.*WIRE_TEAM_BOT_JIRA_BASE_URL/);
  });

  it("rejects non-https URLs, non-numeric IDs and malformed project keys", () => {
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_BASE_URL: "http://api.atlassian.com/x" })).toThrow(/https/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SERVICE_DESK_ID: "desk" })).toThrow(/numeric/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_PROJECT_KEY: "D-S" })).toThrow(/project key/);
  });

  it("raises a timeout below the documented minimum to 1000 ms", () => {
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_TIMEOUT_MS: "200" })!.timeoutMs).toBe(1000);
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_TIMEOUT_MS: "30000" })!.timeoutMs).toBe(30_000);
  });

  it("does not share ticket content with the model unless explicitly enabled", () => {
    expect(resolveJiraConfig(full)!.shareWithModel).toBe(false);
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL: "ON" })!.shareWithModel).toBe(true);
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL: "off" })!.shareWithModel).toBe(false);
  });

  it("maps request kinds to request types and rejects malformed mappings", () => {
    expect(resolveJiraConfig(full)!.requestTypes).toEqual({ fault: "11808" });
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "question=11809, part=11810,fault=11808" })!.requestTypes)
      .toEqual({ question: "11809", part: "11810", fault: "11808" });
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "parts=11810" })).toThrow(/question=11809/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "part=abc" })).toThrow(/question=11809/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "question=11809,part=11810" })).toThrow(/must include fault/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "part=11810,part=11811" })).toThrow(/question=11809/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_REQUEST_TYPES: "part=11810=x" })).toThrow(/question=11809/);
  });

  it("reads the service scope when set and bounds its length", () => {
    expect(resolveJiraConfig(full)!.serviceScope).toBeUndefined();
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE: " truck faults and parts " })!.serviceScope).toBe("truck faults and parts");
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE: "x".repeat(501) })).toThrow(/500/);
  });

  it("keeps passive service-desk help off unless explicitly switched on", () => {
    expect(resolveJiraConfig(full)!.passive).toBe(false);
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_PASSIVE: "On" })!.passive).toBe(true);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_PASSIVE: "yes" })).toThrow(/on or off/);
    expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL: "yes" })).toThrow(/on or off/);
  });

  it("watches Jira only when an interval of at least 15 seconds is set", () => {
    expect(resolveJiraConfig(full)!.watchSeconds).toBeUndefined();
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_WATCH_SECONDS: "30" })!.watchSeconds).toBe(30);
    for (const bad of ["14", "0", "-30", "30s", "1.5"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_WATCH_SECONDS: bad })).toThrow(/WATCH_SECONDS/);
    }
  });

  it("maps desk agents to Wire handles and rejects malformed mappings", () => {
    expect(resolveJiraConfig(full)!.agents).toBeUndefined();
    const cfg = resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_AGENTS: "712020:abc-1=@HarveyWolff, 5b10a2=dana.desk" })!;
    expect([...cfg.agents!]).toEqual([["712020:abc-1", "harveywolff"], ["5b10a2", "dana.desk"]]);
    for (const bad of ["", "no-handle", "id=", "=handle", "id=bad handle", "a=b,a=c", "id=x"]) {
      expect(() => resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_AGENTS: bad || " , " })).toThrow(/WIRE_TEAM_BOT_JIRA_AGENTS/);
    }
  });

  it("switches to Basic auth when an email is configured", () => {
    expect(resolveJiraConfig({ ...full, WIRE_TEAM_BOT_JIRA_EMAIL: "bot@example.com" })!.email).toBe("bot@example.com");
  });
});

describe("jira keys", () => {
  it("scopes keys to the configured project", () => {
    expect(isKeyInProject("DS-42", "DS")).toBe(true);
    expect(isKeyInProject("DSX-42", "DS")).toBe(false);
    expect(isKeyInProject("OPS-42", "DS")).toBe(false);
  });
});
