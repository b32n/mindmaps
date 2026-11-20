import { expect, test } from "@playwright/test";
import { DEFAULT_MODE, InvalidModeError, MODES, isMode, modeProblem, readMode } from "../../worker/src/mode";

// The helper on its own: every input it can be given, without a Worker.

test.describe("readMode", () => {
  test("the three modes, exactly as written", () => {
    for (const m of MODES) expect(readMode({ MINDMAPS_MODE: m })).toBe(m);
    expect([...MODES]).toEqual(["personal", "org", "multitenant"]);
  });

  test("unset, undefined, empty and blank are multitenant", () => {
    expect(DEFAULT_MODE).toBe("multitenant");
    expect(readMode({})).toBe("multitenant");
    expect(readMode({ MINDMAPS_MODE: undefined })).toBe("multitenant");
    expect(readMode({ MINDMAPS_MODE: "" })).toBe("multitenant");
    expect(readMode({ MINDMAPS_MODE: "   " })).toBe("multitenant");
  });

  test("surrounding whitespace is ignored", () => {
    expect(readMode({ MINDMAPS_MODE: " org\n" })).toBe("org");
  });

  test("anything else throws, naming the value and the choices", () => {
    for (const bad of ["personnal", "Personal", "ORG", "team", "multi-tenant", "true", "0", "personal,org"]) {
      expect(() => readMode({ MINDMAPS_MODE: bad }), bad).toThrow(InvalidModeError);
      expect(() => readMode({ MINDMAPS_MODE: bad }), bad).toThrow(new RegExp(`"${bad}".*personal, org, multitenant`));
    }
  });

  test("isMode", () => {
    expect(isMode("org")).toBe(true);
    expect(isMode("Org")).toBe(false);
    expect(isMode(undefined)).toBe(false);
    expect(isMode(1)).toBe(false);
  });

  test("modeProblem is null for good values and the message for bad ones", () => {
    expect(modeProblem({})).toBeNull();
    expect(modeProblem({ MINDMAPS_MODE: "personal" })).toBeNull();
    expect(modeProblem({ MINDMAPS_MODE: "x" })).toMatch(/MINDMAPS_MODE is "x"/);
  });
});
