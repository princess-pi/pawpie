import { describe, expect, test } from "bun:test";
import { lastCheckByAdr, readSidecar } from "../src/sidecar.ts";
import { adrDirOf, makeTempRepo, writeSidecar } from "./support.ts";

describe("sidecar", () => {
  test("normalizes a numeric ADR id to 4 digits", () => {
    const repo = makeTempRepo();
    writeSidecar(repo, ["4\t2026-01-01\tclear\tnote"]);
    const entries = readSidecar(`${adrDirOf(repo)}/recheck.tsv`);
    expect(entries[0].adrId).toBe("0004");
  });

  test("a same-day tie goes to the later line", () => {
    const last = lastCheckByAdr([
      { adrId: "0001", date: "2026-01-01", outcome: "raised", note: "first" },
      { adrId: "0001", date: "2026-01-01", outcome: "clear", note: "second" },
    ]);
    expect(last.get("0001")?.note).toBe("second");
  });
});
