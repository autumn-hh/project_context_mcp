# 索引重建与可选检索扩展

## 目标机器重建索引（P3-1）

首版选择路线图允许的“按需重建指引”。知识快照/同步事件不携带 chunks、FTS、ngram、代码关系或向量。Git 仍是源码真相；在目标机取得所需 revision，恢复/登记项目知识后运行：

```powershell
node dist/cli.js project open <absolute-project-root>
node dist/cli.js index <project-id>
node dist/cli.js doctor <project-id>
```

若先恢复 P0 包，使用 project restore <staging/project.db> --root <absolute-project-root> 登记新项目。现有已登记项目按备份文档操作，不能覆盖活跃项目。恢复规则单独预览和导入。

本机已有源码且网络慢、索引显著大于源码、目标机操作系统/解析器版本不同、忽略规则不同或仅有少量文件改变时，本地重建通常更合适。首次大仓库解析可能比传输快照慢；比较实测“索引耗时”和“快照字节数÷可用带宽＋校验耗时”再决定，不能仅凭源码大小断言哪种更快。当前没有跨机二进制索引快照导入，因而不混用不兼容派生表。后续支持快照时必须核对源码 revision、未提交变更、忽略规则、Schema、解析器版本；不匹配则重建。

P3 图谱导出供审阅，不用来替换本地索引。其 indexedRevision 是上次索引捕获的 revision，包含未提交变化的工作区不能只按 commit 判断一致。解析规则按语言记录版本（`src/code-intelligence/languages.ts`）。某种语言的版本变化后，下一次 index 只重新提取该语言未变更文件的符号与关系，正文、全文和 n-gram 索引保持不动。早期版本只在规则变化时刷新 TS/JS，加入 Python/Go/Rust 之前入库且内容未变的文件因此一直没有符号；升级后第一次索引会补齐。

## 多语言结构（P3-3）

Tree-sitter 支持 TS/JS/TSX/JSX，以及 Python、Go、Rust 与 Vue/Svelte 组件。组件只解析 `<script>`（含 `<script setup>`、`lang="ts"`）块，其余内容按原位置留空，符号行号与组件文件一致；`src=` 外链脚本跳过，模板中的事件绑定不产生调用关系。

Java、C、C++、C#、PHP 由 `src/code-intelligence/c-family-analyzer.ts` 按语言配置解析，语法包在首次遇到对应文件时才加载。C/C++ 头文件（`.h`、`.hpp` 等）统一用 C++ 语法；C++ 中带 `类名::` 的类外定义记为方法。C# 基类列表不区分父类与接口，按 .NET 的 `I` 前缀约定判断实现关系；PHP 的 trait 记为接口，`use`、`require`/`include` 的字面路径记为导入，调用统一写成 `this.save`、`User.find` 这样的点号形式以便解析目标。各语言过滤 getter/setter、标准库与集合方法、常见类型构造等调用噪音；hrbust_back_new 的 Java 调用关系因此从约 14.9 万条降到 4.6 万条。

跨文件关系按语法推断，不做编译器级类型分析：Java 导入按包路径对应到源文件（含静态导入、嵌套类型和 `.*` 包导入），同包类型无需导入；字段、参数与局部变量的声明类型用于把 `userMapper.insertSelective()` 连到 `UserMapper` 中的方法，找不到时沿已解析的父类/接口最多向上 4 层查找（如公共 `BaseService` 里的 `queryByKey`）；同一类中的重载视为同一目标，`new Type()` 连到被创建的类。PHP 的 `use` 按命名空间路径后缀、`require`/`include` 按相对路径解析，C/C++ 的 `#include "x.h"` 先找同目录再按唯一路径后缀匹配，`<stdio.h>` 等系统头文件不解析。C# 的 `using` 指向命名空间而非文件，暂不解析；`var` 声明、链式调用的返回类型和第三方库类型无法推断，保持未解析，不连接同名但无关的符号。hrbust_back_new 实测：Java 调用解析到目标 3.3% → 67.0%（跨文件 16 → 24,407 条），导入解析到文件 0 → 45.6%，其余主要是 JDK 与第三方库。

新增语言提取定义、导入和调用，Python 继承、Rust impl/trait 关系进入关系表；已解析的同文件调用能扩展搜索。动态 Python 调用、Go 跨 package/receiver 类型推断、Rust 宏和完整跨模块解析不等同于编译器语义分析；不确定目标保留未解析，不随意连接同名符号。需要精确语义定义时可配置 LSP。

## Embedding 插件（P3-2）

默认关闭；原 project_search、project_context 和 Web 搜索不改变。通过独立的 project_search_enhanced MCP 或 embeddings search 显式使用混合检索。无配置、无向量、缓存过期或提供器失败时返回原本地搜索结果，响应 mode/warning 说明降级。

插件是管理员明确指定的可信 JavaScript 模块，须在 allowedOutputRoots 内；不从仓库配置自动执行插件。插件与服务同进程运行，不是沙箱，local/remote 是管理员对插件行为的声明。不要启用未经审查的模块。模块导出以下接口，使用实际模型实现向量计算：

```typescript
export async function embed(
  texts: string[],
  options: { model: string; signal: AbortSignal },
): Promise<number[][]> {
  // 调用已安装的本地模型，或显式授权的远程服务。
  // 保持输入顺序；每条返回固定维度、有限数值且非零的向量。
  return yourModel.embed(texts, options);
}
```

```powershell
node dist/cli.js embeddings configure <project-id> --module D:/protected/provider.mjs --model model-version --dimensions 384
node dist/cli.js embeddings rebuild <project-id>
node dist/cli.js embeddings search <project-id> "相关含义的查询"
node dist/cli.js embeddings disable <project-id>
```

远程插件额外指定 --remote --allow-remote，明确同意发送 active 项目记忆标题/正文及增强查询；凭据由插件通过环境引用读取，不写配置。不会自动发送源码块、个人规则、候选或任务，但记忆正文自身可能包含代码。不开启增强搜索不会产生提供器请求。

上限：5000 条 active 记忆、每条 64000 字符、每批 32 条、维度最多 4096；每批调用 15 秒超时并发送 AbortSignal，插件应配合取消。插件导入/同步阻塞不受此超时隔离。向量存于项目内可重建缓存，依靠模型/维度/模块路径指纹和内容哈希拒绝旧数据。更换模型权重或插件实现时改变 model 版本并 rebuild，长驻进程需重启以刷新模块缓存。删除/过期记忆的向量不参与召回，旧缓存直到 rebuild 才被清除。

向量按 cosine 排序，与文本结果按 RRF 合并；最多5000条线性扫描，非大规模向量数据库。测试使用可控提供器验证同义召回、开关、缓存失效和错误降级；没有下载模型、调用收费服务或声称真实语义质量已验收。远程费用由调用次数、文本量与提供器价格决定，rebuild 会重新发送全部范围内记忆。

## 本地 LSP 定义桥接（P3-4）

管理员先安装受信任的语言服务，再显式配置绝对可执行文件路径；CLI 配置保存在 storageRoot，不自动执行项目里的配置。每次查询启动一个 stdio 服务，initialize → didOpen → definition → shutdown/exit，结束后关闭子进程。服务启动慢或未提供需要的客户端能力时可能失败，索引搜索仍可用。

```powershell
node dist/cli.js lsp configure <project-id> --command C:/trusted/python.exe --args-json '["-m","pylsp"]' --language python
node dist/cli.js lsp definition <project-id> src/example.py --line 12 --character 8
```

也可调用 project_definition {projectId,path,line,character}。坐标是从 0 开始的 UTF-16 行/列；路径限定已索引的项目内文件，文件变更后应先 index。返回项目内已索引的 file URI 定义位置，过滤外部文件/网络 URI；不执行服务发来的文件修改或其他客户端命令。请求默认 10 秒超时，响应总量最多8MiB、单帧4MiB，源文件最多2MiB。环境仅继承运行系统需要的少量变量，不将对象存储令牌传给子进程。

语言服务是可信本机程序，可能自行扫描工作区、加载插件或配置；桥接的 URI 过滤不构成操作系统沙箱。Windows 需真实可执行文件，不能直接把 .cmd 包装器当作 executable；例如使用 node.exe 和语言服务 JS 入口。测试覆盖真实子进程协议、分帧、超时、无服务、排除路径及缓存过期；尚未对 pylsp/gopls/rust-analyzer 的各版本做兼容认证，也未实现长期驻留会话、编辑器补全或重命名。
