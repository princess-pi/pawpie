import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { lastCheckByAdr, readSidecar } from "../src/sidecar.ts";
import { adrDirOf, makeTempRepo, writeSidecar } from "./support.ts";

describe("sidecar", () => {
  test("normalizes an under-padded numeric ADR id to 4 digits", () => {
    const repo = makeTempRepo();
    writeSidecar(repo, ["4\t2026-01-01\tclear\tnote"]);
    const entries = readSidecar(`${adrDirOf(repo)}/recheck.tsv`);
    expect(entries[0].adrId).toBe("0004");
  });

  test("normalizes an over-padded numeric ADR id to 4 digits", () => {
    const repo = makeTempRepo();
    writeSidecar(repo, ["00004\t2026-01-01\tclear\tnote"]);
    const entries = readSidecar(`${adrDirOf(repo)}/recheck.tsv`);
    expect(entries[0].adrId).toBe("0004");
  });

  test("a UTF-8 BOM on the file does not detach the first line's id", () => {
    const repo = makeTempRepo();
    writeSidecar(repo, ["0001\t2026-01-01\tclear\tnote"]);
    const sidecarPath = `${adrDirOf(repo)}/recheck.tsv`;
    fs.writeFileSync(sidecarPath, "﻿" + fs.readFileSync(sidecarPath, "utf8"));

    const entries = readSidecar(sidecarPath);
    expect(entries[0].adrId).toBe("0001");
  });

  test("CRLF line endings do not leave a trailing \\r on the note or drop a line", () => {
    const repo = makeTempRepo();
    const sidecarPath = `${adrDirOf(repo)}/recheck.tsv`;
    fs.mkdirSync(adrDirOf(repo), { recursive: true });
    fs.writeFileSync(sidecarPath, "0001\t2026-01-01\tclear\tnote one\r\n0002\t2026-01-02\traised\tnote two\r\n");

    const entries = readSidecar(sidecarPath);

    expect(entries).toHaveLength(2);
    expect(entries[0].note).toBe("note one");
    expect(entries[1].note).toBe("note two");
  });

  test("a same-day tie goes to the later line", () => {
    const last = lastCheckByAdr([
      { adrId: "0001", date: "2026-01-01", outcome: "raised", note: "first" },
      { adrId: "0001", date: "2026-01-01", outcome: "clear", note: "second" },
    ]);
    expect(last.get("0001")?.note).toBe("second");
  });
});
