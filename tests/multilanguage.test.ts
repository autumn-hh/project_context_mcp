import { describe, expect, it } from "vitest";
import { analyzeCode } from "../src/code-intelligence/tree-sitter-analyzer.js";

describe("additional Tree-sitter languages", () => {
  it("extracts Python definitions, calls, imports and inheritance", () => {
    const result=analyzeCode("service.py","from helpers import helper\nclass Service(Base):\n    def run(self):\n        return helper()\n")!;
    expect(result.language).toBe("python"); expect(result.symbols.map(s=>s.name)).toEqual(["Service","run"]);
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"CALLS",toName:"helper"}),expect.objectContaining({relationType:"EXTENDS",toName:"Base"}),expect.objectContaining({relationType:"IMPORTS",toName:"helpers"})]));
    expect(result.symbols[1]!.qualifiedName).toBe("service.py#Service#run");
  });
  it("extracts Go functions and method calls", () => {
    const result=analyzeCode("main.go",'package main\nimport "fmt"\nfunc helper() {}\nfunc run() { helper(); fmt.Println("x") }\n')!;
    expect(result.language).toBe("go"); expect(result.symbols.map(s=>s.name)).toContain("run");
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"CALLS",toName:"helper"}),expect.objectContaining({relationType:"IMPORTS",toName:"fmt"})]));
  });
  it("extracts Rust functions, impl scopes and trait relationships", () => {
    const result=analyzeCode("lib.rs",'use crate::helpers::helper;\nstruct Service;\nimpl Worker for Service { fn run(&self) { helper(); } }\n')!;
    expect(result.language).toBe("rust"); expect(result.symbols.map(s=>s.qualifiedName)).toContain("lib.rs#Service#run");
    expect(result.relations).toEqual(expect.arrayContaining([expect.objectContaining({relationType:"IMPLEMENTS",toName:"Worker"}),expect.objectContaining({relationType:"CALLS",toName:"helper"})]));
  });
  it("retains TS/JS behavior and handles long Unicode input", () => {
    expect(analyzeCode("a.ts","export function run() { return helper(); }")!.language).toBe("typescript");
    const result=analyzeCode("long.py","# 注释\n".repeat(9000)+"def ending():\n    return 1\n")!;
    expect(result.symbols.map(s=>s.name)).toEqual(["ending"]);
  });
});
