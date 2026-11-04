import { describe, expect, it } from "vitest";
import { analyzeCode, type CodeAnalysis } from "../src/code-intelligence/tree-sitter-analyzer.js";

function summary(path: string, source: string) {
  const result = analyzeCode(path, source) as CodeAnalysis;
  const local = (name: string) => name.replace(`${path}#`, "");
  const relations = (type: string) => result.relations.filter((item) => item.relationType === type)
    .map((item) => type === "CALLS" ? `${item.toName} <- ${local(item.fromName)}` : item.toName);
  return {
    language: result.language,
    symbols: result.symbols.map((symbol) => `${symbol.kind} ${local(symbol.qualifiedName)}`),
    extends: relations("EXTENDS"), implements: relations("IMPLEMENTS"), imports: relations("IMPORTS"), calls: relations("CALLS"),
  };
}

describe("Java, C, C++, C# and PHP analysis", () => {
  it("extracts Java declarations, heritage and business calls without accessor and JDK noise", () => {
    expect(summary("src/S.java", `package com.x;
import java.util.List;
import static org.A.b;
public class S extends Base implements Api, Other {
  public S() { super(); }
  public List<String> run(int a) {
    helper(a); this.save(); repo.findAll().stream(); user.getName(); user.setName("x");
    System.out.println(a); map.put(1, 2); return new ArrayList<>();
  }
  record P(int x) {}
  enum E { A }
  interface I extends J {}
}`)).toEqual({
      language: "java",
      symbols: ["class S", "method S#S", "method S#run", "class S#P", "enum S#E", "interface S#I"],
      extends: ["Base", "J"], implements: ["Api", "Other"], imports: ["java.util.List", "org.A.b"],
      calls: ["helper <- S#run", "this.save <- S#run", "repo.findAll <- S#run"],
    });
  });

  it("extracts C functions, named types and includes, skipping libc helpers", () => {
    expect(summary("src/m.c", `#include <stdio.h>
#include "local.h"
struct point { int x; };
typedef struct point point_t;
static int add(int a, int b) { printf("x"); return helper(a) + b; }
int *make(void) { return malloc(4); }
void run(struct point *p) { p->move(1); add(1, 2); }`)).toEqual({
      language: "c",
      symbols: ["struct point", "type point_t", "function add", "function make", "function run"],
      extends: [], implements: [], imports: ["stdio.h", "local.h"],
      calls: ["helper <- add", "p.move <- run", "add <- run"],
    });
  });

  it("qualifies C++ members by namespace and class, including out-of-class definitions", () => {
    expect(summary("src/s.cpp", `#include <vector>
namespace app {
class Service : public Base, private Other {
 public:
  void run() { helper(); obj.call(); ptr->go(); std::sort(v.begin(), v.end()); items.push_back(1); }
};
void Service::stop() { run(); }
void Query::Init() {}
template <typename T> T id(T v) { return v; }
}`)).toEqual({
      language: "cpp",
      symbols: ["class Service", "method Service#run", "method Service#stop", "method Query#Init", "function id"],
      extends: ["Base", "Other"], implements: [], imports: ["vector"],
      calls: ["helper <- Service#run", "obj.call <- Service#run", "ptr.go <- Service#run", "run <- Service#stop"],
    });
  });

  it("separates C# base classes from I-prefixed interfaces and drops LINQ noise", () => {
    expect(summary("src/S.cs", `using System.Linq;
namespace App.Core {
  public class S : Base, IApi {
    public S() {}
    public void Run() { Helper(); this.Save(); repo.Find().Where(x => x.Ok); var o = new Thing(); var l = new List<int>(); Console.WriteLine(1); }
  }
  interface IApi : IBase { void Run(); }
  record R(int X);
}`)).toEqual({
      language: "csharp",
      symbols: ["class S", "method S#S", "method S#Run", "interface IApi", "method IApi#Run", "class R"],
      extends: ["Base", "IBase"], implements: ["IApi"], imports: ["System.Linq"],
      calls: ["Helper <- S#Run", "this.Save <- S#Run", "repo.Find <- S#Run", "new Thing <- S#Run"],
    });
  });

  it("normalizes PHP calls to dot notation and records use clauses and includes", () => {
    expect(summary("src/C.php", `<?php
namespace App\\Http;
use App\\Models\\User;
use App\\Support\\{Str, Arr as A};
require_once __DIR__ . '/bootstrap.php';
include $dynamicPath;
class C extends Base implements I { use T;
  public function run(int $a) { helper($a); $this->save(); User::find(1); $repo->all(); new Thing(); count($a); $u->getName(); }
}
trait T { function t() {} }
function top() { return 1; }`)).toEqual({
      language: "php",
      symbols: ["class C", "method C#run", "interface T", "method T#t", "function top"],
      extends: ["Base"], implements: ["I", "T"],
      imports: ["App\\Models\\User", "App\\Support\\Str", "App\\Support\\Arr", "/bootstrap.php"],
      calls: ["helper <- C#run", "this.save <- C#run", "User.find <- C#run", "$repo.all <- C#run", "new Thing <- C#run"],
    });
  });

  it("parses C and C++ headers with the C++ grammar", () => {
    expect(summary("include/api.h", "struct Point { int x; };\nint area(struct Point *p);\n")).toMatchObject({
      language: "cpp", symbols: ["struct Point"],
    });
  });
});
