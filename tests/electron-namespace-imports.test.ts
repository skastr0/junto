import { describe, expect, it } from "vitest";
import { rewriteElectronNamedImports } from "../scripts/electron-namespace-imports";

describe("electron named imports in main's chunks", () => {
  it("read each name off the namespace, so a utilityProcess without the export still loads", () => {
    const out = rewriteElectronNamedImports(
      'import * as electron from "electron";\nimport { app, utilityProcess as up } from "electron";\nimport { join } from "node:path";',
    );
    expect(out).toBe(
      'import * as electron from "electron";\nimport * as __electron0 from "electron";\nconst { app, utilityProcess: up } = __electron0;\nimport { join } from "node:path";',
    );
  });

  it("leaves code with no named electron import unchanged", () => {
    const code = 'import { join } from "node:path";\nconst electron = "x";';
    expect(rewriteElectronNamedImports(code)).toBe(code);
  });
});
