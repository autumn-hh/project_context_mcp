import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";
import { extname } from "node:path";
import { sha256 } from "../shared/ids.js";
import type { CodeAnalysis, CodeRelation, CodeSymbol } from "./tree-sitter-analyzer.js";

export function analyzeAdditionalLanguage(path: string, content: string): CodeAnalysis | null {
  const extension = extname(path).toLowerCase();
  const language = extension === ".py" ? "python" : extension === ".go" ? "go" : extension === ".rs" ? "rust" : null;
  if (!language) return null;
  const parser = new Parser(); parser.setLanguage(language === "python" ? Python : language === "go" ? Go : Rust);
  const tree = content.length < 32768 ? parser.parse(content) : parser.parse(index => content.slice(index, index + 8192));
  const symbols: CodeSymbol[] = []; const relations: CodeRelation[] = [];
  const symbolKinds: Record<string,string> = { function_definition: "function", class_definition: "class", function_declaration: "function",
    method_declaration: "method", type_spec: "type", function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "interface", mod_item: "module", type_item: "type" };
  const addRelation = (node: Parser.SyntaxNode, owner: CodeSymbol | null, target: string, type: CodeRelation["relationType"]) => {
    relations.push({ id: "rel_" + sha256(`${path}:${node.startIndex}:${type}:${target}`).slice(0,24), fromSymbolId: owner?.id ?? null,
      fromName: owner?.qualifiedName ?? path + "#module", toName: target.slice(0,500), relationType: type, startLine: node.startPosition.row+1, evidence: node.text.slice(0,500) });
  };
  const visit = (node: Parser.SyntaxNode, owner: CodeSymbol | null, containers: string[]) => {
    let current = owner; let nested = containers;
    if (node.type === "impl_item") {
      const target = node.childForFieldName("type"); if (target) nested = [...containers,target.text];
      const trait = node.childForFieldName("trait"); if (trait) addRelation(node,owner,trait.text,"IMPLEMENTS");
    }
    const kind = symbolKinds[node.type]; const name = node.childForFieldName("name");
    if (kind && name) {
      const body = node.childForFieldName("body"); const qualifiedName = [path,...containers,name.text].join("#");
      current = { id: "sym_" + sha256(`${qualifiedName}:${node.startPosition.row+1}:${node.startPosition.column}`).slice(0,24), name:name.text, qualifiedName,kind,
        signature:(body ? content.slice(node.startIndex,body.startIndex) : node.text.split("\n")[0]!).trim().slice(0,1000),
        startLine:node.startPosition.row+1,endLine:node.endPosition.row+1,contentHash:sha256(node.text) };
      symbols.push(current); nested=[...containers,name.text];
      if (node.type === "class_definition") {
        for (const parent of node.childForFieldName("superclasses")?.namedChildren ?? []) addRelation(parent,current,parent.text,"EXTENDS");
      }
    }
    if (["call","call_expression"].includes(node.type)) {
      const callee=node.childForFieldName("function"); if(callee) addRelation(node,current,callee.text,"CALLS");
    }
    if (["import_statement","import_from_statement","import_spec","use_declaration"].includes(node.type)) {
      const target=node.childForFieldName("module_name") ?? node.childForFieldName("path") ?? node.childForFieldName("argument") ?? node.namedChildren[0];
      if(target) addRelation(node,current,target.text.replace(/^["']|["']$/g,""),"IMPORTS");
    }
    for(const child of node.namedChildren) visit(child,current,nested);
  };
  visit(tree.rootNode,null,[]);
  return {language,symbols,relations};
}
