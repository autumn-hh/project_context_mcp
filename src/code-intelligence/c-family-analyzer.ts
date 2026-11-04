import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { sha256 } from "../shared/ids.js";
import { analysisLanguage, type AnalysisLanguage } from "./languages.js";
import type { CodeAnalysis, CodeRelation, CodeSymbol } from "./tree-sitter-analyzer.js";

/**
 * Symbols and relations for Java, C, C++, C# and PHP. Grammars load on first use, so projects
 * without these languages pay nothing. Like the other analyzers this is syntax only: call
 * targets are names, not resolved types, and calls that rarely describe business flow
 * (accessors, standard-library helpers, collection methods) are dropped per language.
 */
type FamilyLanguage = Extract<AnalysisLanguage, "java" | "c" | "cpp" | "csharp" | "php">;
type Node = Parser.SyntaxNode;
type RelationType = CodeRelation["relationType"];

interface CallTarget {
  target: string;
  method: string;
  arguments: number;
}

/** Declared types of the fields, parameters and locals visible at a call, by variable name. */
type TypeScope = ReadonlyMap<string, string>;

interface LanguageSpec {
  grammar: () => unknown;
  /** Declaration node type to symbol kind. */
  symbols: Readonly<Record<string, string>>;
  imports: Readonly<Record<string, (node: Node) => string | null>>;
  calls: Readonly<Record<string, (node: Node, scope: TypeScope) => CallTarget | null>>;
  heritage: (node: Node, kind: string) => Array<[RelationType, string]>;
  noise: (call: CallTarget) => boolean;
  /** Variables a declaration introduces with their declared type, so `name.method()` can name the type. */
  typedNames?: (node: Node) => Array<[string, string]>;
}

const require = createRequire(import.meta.url);
const parser = new Parser();
const DIRECT_PARSE_LIMIT = 32_768;
const PARSE_CHUNK_SIZE = 8_192;
const CONTAINER_KINDS = new Set(["class", "interface", "enum", "struct"]);

// Dot notation lets relation-targets.ts resolve this.save(), Class::method() and obj->call()
// the same way as in TS/JS.
const dotted = (text: string) => text.replace(/\$this(?=->|\?->)/gu, "this").replace(/\?->|->|::/gu, ".");
const stripGenerics = (text: string) => text.replace(/<[\s\S]*$/u, "").trim();
const argumentCount = (node: Node | null) => node?.namedChildren.filter((child) => child.type !== "comment").length ?? 0;
const unquote = (text: string) => text.replace(/^["<']|[">']$/gu, "");
const isAccessor = (call: CallTarget) => (/^(?:get|is)[A-Z]/u.test(call.method) && call.arguments === 0)
  || (/^set[A-Z]/u.test(call.method) && call.arguments === 1);

/** Types named directly in a heritage clause, without generic arguments. */
function listedTypes(node: Node | null | undefined, skip: readonly string[] = []): string[] {
  if (!node) return [];
  const list = node.namedChildren.find((child) => child.type === "type_list") ?? node;
  return list.namedChildren.filter((child) => !skip.includes(child.type)).map((child) => stripGenerics(child.text)).filter(Boolean);
}

function call(target: string, method: string, argumentsNode: Node | null): CallTarget {
  return { target, method, arguments: argumentCount(argumentsNode) };
}

const JAVA_PRIMITIVES = new Set(["integral_type", "floating_point_type", "boolean_type", "void_type"]);

/** A Java declared type as a simple class name: `Map<K, V>` → Map, `com.x.Foo[]` → Foo; none for `var` and primitives. */
function javaDeclaredType(type: Node | null): string | null {
  if (!type || JAVA_PRIMITIVES.has(type.type) || type.text.includes("|")) return null;
  const name = stripGenerics(type.text).replace(/\[\]/gu, "").split(".").at(-1) ?? "";
  return /^[A-Z][\w$]*$/u.test(name) ? name : null;
}

function javaTypedNames(node: Node): Array<[string, string]> {
  const type = javaDeclaredType(node.childForFieldName("type"));
  if (!type) return [];
  if (node.type === "field_declaration" || node.type === "local_variable_declaration") {
    return node.namedChildren.filter((child) => child.type === "variable_declarator")
      .flatMap((declarator) => { const name = declarator.childForFieldName("name")?.text; return name ? [[name, type] as [string, string]] : []; });
  }
  const name = node.childForFieldName("name")?.text;
  return name ? [[name, type]] : [];
}

/** `repo.find()` → `RepoType.find` when repo has a declared type; `this.repo.find()` likewise. */
function javaCall(node: Node, scope: TypeScope): CallTarget | null {
  const plain = memberCall(node, "object");
  const name = node.childForFieldName("name");
  const object = node.childForFieldName("object");
  if (!plain || !name || !object) return plain;
  const variable = object.type === "identifier" ? object.text
    : object.type === "field_access" && object.childForFieldName("object")?.type === "this" ? object.childForFieldName("field")?.text : undefined;
  const type = variable ? scope.get(variable) : undefined;
  return type ? { ...plain, target: `${type}.${name.text}` } : plain;
}

function memberCall(node: Node, objectField: string): CallTarget | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  const object = node.childForFieldName(objectField);
  const receiver = object?.text === "$this" ? "this" : object?.text;
  return call(receiver ? dotted(`${receiver}.${name.text}`) : name.text, name.text, node.childForFieldName("arguments"));
}

function creation(node: Node, type: Node | null | undefined): CallTarget | null {
  if (!type) return null;
  const name = `new ${stripGenerics(type.text)}`;
  return call(name, name, node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "arguments") ?? null);
}

/** The literal path of a PHP include, e.g. "/util.php" in `__DIR__ . '/util.php'`; dynamic paths are skipped. */
function includedPath(node: Node): string | null {
  const literal = node.descendantsOfType("string_content").at(-1);
  return literal ? literal.text : null;
}

function cCall(node: Node): CallTarget | null {
  const callee = node.childForFieldName("function");
  if (!callee) return null;
  const method = callee.childForFieldName("field") ?? callee.childForFieldName("name") ?? callee;
  return call(dotted(callee.text), stripGenerics(method.text), node.childForFieldName("arguments"));
}

const JAVA_NOISE_METHODS = new Set([
  "println", "print", "printf", "printStackTrace", "toString", "equals", "hashCode", "compareTo", "getClass", "valueOf",
  "parseInt", "parseLong", "parseDouble", "intValue", "longValue", "doubleValue", "format", "append", "length", "trim",
  "substring", "split", "replace", "replaceAll", "startsWith", "endsWith", "indexOf", "contains", "toUpperCase",
  "toLowerCase", "isEmpty", "isBlank", "size", "get", "put", "putAll", "add", "addAll", "remove", "clear", "containsKey",
  "keySet", "values", "entrySet", "getKey", "getValue", "iterator", "hasNext", "next", "toArray", "asList", "of",
  "ofNullable", "isPresent", "orElse", "orElseGet", "stream", "map", "filter", "collect", "forEach", "sorted", "sort",
  "close", "flush", "info", "debug", "warn", "error", "trace", "randomUUID", "currentTimeMillis", "nanoTime",
  "isNotEmpty", "isNotBlank", "isNull", "nonNull", "requireNonNull", "getAttribute", "setAttribute", "getParameter",
]);
const JAVA_NOISE_TYPES = /^new (?:(?:Hash|LinkedHash|Tree|Concurrent|Weak|Identity)?(?:Map|Set)|ArrayList|LinkedList|ArrayDeque|StringBuilder|StringBuffer|String|Object|Date|BigDecimal|BigInteger|Integer|Long|Double|Boolean|File|Random|SimpleDateFormat|Thread|JSONObject|JSONArray|\w*Exception|\w*Error)$/u;

const C_NOISE_FUNCTIONS = new Set([
  "printf", "fprintf", "sprintf", "snprintf", "vsnprintf", "puts", "putchar", "malloc", "calloc", "realloc", "free",
  "memset", "memcpy", "memmove", "memcmp", "strlen", "strcpy", "strncpy", "strcmp", "strncmp", "strcat", "strncat",
  "strstr", "strchr", "atoi", "atof", "assert", "exit", "abort",
]);
const CPP_NOISE_METHODS = new Set([
  "push_back", "emplace_back", "pop_back", "size", "begin", "end", "cbegin", "cend", "empty", "clear", "insert", "erase",
  "find", "at", "c_str", "data", "length", "reserve", "resize", "front", "back", "count", "reset", "get", "lock", "unlock",
]);

const CSHARP_NOISE_METHODS = new Set([
  "WriteLine", "Write", "ToString", "Equals", "GetHashCode", "GetType", "Format", "IsNullOrEmpty", "IsNullOrWhiteSpace",
  "Add", "AddRange", "Remove", "Contains", "ContainsKey", "TryGetValue", "Clear", "Where", "Select", "SelectMany",
  "ToList", "ToArray", "ToDictionary", "First", "FirstOrDefault", "Single", "SingleOrDefault", "Last", "LastOrDefault",
  "Any", "All", "Count", "OrderBy", "OrderByDescending", "ThenBy", "GroupBy", "Sum", "Max", "Min", "Average", "Distinct",
  "Concat", "Join", "Split", "Trim", "Substring", "Replace", "StartsWith", "EndsWith", "IndexOf", "ConfigureAwait",
  "Dispose", "LogInformation", "LogDebug", "LogWarning", "LogError", "LogTrace",
]);
const CSHARP_NOISE_TYPES = /^new (?:List|Dictionary|HashSet|Queue|Stack|StringBuilder|object|string|DateTime|TimeSpan|Guid|\w*Exception)$/u;

const PHP_NOISE_FUNCTIONS = new Set([
  "count", "sizeof", "strlen", "sprintf", "printf", "implode", "explode", "in_array", "array_key_exists", "array_merge",
  "array_map", "array_filter", "array_keys", "array_values", "array_push", "array_pop", "array_shift", "array_slice",
  "array_search", "array_unique", "array_column", "is_array", "is_string", "is_null", "is_numeric", "is_int", "trim",
  "str_replace", "substr", "strpos", "strtolower", "strtoupper", "ucfirst", "json_encode", "json_decode", "var_dump",
  "print_r", "intval", "floatval", "strval", "date", "time", "strtotime", "preg_match", "preg_replace", "md5", "compact",
  "define", "defined", "function_exists", "method_exists", "file_exists", "round", "max", "min", "abs",
  "number_format", "htmlspecialchars", "urlencode", "base64_encode",
]);
const PHP_NOISE_METHODS = new Set(["where", "orWhere", "whereIn", "get", "first", "orderBy", "select", "with", "limit", "offset", "pluck", "toArray"]);

const SPECS: Readonly<Record<FamilyLanguage, LanguageSpec>> = {
  java: {
    grammar: () => require("tree-sitter-java"),
    symbols: {
      class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "class",
      annotation_type_declaration: "interface", method_declaration: "method", constructor_declaration: "method",
    },
    imports: {
      import_declaration: (node) => {
        const target = node.namedChildren.find((child) => child.type === "scoped_identifier" || child.type === "identifier");
        return target ? target.text + (node.namedChildren.some((child) => child.type === "asterisk") ? ".*" : "") : null;
      },
    },
    calls: {
      method_invocation: javaCall,
      object_creation_expression: (node) => creation(node, node.childForFieldName("type")),
    },
    typedNames: (node) => ["field_declaration", "local_variable_declaration", "formal_parameter", "catch_formal_parameter",
      "enhanced_for_statement", "resource"].includes(node.type) ? javaTypedNames(node) : [],
    heritage: (node) => [
      ...listedTypes(node.childForFieldName("superclass")).map((type): [RelationType, string] => ["EXTENDS", type]),
      ...listedTypes(node.childForFieldName("interfaces")).map((type): [RelationType, string] => ["IMPLEMENTS", type]),
      ...listedTypes(node.namedChildren.find((child) => child.type === "extends_interfaces")).map((type): [RelationType, string] => ["EXTENDS", type]),
    ],
    noise: (call) => isAccessor(call) || JAVA_NOISE_METHODS.has(call.method) || JAVA_NOISE_TYPES.test(call.method),
  },
  c: {
    grammar: () => require("tree-sitter-c"),
    symbols: { function_definition: "function", struct_specifier: "struct", union_specifier: "struct", enum_specifier: "enum", type_definition: "type" },
    imports: { preproc_include: (node) => { const path = node.childForFieldName("path"); return path ? unquote(path.text) : null; } },
    calls: { call_expression: cCall },
    heritage: () => [],
    noise: (call) => C_NOISE_FUNCTIONS.has(call.method),
  },
  cpp: {
    grammar: () => require("tree-sitter-cpp"),
    symbols: {
      function_definition: "function", class_specifier: "class", struct_specifier: "struct", union_specifier: "struct",
      enum_specifier: "enum", type_definition: "type", alias_declaration: "type",
    },
    imports: { preproc_include: (node) => { const path = node.childForFieldName("path"); return path ? unquote(path.text) : null; } },
    calls: {
      call_expression: cCall,
      new_expression: (node) => creation(node, node.childForFieldName("type")),
    },
    heritage: (node) => listedTypes(node.namedChildren.find((child) => child.type === "base_class_clause"), ["access_specifier"])
      .map((type): [RelationType, string] => ["EXTENDS", type]),
    noise: (call) => C_NOISE_FUNCTIONS.has(call.method) || CPP_NOISE_METHODS.has(call.method) || call.target.startsWith("std."),
  },
  csharp: {
    grammar: () => require("tree-sitter-c-sharp"),
    symbols: {
      class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", record_declaration: "class",
      enum_declaration: "enum", method_declaration: "method", constructor_declaration: "method", delegate_declaration: "type",
    },
    imports: { using_directive: (node) => node.namedChildren.at(-1)?.text ?? null },
    calls: {
      invocation_expression: (node) => {
        const callee = node.childForFieldName("function");
        if (!callee) return null;
        const name = callee.childForFieldName("name") ?? callee;
        return call(callee.text, stripGenerics(name.text), node.childForFieldName("arguments"));
      },
      object_creation_expression: (node) => creation(node, node.childForFieldName("type")),
    },
    // Base lists do not separate the base class from interfaces; .NET names interfaces IName.
    heritage: (node, kind) => listedTypes(node.namedChildren.find((child) => child.type === "base_list"), ["argument_list"])
      .map((type): [RelationType, string] => [kind !== "interface" && /^I[A-Z]/u.test(type.split(".").at(-1) ?? "") ? "IMPLEMENTS" : "EXTENDS", type]),
    noise: (call) => CSHARP_NOISE_METHODS.has(call.method) || CSHARP_NOISE_TYPES.test(call.method),
  },
  php: {
    grammar: () => (require("tree-sitter-php") as { php: unknown }).php,
    symbols: {
      class_declaration: "class", interface_declaration: "interface", trait_declaration: "interface", enum_declaration: "enum",
      method_declaration: "method", function_definition: "function",
    },
    imports: {
      namespace_use_clause: (node) => {
        const name = (node.childForFieldName("alias") ? node.namedChildren[0]?.text : node.text)?.replace(/^\\/u, "");
        // In `use App\Support\{Str, Arr}` the clauses carry only the final names.
        const group = node.parent?.type === "namespace_use_group" ? node.parent.parent?.namedChildren.find((child) => child.type === "namespace_name") : null;
        return name ? (group ? `${group.text}\\${name}` : name) : null;
      },
      require_expression: includedPath,
      require_once_expression: includedPath,
      include_expression: includedPath,
      include_once_expression: includedPath,
    },
    calls: {
      function_call_expression: (node) => {
        const callee = node.childForFieldName("function");
        return callee ? call(callee.text, callee.text, node.childForFieldName("arguments")) : null;
      },
      member_call_expression: (node) => memberCall(node, "object"),
      nullsafe_member_call_expression: (node) => memberCall(node, "object"),
      scoped_call_expression: (node) => memberCall(node, "scope"),
      object_creation_expression: (node) => creation(node, node.namedChildren.find((child) => child.type === "name" || child.type === "qualified_name")),
    },
    heritage: (node) => [
      ...listedTypes(node.namedChildren.find((child) => child.type === "base_clause")).map((type): [RelationType, string] => ["EXTENDS", type]),
      ...listedTypes(node.namedChildren.find((child) => child.type === "class_interface_clause")).map((type): [RelationType, string] => ["IMPLEMENTS", type]),
      // Trait use composes behavior; it is recorded like an implemented interface.
      ...(node.childForFieldName("body")?.namedChildren.filter((child) => child.type === "use_declaration") ?? [])
        .flatMap((use) => listedTypes(use)).map((type): [RelationType, string] => ["IMPLEMENTS", type]),
    ],
    noise: (call) => isAccessor(call) || PHP_NOISE_FUNCTIONS.has(call.method) || PHP_NOISE_METHODS.has(call.method),
  },
};

/** The innermost name inside a C/C++ declarator, e.g. "add" in `*add(int a)` or "S::run". */
function declaratorName(node: Node | null): Node | null {
  for (let current = node; current;) {
    if (["identifier", "field_identifier", "type_identifier", "qualified_identifier", "destructor_name", "operator_name"].includes(current.type)) {
      return current;
    }
    current = current.childForFieldName("declarator") ?? current.namedChildren.find((child) => child.type.endsWith("declarator")) ?? null;
  }
  return null;
}

function symbolName(node: Node): Node | null {
  switch (node.type) {
    case "function_definition":
      return node.childForFieldName("name") ?? declaratorName(node.childForFieldName("declarator"));
    case "type_definition":
      return declaratorName(node.childForFieldName("declarator"));
    case "struct_specifier": case "union_specifier": case "enum_specifier": case "class_specifier":
      // Without a body these only name a type, e.g. `struct point *p`.
      return node.childForFieldName("body") ? node.childForFieldName("name") : null;
    default:
      return node.childForFieldName("name");
  }
}

export function analyzeCFamily(path: string, content: string): CodeAnalysis | null {
  const language = analysisLanguage(path);
  if (!language || !(language in SPECS)) return null;
  const spec = SPECS[language as FamilyLanguage];
  parser.setLanguage(spec.grammar());
  // The current Node binding rejects direct string inputs at 32,768 characters.
  const tree = content.length < DIRECT_PARSE_LIMIT
    ? parser.parse(content)
    : parser.parse((index) => content.slice(index, index + PARSE_CHUNK_SIZE));
  const symbols: CodeSymbol[] = [];
  const relations: CodeRelation[] = [];

  const addRelation = (node: Node, owner: CodeSymbol | null, target: string, type: RelationType) => {
    relations.push({
      id: `rel_${sha256(`${path}:${node.startIndex}:${type}:${target}`).slice(0, 24)}`,
      fromSymbolId: owner?.id ?? null,
      fromName: owner?.qualifiedName ?? `${path}#module`,
      toName: target.slice(0, 500),
      relationType: type,
      startLine: node.startPosition.row + 1,
      evidence: node.text.slice(0, 500),
    });
  };

  const declared = (nodes: Node[]) => nodes.flatMap((item) => spec.typedNames?.(item) ?? []);
  const visit = (node: Node, owner: CodeSymbol | null, containers: string[], containerKind: string | null, types: TypeScope) => {
    let current = owner;
    let nested = containers;
    let nestedKind = containerKind;
    let nestedTypes = types;
    let kind = spec.symbols[node.type];
    const nameNode = kind ? symbolName(node) : null;
    if (kind && nameNode) {
      const parts = nameNode.type === "qualified_identifier" ? nameNode.text.split("::").map(stripGenerics) : [nameNode.text];
      const name = parts.at(-1)!;
      const scope = parts.slice(0, -1);
      // Out-of-class definitions such as `void Query::Init()` usually belong to a class declared in a
      // header, so any qualified C++ function counts as a method; namespaces cannot be told apart.
      if (kind === "function" && language === "cpp"
        && (containerKind === "class" || containerKind === "struct" || scope.length > 0)) kind = "method";
      const qualifiedName = [path, ...containers, ...scope, name].join("#");
      const body = node.childForFieldName("body");
      current = {
        id: `sym_${sha256(`${qualifiedName}:${node.startPosition.row + 1}:${node.startPosition.column}`).slice(0, 24)}`,
        name,
        qualifiedName,
        kind,
        signature: (body ? content.slice(node.startIndex, body.startIndex) : node.text.split("\n", 1)[0]!).trim().slice(0, 1_000) || null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        contentHash: sha256(node.text),
      };
      symbols.push(current);
      if (CONTAINER_KINDS.has(kind)) {
        nested = [...containers, ...scope, name];
        nestedKind = kind;
        // Fields are visible throughout the class body, including in methods declared before them.
        if (spec.typedNames && body) nestedTypes = new Map([...types, ...declared(body.namedChildren)]);
      } else if (spec.typedNames) {
        // Parameters and locals shadow fields; same-named locals in different blocks keep the last type.
        const locals = node.descendantsOfType(["formal_parameter", "local_variable_declaration", "catch_formal_parameter", "enhanced_for_statement", "resource"]);
        nestedTypes = new Map([...types, ...declared(locals)]);
      }
      for (const [type, target] of spec.heritage(node, kind)) addRelation(node, current, target, type);
    }
    const importTarget = spec.imports[node.type]?.(node);
    if (importTarget) addRelation(node, current, importTarget, "IMPORTS");
    const target = spec.calls[node.type]?.(node, nestedTypes);
    if (target && !spec.noise(target)) addRelation(node, current, target.target, "CALLS");
    for (const child of node.namedChildren) visit(child, current, nested, nestedKind, nestedTypes);
  };
  visit(tree.rootNode, null, [], null, new Map());
  return { language: language as FamilyLanguage, symbols, relations };
}
