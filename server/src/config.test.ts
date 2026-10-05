import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it("serves the client from the API's URL unless APP_URL is set", () => {
    vi.stubEnv("APP_URL", "");
    expect(loadConfig({ publicUrl: "https://api.example.in" }).appUrl).toBe("https://api.example.in");
    vi.stubEnv("APP_URL", "https://app.example.in");
    expect(loadConfig({ publicUrl: "https://api.example.in" }).appUrl).toBe("https://app.example.in");
  });

  it("defaults the session cookie to SameSite=Lax", () => {
    vi.stubEnv("COOKIE_SAMESITE", "");
    expect(loadConfig().cookieSameSite).toBe("lax");
  });

  it("rejects an unknown COOKIE_SAMESITE", () => {
    vi.stubEnv("COOKIE_SAMESITE", "relaxed");
    expect(() => loadConfig()).toThrow(/COOKIE_SAMESITE must be one of/);
  });

  it("refuses SameSite=None without https, which browsers would drop", () => {
    vi.stubEnv("COOKIE_SAMESITE", "None");
    expect(() => loadConfig({ publicUrl: "http://api.example.in" })).toThrow(/https/);
    expect(loadConfig({ publicUrl: "https://api.example.in" }).cookieSameSite).toBe("none");
  });

  it("rejects an APP_URL that is not an absolute URL", () => {
    vi.stubEnv("APP_URL", "app.example.in");
    expect(() => loadConfig()).toThrow(/APP_URL must be an absolute URL/);
  });
});

describe("logging and API docs config", () => {
  it("rejects an unknown LOG_LEVEL or LOG_FORMAT", () => {
    vi.stubEnv("LOG_LEVEL", "loud");
    expect(() => loadConfig()).toThrow(/LOG_LEVEL must be one of/);
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("LOG_FORMAT", "xml");
    expect(() => loadConfig()).toThrow(/LOG_FORMAT must be one of/);
  });

  it("defaults to JSON logs and no API docs in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_FORMAT", "");
    vi.stubEnv("API_DOCS", "");
    const cfg = loadConfig();
    expect(cfg.logFormat).toBe("json");
    expect(cfg.apiDocs).toBe(false);
  });

  it("lets production turn the API docs on", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_DOCS", "true");
    expect(loadConfig().apiDocs).toBe(true);
  });
});
