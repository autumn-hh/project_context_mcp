import {pathToFileURL} from "node:url";
let buffer=Buffer.alloc(0),uri;
const separator=String.fromCharCode(13,10,13,10);
function reply(id,result){const json=JSON.stringify({jsonrpc:"2.0",id,result});const frame=Buffer.from("Content-Length: "+Buffer.byteLength(json)+separator+json);process.stdout.write(frame.subarray(0,9));process.stdout.write(frame.subarray(9));}
process.stdin.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf(separator);if(end<0)return;const size=Number(/Content-Length: ([0-9]+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+size)return;const message=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);
  if(message.method==="initialize")reply(message.id,{capabilities:{definitionProvider:true}});
  if(message.method==="textDocument/didOpen")uri=message.params.textDocument.uri;
  if(message.method==="textDocument/definition"){const range={start:{line:0,character:0},end:{line:0,character:10}};reply(message.id,[{uri,range},{uri:pathToFileURL(process.execPath).href,range},{uri:"https://example.invalid/source",range}]);}
  if(message.method==="shutdown")reply(message.id,null);if(message.method==="exit")process.exit(0);
}});
