import { describe, expect, it } from "vitest";
import { validateWorkspace } from "../src/validate.js";
import { errorsOf, rules, workspace } from "./helpers.js";

describe("validate", () => {
  it("passes a valid repo", () => {
    const res = validateWorkspace(workspace("valid"));
    expect(res.diagnostics).toEqual([]);
    expect(res.stats).toEqual({ packages: 4, valid: 4, external: 0 });
  });

  it("requires a component.yaml beside every package.json", () => {
    const res = validateWorkspace(workspace("missing-manifest"));
    expect(rules(res.diagnostics)).toEqual(["manifest-missing"]);
    expect(res.diagnostics[0]).toMatchObject({ file: "platform/core/component.yaml", component: "@bsh/core" });
  });

  it("reports schema violations with manifest line numbers, and YAML syntax errors", () => {
    const res = validateWorkspace(workspace("schema-error"));
    expect(rules(res.diagnostics)).toEqual(["manifest-schema", "manifest-yaml-invalid"]);
    const schema = errorsOf(res.diagnostics, "manifest-schema");
    const msgs = schema.map((d) => d.message).join("\n");
    expect(msgs).toContain("must have required property 'summary'");
    expect(msgs).toContain('/kind: must be one of "library"');
    expect(msgs).toContain('/owner: must match pattern');
    expect(msgs).toContain('unknown property "colour"');
    expect(schema.find((d) => d.message.startsWith("/kind"))?.line).toBe(3);
    expect(schema.find((d) => d.message.includes("colour"))?.line).toBe(7);
    expect(errorsOf(res.diagnostics, "manifest-yaml-invalid")[0]?.file).toBe("platform/broken/component.yaml");
  });

  it("cross-checks manifests against package.json and the filesystem", () => {
    const res = validateWorkspace(workspace("manifest-mismatch"));
    expect(rules(res.diagnostics)).toEqual([
      "command-script-missing",
      "contract-missing",
      "depends-on-not-in-package-json",
      "depends-on-unknown",
      "name-duplicate",
      "package-json-dep-undeclared",
      "package-name-mismatch",
      "path-missing",
      "product-path-mismatch",
    ]);
    const msg = (rule: string) => errorsOf(res.diagnostics, rule).map((d) => d.message);
    expect(msg("depends-on-not-in-package-json")).toEqual([expect.stringContaining('"@bsh/extra"')]);
    expect(msg("depends-on-unknown")).toEqual([expect.stringContaining('"@bsh/ghost"')]);
    expect(msg("package-json-dep-undeclared")).toEqual([expect.stringContaining('"@bsh/core"')]);
    expect(msg("contract-missing")).toHaveLength(2);
    expect(msg("path-missing")).toHaveLength(3);
    expect(msg("package-name-mismatch")).toEqual([expect.stringContaining("@bsh/degent-website")]);
    expect(msg("product-path-mismatch")).toEqual([expect.stringContaining('expected "degent"')]);
    expect(msg("command-script-missing")).toEqual([expect.stringContaining("commands.dev")]);
    expect(errorsOf(res.diagnostics, "name-duplicate").map((d) => d.file)).toEqual([
      "platform/core/component.yaml",
      "products/degent/packages/dup/component.yaml",
    ]);
  });

  it("orders diagnostics deterministically", () => {
    const a = validateWorkspace(workspace("manifest-mismatch")).diagnostics;
    const b = validateWorkspace(workspace("manifest-mismatch")).diagnostics;
    expect(a).toEqual(b);
    const keys = a.map((d) => `${d.file}:${String(d.line ?? 0).padStart(5, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });
});
