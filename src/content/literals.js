const acorn = require('acorn');
// Extract data literals only. Functions, getters, spreads and calls are ignored;
// this deliberately is not a JavaScript rule execution environment.
function value(node, depth = 0) {
  if (!node || depth > 40) return undefined;
  if (node.type === 'Literal' && !node.regex && !node.bigint) return node.value;
  if (node.type === 'ArrayExpression') return node.elements.slice(0, 5000).map(v=>value(v,depth+1));
  if (node.type === 'ObjectExpression') {
    const result=Object.create(null);
    for(const p of node.properties.slice(0,1000))if(p.type==='Property'&&!p.computed&&p.kind==='init'&&!p.method){const key=p.key.name??p.key.value;if(!['__proto__','constructor','prototype'].includes(String(key))){const v=value(p.value,depth+1);if(v!==undefined)result[key]=v;}}
    return result;
  }
  if(node.type==='UnaryExpression'&&node.operator==='-'&&typeof node.argument.value==='number')return -node.argument.value;
  return undefined;
}
function extract(source, marker) {
  const m=marker.exec(source);if(!m)return null;
  const after=m.index+m[0].length, offset=source.slice(after).search(/[\[{]/);if(offset<0)return null;const start=after+offset;
  return value(acorn.parseExpressionAt(source.slice(start,start+256*1024),0,{ecmaVersion:'latest'}));
}
module.exports={extract,value};
