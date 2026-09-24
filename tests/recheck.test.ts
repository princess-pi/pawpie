import { describe, expect, test } from "bun:test";
import { refuseRecheck } from "../src/recheck.ts";

describe("pawpie recheck / punch (Step D, not built yet)", () => {
  test("refuses with no id, exit 2", () => {
    const result = refuseRecheck(null);
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("missing-id");
  });

  test("refuses with an id, exit 2, reason not-built-yet", () => {
    const result = refuseRecheck("0001");
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("not-built-yet");
    expect(result.id).toBe("0001");
  });
});
