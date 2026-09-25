import { describe, expect, test } from "bun:test";
import { sanitizeForTerminal } from "../src/terminal.ts";

describe("sanitizeForTerminal", () => {
  test("strips C0 controls and DEL", () => {
    expect(sanitizeForTerminal("a\x00b\x1bc\x7fd")).toBe("abcd");
  });

  test("strips C1 controls (U+0080-U+009F), which can carry an 8-bit OSC 52 sequence", () => {
    expect(sanitizeForTerminal("a\u009d]52;c;X\u0007b")).toBe("a]52;c;Xb");
    expect(sanitizeForTerminal("x\u0080\u009cy")).toBe("xy");
  });

  test("leaves ordinary text untouched", () => {
    expect(sanitizeForTerminal("hello world")).toBe("hello world");
  });
});
